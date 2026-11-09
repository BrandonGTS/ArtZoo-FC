import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import * as domain from '../../../../packages/domain/src/index.ts';

const require = createRequire(import.meta.url);

// Execute production TS/TSX. Only React scheduling, visual components, and the
// request boundary are replaced: no network, credentials, real timers, or DB.
function loadSource(relativePath, resolve) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', outputText)(
    resolve,
    loaded,
    loaded.exports,
    () => 1,
    () => {}
  );
  return loaded.exports;
}

// Explicit render/commit cycles make request interleavings deterministic. State
// persists by hook position; changed effect dependencies run the prior cleanup.
function hookRuntime() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  let mounted = true;
  let writesAfterUnmount = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = (next) => {
          if (!mounted) {
            writesAfterUnmount++;
            return;
          }
          slot.value = typeof next === 'function' ? next(slot.value) : next;
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const old = slots[index];
        slots[index] = { deps, cleanup: old?.cleanup };
        pendingEffects.push(() => {
          old?.cleanup?.();
          slots[index].cleanup = effect();
        });
      }
    }
  };
  return {
    react,
    render(run) {
      assert.equal(mounted, true);
      cursor = 0;
      const value = run();
      const effects = pendingEffects;
      pendingEffects = [];
      effects.forEach((effect) => effect());
      return value;
    },
    unmount() {
      slots.forEach((slot) => slot.cleanup?.());
      mounted = false;
    },
    get writesAfterUnmount() {
      return writesAfterUnmount;
    }
  };
}
function deferredApi() {
  const requests = [];
  return {
    requests,
    accountRequest(path, options = {}) {
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      requests.push({ path, options, resolve, reject });
      // Deliberately do not reject on AbortSignal: stale completions must be
      // ignored by production code even if the underlying transport completes.
      return promise;
    },
    errorDetail(error) {
      return { code: error.code ?? 'NETWORK_ERROR', message: error.message, fieldErrors: error.fieldErrors };
    }
  };
}
function setupHook(name, args) {
  const runtime = hookRuntime();
  const api = deferredApi();
  const source = name === 'useAdminPage' ? './use-admin-page.ts' : './use-admin-list.ts';
  const hookModule = loadSource(source, (dependency) => {
    if (dependency === 'react') return runtime.react;
    if (dependency === '../account/api') return api;
    if (dependency === '../shared/use-api-resource')
      return loadSource('../shared/use-api-resource.ts', (nested) => {
        if (nested === 'react') return runtime.react;
        if (nested === '../account/api') return api;
        throw new Error('Unexpected shared hook dependency: ' + nested);
      });
    throw new Error('Unexpected hook dependency: ' + dependency);
  });
  let currentArgs = args;
  return {
    ...api,
    runtime,
    render(nextArgs = currentArgs) {
      currentArgs = nextArgs;
      return runtime.render(() => hookModule[name](...currentArgs));
    }
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const page = (items, current = 1, total = 25, pageSize = 10) => ({ items, page: current, pageSize, total });

test('numbered audit pages send scope/page/pageSize, replace rows, and use server-corrected page', async (t) => {
  const h = setupHook('useAdminPage', ['/api/admin/audit?scope=membership']);
  t.after(() => h.runtime.unmount());
  assert.equal(h.render().loading, true);
  assert.equal(h.requests[0].path, '/api/admin/audit?scope=membership&page=1&pageSize=10');
  h.requests[0].resolve(page([{ id: 'first' }]));
  await flush();
  let view = h.render();
  assert.deepEqual(view.items, [{ id: 'first' }]);
  view.changePage(2);
  view = h.render();
  assert.deepEqual(view.items, []);
  assert.equal(view.total, 25);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.requests[1].path, '/api/admin/audit?scope=membership&page=2&pageSize=10');
  h.requests[1].resolve(page([{ id: 'second' }], 2));
  await flush();
  view = h.render();
  assert.deepEqual(view.items, [{ id: 'second' }]); // Never first + second.
  view.changePage(99);
  h.render();
  h.requests[2].resolve(page([{ id: 'last' }], 3));
  await flush();
  view = h.render();
  assert.equal(view.page, 3);
  assert.deepEqual(view.items, [{ id: 'last' }]);
  view.reload();
  assert.deepEqual(h.render().items, []);
  assert.equal(h.requests[3].path, '/api/admin/audit?scope=membership&page=1&pageSize=10');
});

test('rapid page changes and unmount abort obsolete requests and ignore late success/error', async () => {
  const h = setupHook('useAdminPage', ['/synthetic-audit', 20]);
  let view = h.render();
  assert.equal(h.requests[0].path, '/synthetic-audit?page=1&pageSize=20');
  view.changePage(2);
  view = h.render();
  view.changePage(1);
  view = h.render();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.requests[1].options.signal.aborted, true);
  h.requests[2].resolve(page([{ id: 'newest-first-page' }], 1, 60, 20));
  await flush();
  h.requests[0].resolve(page([{ id: 'obsolete-first-page' }], 1, 60, 20));
  h.requests[1].reject(new Error('obsolete error'));
  await flush();
  view = h.render();
  assert.deepEqual(view.items, [{ id: 'newest-first-page' }]);
  assert.equal(view.error, null);
  view.changePage(3);
  h.render();
  h.runtime.unmount();
  assert.equal(h.requests[3].options.signal.aborted, true);
  h.requests[3].resolve(page([{ id: 'after-unmount' }], 3, 60, 20));
  await flush();
  assert.equal(h.runtime.writesAfterUnmount, 0);
});

test('audit errors clear records and totals, and reload recovers using a fresh first-page request', async (t) => {
  const h = setupHook('useAdminPage', ['/api/admin/audit?scope=membership']);
  t.after(() => h.runtime.unmount());
  h.render();
  h.requests[0].resolve(page([{ id: 'sensitive-record' }]));
  await flush();
  h.render().changePage(2);
  h.render();
  h.requests[1].reject(Object.assign(new Error('permission lost'), { code: 'FORBIDDEN' }));
  await flush();
  let view = h.render();
  assert.deepEqual(view.items, []);
  assert.equal(view.total, 0);
  assert.equal(view.loading, false);
  assert.equal(view.error, 'permission lost');
  view.reload();
  view = h.render();
  assert.equal(view.error, null);
  assert.equal(view.page, 1);
  h.requests[2].resolve(page([{ id: 'recovered' }], 1, 1));
  await flush();
  assert.deepEqual(h.render().items, [{ id: 'recovered' }]);
  h.render().changePage(2);
  h.render();
  h.requests[3].reject(new Error('offline'));
  await flush();
  view = h.render();
  assert.deepEqual(view.items, []);
  assert.equal(view.total, 0);
  assert.equal(view.error, 'offline');
});

test('disabled account search performs no request and clearing cancels an in-flight result', async (t) => {
  const empty = '/api/admin/accounts?limit=20&query=';
  const h = setupHook('useAdminList', [empty, false]);
  t.after(() => h.runtime.unmount());
  let view = h.render();
  assert.deepEqual(view.items, []);
  assert.equal(view.loading, false);
  view.reload();
  view = h.render();
  await view.more();
  assert.equal(h.requests.length, 0);
  view = h.render(['/api/admin/accounts?limit=20&query=synthetic-nickname', true]);
  assert.equal(view.loading, true);
  assert.equal(h.requests.length, 1);
  view = h.render([empty, false]);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.deepEqual(view.items, []);
  assert.equal(view.loading, false);
  h.requests[0].resolve({ items: [{ id: 'late-account' }], nextCursor: 'late-cursor' });
  await flush();
  view = h.render();
  assert.deepEqual(view.items, []);
  assert.equal(view.nextCursor, null);
  assert.equal(view.error, null);
  assert.equal(h.requests.length, 1);
});

test('changed nickname query drops old rows, ignores old response, and clears rows on request errors', async (t) => {
  const h = setupHook('useAdminList', ['/api/admin/accounts?limit=20&query=first', true]);
  t.after(() => h.runtime.unmount());
  h.render();
  h.render(['/api/admin/accounts?limit=20&query=second', true]);
  h.requests[1].resolve({ items: [{ id: 'second-match' }], nextCursor: null });
  await flush();
  h.requests[0].resolve({ items: [{ id: 'first-match' }], nextCursor: 'old' });
  await flush();
  assert.deepEqual(h.render().items, [{ id: 'second-match' }]);
  h.render().reload();
  assert.deepEqual(h.render().items, []);
  h.requests[2].reject(new Error('search unavailable'));
  await flush();
  const view = h.render();
  assert.deepEqual(view.items, []);
  assert.equal(view.nextCursor, null);
  assert.equal(view.loading, false);
  assert.equal(view.error, 'search unavailable');
});

test('existing cursor lists stay enabled by default, avoid duplicate more calls, and purge permission errors', async (t) => {
  const h = setupHook('useAdminList', ['/api/admin/invitations?limit=20']);
  t.after(() => h.runtime.unmount());
  h.render();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ items: [{ id: 'invite-one' }], nextCursor: 'cursor/+' });
  await flush();
  let view = h.render();
  const firstMore = view.more();
  await view.more();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].path, '/api/admin/invitations?limit=20&cursor=cursor%2F%2B');
  h.requests[1].resolve({ items: [{ id: 'invite-two' }], nextCursor: 'next' });
  await firstMore;
  view = h.render();
  assert.deepEqual(view.items, [{ id: 'invite-one' }, { id: 'invite-two' }]);
  const deniedMore = view.more();
  h.requests[2].reject(Object.assign(new Error('sign in again'), { code: 'UNAUTHENTICATED' }));
  await deniedMore;
  view = h.render();
  assert.deepEqual(view.items, []);
  assert.equal(view.nextCursor, null);
  assert.equal(view.error, 'sign in again');
});

function findElement(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  const children = Array.isArray(tree) ? tree : tree.props?.children;
  for (const child of [children].flat(Infinity)) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
}
function setupVerification(mode) {
  const runtime = hookRuntime();
  const api = deferredApi();
  const domain = loadSource('../../../../packages/domain/src/account-contract.ts', (name) => {
    if (name === './ff14-game-servers.js')
      return loadSource('../../../../packages/domain/src/ff14-game-servers.ts', require);
    throw new Error('Unexpected domain dependency: ' + name);
  });
  const region = domain.GAME_SERVER_REGIONS[0];
  const fieldErrors = [];
  const values = {
    phone: '13800000000',
    code: '123456',
    password: 'test-pass',
    confirmPassword: 'test-pass',
    ...(mode === 'register'
      ? { displayName: '  合成玩家😀  ', gameLocation: [region.region, region.servers[0]] }
      : {})
  };
  const form = {
    setFields(fields) {
      fieldErrors.push(...fields);
    },
    resetFields(fields) {
      fields.forEach((name) => {
        delete values[name];
      });
    },
    setFieldsValue(next) {
      Object.assign(values, next);
    },
    getFieldValue(name) {
      return values[name];
    }
  };
  const Form = Object.assign(() => null, { Item: () => null, useForm: () => [form] });
  const Input = Object.assign(() => null, { Password: () => null });
  const phone = loadSource('../account/phone-input.ts', (name) => {
    if (name === '@artzoo/domain') return domain;
    throw new Error('Unexpected phone dependency: ' + name);
  });
  const accountUi = loadSource('../account/account-ui.tsx', (name) =>
    name === 'react/jsx-runtime' ? require(name) : {}
  );
  const Cascader = () => null;
  const VerificationForm = loadSource('../account/verification-form.tsx', (name) => {
    if (name === 'react') return runtime.react;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'antd') return { Form, Input, Cascader, Button: () => null, Tag: () => null };
    if (name === '@artzoo/domain') return domain;
    if (name === './api') return api;
    if (name === './phone-input') return phone;
    if (name === './account-ui')
      return {
        applyFieldErrors: accountUi.applyFieldErrors,
        ErrorNotice: () => null,
        membershipLabels: { MEMBER: '正式成员' },
        passwordIcon() {}
      };
    if (name === './use-resource')
      return {
        useResource: () => ({ loading: false, error: null, data: { sms: { available: true, mode: 'mock' } } })
      };
    if (name.endsWith('.css')) return {};
    throw new Error('Unexpected form dependency: ' + name);
  }).default;
  const completed = [];
  return {
    ...api,
    runtime,
    values,
    completed,
    domain,
    fieldErrors,
    render() {
      const tree = runtime.render(() =>
        VerificationForm({
          mode,
          ...(mode === 'register'
            ? {
                invitation: { token: 'synthetic-test-invite', membership: 'MEMBER', expiresAt: '2099-01-01' }
              }
            : {}),
          onLogin() {},
          onComplete(phone) {
            completed.push(phone);
          },
          onBusy() {}
        })
      );
      return {
        form: findElement(tree, (element) => element.type === Form),
        nickname: findElement(
          tree,
          (element) => element.type === Form.Item && element.props.name === 'displayName'
        ),
        gameLocation: findElement(
          tree,
          (element) => element.type === Form.Item && element.props.name === 'gameLocation'
        ),
        cascader: findElement(tree, (element) => element.type === Cascader)
      };
    }
  };
}

test('registration field runs shared Unicode validation and submits normalized nickname without erasing user input', async (t) => {
  const h = setupVerification('register');
  t.after(() => h.runtime.unmount());
  const view = h.render();
  assert.equal(view.nickname.props.label, '游戏昵称');
  const rule = view.nickname.props.rules[0];
  assert.equal(rule.required, true);
  await rule.validator({}, '😀'.repeat(30));
  for (const value of [undefined, '', '   ', '😀'.repeat(31), 'abc\u0000', 'abc\u200b', 'a\u2028b']) {
    await assert.rejects(rule.validator({}, value), /游戏昵称/);
  }
  const original = h.values.displayName;
  const submitting = view.form.props.onFinish({ ...h.values });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, '/api/auth/register');
  assert.equal(h.requests[0].options.method, 'POST');
  assert.equal(h.requests[0].options.body.displayName, '合成玩家😀');
  assert.equal(h.requests[0].options.body.invitationToken, 'synthetic-test-invite');
  h.requests[0].reject(new Error('synthetic submission failure'));
  await submitting;
  assert.equal(h.values.displayName, original);
  assert.equal(h.values.password, '');
  assert.equal(h.values.code, '');
  assert.deepEqual(h.completed, []);
  const retrying = h.render().form.props.onFinish({
    ...h.values,
    code: '654321',
    password: 'test-pass',
    confirmPassword: 'test-pass'
  });
  h.requests[1].resolve({});
  await retrying;
  assert.equal(h.values.displayName, original);
  assert.deepEqual(h.completed, ['13800000000']);
});

test('password reset has no nickname field or requirement and submits without a nickname', async (t) => {
  const h = setupVerification('reset');
  t.after(() => h.runtime.unmount());
  const view = h.render();
  assert.equal(view.nickname, undefined);
  assert.equal(view.gameLocation, undefined);
  assert.equal(view.cascader, undefined);
  const submitting = view.form.props.onFinish({ ...h.values });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, '/api/auth/reset-password');
  assert.equal(Object.hasOwn(h.requests[0].options.body, 'displayName'), false);
  for (const field of ['invitationToken', 'gameLocation', 'gameRegion', 'gameServer'])
    assert.equal(Object.hasOwn(h.requests[0].options.body, field), false);
  h.requests[0].resolve({});
  await submitting;
  assert.deepEqual(h.completed, ['13800000000']);
});

test('registration requires one complete valid region/server path and uses the shared dictionary', async (t) => {
  const h = setupVerification('register');
  t.after(() => h.runtime.unmount());
  const view = h.render();
  const rule = view.gameLocation.props.rules[0];
  assert.equal(rule.required, true);
  assert.equal(view.gameLocation.props.label, '大区 / 服务器');
  const options = view.cascader.props.options;
  assert.deepEqual(
    options.map((option) => ({
      region: option.value,
      servers: option.children.map((server) => server.value)
    })),
    h.domain.GAME_SERVER_REGIONS
  );
  for (const region of h.domain.GAME_SERVER_REGIONS) {
    for (const server of region.servers) await rule.validator({}, [region.region, server]);
  }
  const [first, second] = h.domain.GAME_SERVER_REGIONS;
  for (const value of [
    undefined,
    null,
    [],
    [first.region],
    [first.region, first.servers[0], 'extra'],
    'not-an-array',
    [first.region, second.servers[0]],
    ['unknown-region', first.servers[0]],
    [first.region, 'unknown-server']
  ]) {
    await assert.rejects(rule.validator({}, value));
  }
  const path = [options[0], options[0].children[0]];
  const label = path.map((option) => option.label).join(' / ');
  assert.equal(view.cascader.props.displayRender(path.map((option) => option.label)), label);
  assert.equal(view.cascader.props.showSearch.render('', path), label);
  assert.equal(view.cascader.props.showSearch.filter(path[0].label, path), true);
  assert.equal(view.cascader.props.showSearch.filter(path[1].label, path), true);
  assert.equal(view.cascader.props.showSearch.filter('nonexistent-synthetic-server', path), false);
});

test('registration sends only region/server strings and keeps selection on server field errors', async (t) => {
  const h = setupVerification('register');
  t.after(() => h.runtime.unmount());
  const selected = [...h.values.gameLocation];
  for (const [field, message] of [
    ['gameLocation', '请选择有效的大区和服务器'],
    ['displayName', '该服务器已有相同游戏昵称']
  ]) {
    const sending = h.render().form.props.onFinish({ ...h.values });
    const request = h.requests.at(-1);
    assert.equal(request.options.body.gameRegion, selected[0]);
    assert.equal(request.options.body.gameServer, selected[1]);
    assert.equal(Object.hasOwn(request.options.body, 'gameLocation'), false);
    request.reject(
      Object.assign(new Error(message), { code: 'INVALID_INPUT', fieldErrors: { [field]: message } })
    );
    await sending;
    assert.deepEqual(h.values.gameLocation, selected);
    assert.deepEqual(h.fieldErrors.at(-1), { name: field, errors: [message] });
  }
});

test('reset payload excludes registration-only fields even if stale values are supplied', async (t) => {
  const h = setupVerification('reset');
  t.after(() => h.runtime.unmount());
  const sending = h.render().form.props.onFinish({
    ...h.values,
    displayName: 'stale',
    gameLocation: ['stale', 'stale'],
    gameRegion: 'stale',
    gameServer: 'stale'
  });
  const request = h.requests[0];
  assert.deepEqual(Object.keys(request.options.body).sort(), [
    'code',
    'confirmPassword',
    'password',
    'phone'
  ]);
  request.resolve({});
  await sending;
});

test('account results and identity dialog distinguish servers and tolerate old accounts', () => {
  const runtime = hookRuntime();
  const Table = () => null;
  const Modal = () => null;
  const Form = Object.assign(() => null, { Item: () => null, useForm: () => [{}] });
  const Input = Object.assign(() => null, { Search: () => null, TextArea: () => null });
  const list = { items: [], loading: false, error: null, reload() {} };
  const Manager = loadSource('./account-manager.tsx', (name) => {
    if (name === 'react') return runtime.react;
    if (name === '@artzoo/domain') return domain;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'antd') return { Table, Modal, Form, Input, Button: () => null, Select: () => null };
    if (name === '../account/api') return {};
    if (name === '../activities/activity-ui') return { ActivityPaper: () => null };
    if (name === '../use-feedback-message')
      return { useFeedbackMessage: () => ({ notify() {}, contextHolder: null }) };
    if (name === '../collection-controls')
      return { CollectionSearch: () => null, ListPagination: () => null };
    if (name === '../admin-management/management-audits') return { ManagementTable: () => null };
    if (name === '../account/account-ui')
      return {
        ErrorNotice: () => null,
        membershipLabels: { MEMBER: '正式成员', FRIEND: '朋友' },
        membershipOptions: []
      };
    if (name === '../auth-session')
      return {
        useAuthSession: () => ({
          session: { user: { id: 'synthetic-admin', membership: 'MEMBER', adminRole: 'ADMIN' } },
          refresh() {}
        })
      };
    if (name === './use-admin-list') return { useAdminList: () => list, beijingTime: (value) => value };
    if (name === './use-admin-page') return { useAdminPage: () => list };
    if (name.endsWith('.css')) return {};
    throw new Error('Unexpected manager dependency: ' + name);
  }).default;
  const render = () => runtime.render(() => Manager());
  let tree = render();
  const table = findElement(tree, (element) => element.type === Table);
  const serverColumn = table.props.columns.find((column) => column.key === 'gameLocation');
  const actionColumn = table.props.columns.find((column) => column.key === 'action');
  const oldAccount = {
    id: 'legacy',
    displayName: '同名玩家',
    phoneMasked: '138****0000',
    gameRegion: null,
    gameServer: null,
    membership: 'MEMBER',
    adminRole: 'NONE'
  };
  const first = { ...oldAccount, id: 'first', gameRegion: '测试区甲', gameServer: '测试服甲' };
  const second = { ...oldAccount, id: 'second', gameRegion: '测试区乙', gameServer: '测试服乙' };
  assert.equal(serverColumn.render(null, oldAccount), '未填写服务器');
  assert.equal(serverColumn.render(null, first), '测试区甲 / 测试服甲');
  assert.equal(serverColumn.render(null, second), '测试区乙 / 测试服乙');
  actionColumn.render(null, second).props.onClick();
  tree = render();
  const dialog = findElement(tree, (element) => element.props?.account === second);
  const dialogRuntime = hookRuntime();
  const modal = dialogRuntime.render(() => dialog.type(dialog.props));
  assert.equal(modal.type, Modal);
  assert.equal(modal.props.mask.closable, false);
  const description = findElement(modal, (element) => element.type === 'p');
  assert.ok(description.props.children.includes('测试区乙 / 测试服乙'));
  runtime.unmount();
  dialogRuntime.unmount();
});

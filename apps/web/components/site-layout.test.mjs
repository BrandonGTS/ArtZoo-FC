import {
  previousFile,
  structuralSource,
  root as finalRoot
} from '../../../tests/rev1106-fe01-final-shell/compat.mjs';
// Source/SSR contracts only. No browser geometry or visual verification is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import {
  cssRules,
  cssDeclarations,
  declarations,
  valueTokens,
  jsxNodes,
  returnedWrappingJsx,
  jsxAttribute,
  astNodes,
  hasCall,
  literalStrings
} from '../../../tests/rev1105-format-css/syntax.mjs';

const req = createRequire(new URL('../package.json', import.meta.url));
const postcss = createRequire(req.resolve('next/package.json'))('postcss');
// Source contract projected through the strict finite inverse; live new topology is tested in final-shell.
const read = (path) =>
  structuralSource(decodeURIComponent(new URL(path, import.meta.url).pathname).slice(finalRoot.length));
const css = postcss.parse(read('../app/globals.css'));
const rules = (selector) => cssRules(css, selector);
const value = (rule, prop) => rule.nodes.find((node) => node.prop === prop)?.value;

test('root gutter reserves width and supported browsers suppress only duplicate body compensation', () => {
  assert.equal(value(rules('html')[0], 'scrollbar-gutter'), 'stable');
  const override = rules('html body').find((rule) => value(rule, 'width') === 'auto');
  assert.equal(override.parent.name, 'supports');
  assert.equal(override.parent.params, '(scrollbar-gutter: stable)');
  assert.equal(override.nodes.find((node) => node.prop === 'width').important, true);
  assert.deepEqual(
    override.nodes.map((node) => node.prop),
    ['width']
  );
  // Do not replace the library's scroll locking, or force scrolling over dialogs.
  for (const rule of [...rules('html'), ...rules('body'), ...rules('html body')]) {
    assert.ok(!rule.nodes.some((node) => /^overflow/.test(node.prop ?? '')));
  }
});

test('shared header stays independent of page max-width and retains approved wrapping thresholds', () => {
  const shell = read('./site-shell.tsx');
  const headerNode = jsxNodes(shell, 'SiteHeader')[0];
  const childrenNode = astNodes(
    shell,
    (node) =>
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'children'
  )[0];
  assert.ok(headerNode && childrenNode && headerNode.pos < childrenNode.pos);
  assert.equal(value(rules('.site-header-wrap')[0], 'max-width'), '1440px');
  assert.equal(value(rules('.site-header-wrap')[0], 'padding'), '16px 40px');
  for (const rule of rules('.site-header-wrap')) {
    assert.ok(!rule.nodes.some((node) => node.prop === 'position'));
  }
  const header = rules('.site-header');
  assert.ok(
    header.some(
      (rule) =>
        rule.parent.params === '(max-width: 983px)' && value(rule, 'grid-template-rows') === '70px auto'
    )
  );
  assert.ok(
    rules('.main-menu.ant-menu-horizontal').some(
      (rule) => rule.parent.params === '(max-width: 850px)' && value(rule, 'flex-wrap') === 'wrap'
    )
  );
});

test('all 58 reviewed routes retain shared shells or guarded redirects and the unified identity frame', () => {
  const app = new URL('../app/', import.meta.url);
  const pages = readdirSync(app, { recursive: true })
    .filter((path) => /(^|\/)page\.tsx$/.test(path))
    .map((path) => previousFile('apps/web/app/' + path).replace('apps/web/app/', ''));
  const reviewedRoutes = [
    'activities/[id]/edit/page.tsx',
    'activities/[id]/page.tsx',
    'activities/new/page.tsx',
    'activities/page.tsx',
    'activity-shares/[id]/page.tsx',
    'admin/account-lifecycle/page.tsx',
    'admin/accounts/page.tsx',
    'admin/activity-shares/[id]/page.tsx',
    'admin/activity-shares/new/page.tsx',
    'admin/album-categories/page.tsx',
    'admin/announcements/page.tsx',
    'admin/attendance-appeals/page.tsx',
    'admin/bot-management/page.tsx',
    'admin/contact-requests/page.tsx',
    'admin/featured/page.tsx',
    'admin/invitations/page.tsx',
    'admin/knowledge-categories/page.tsx',
    'admin/official-events/page.tsx',
    'admin/page.tsx',
    'admin/penalty-appeals/page.tsx',
    'admin/public-settings/page.tsx',
    'admin/quick-links/page.tsx',
    'admin/resources/page.tsx',
    'admin/roles/page.tsx',
    'albums/[id]/page.tsx',
    'albums/page.tsx',
    'daily/[id]/page.tsx',
    'daily/page.tsx',
    'featured/page.tsx',
    'help-demo/page.tsx',
    'invite/[token]/page.tsx',
    'knowledge/[id]/edit/page.tsx',
    'knowledge/[id]/page.tsx',
    'knowledge/new/page.tsx',
    'knowledge/page.tsx',
    'login/page.tsx',
    'lotteries/[id]/page.tsx',
    'lotteries/new/page.tsx',
    'lotteries/page.tsx',
    'me/activities/page.tsx',
    'me/activity-penalties/page.tsx',
    'me/messages/page.tsx',
    'me/profile/page.tsx',
    'me/teams/history/page.tsx',
    'me/teams/page.tsx',
    'members/[id]/page.tsx',
    'members/[id]/photos/page.tsx',
    'members/page.tsx',
    'page.tsx',
    'resources/page.tsx',
    'teams/[id]/page.tsx',
    'teams/new/page.tsx',
    'teams/page.tsx',
    'wishes/[id]/activity/page.tsx',
    'wishes/[id]/edit/page.tsx',
    'wishes/[id]/page.tsx',
    'wishes/new/page.tsx',
    'wishes/page.tsx'
  ];
  const groupedRoutes = {
    '(site)/page.tsx': 'page.tsx',
    '(site)/resources/page.tsx': 'resources/page.tsx',
    '(protected)/activities/page.tsx': 'activities/page.tsx',
    '(protected)/activities/[id]/page.tsx': 'activities/[id]/page.tsx',
    '(protected)/albums/page.tsx': 'albums/page.tsx',
    '(protected)/albums/[id]/page.tsx': 'albums/[id]/page.tsx',
    '(protected)/lotteries/page.tsx': 'lotteries/page.tsx',
    '(protected)/lotteries/new/page.tsx': 'lotteries/new/page.tsx',
    '(protected)/lotteries/[id]/page.tsx': 'lotteries/[id]/page.tsx',
    '(protected)/teams/page.tsx': 'teams/page.tsx',
    '(protected)/teams/new/page.tsx': 'teams/new/page.tsx',
    '(protected)/teams/[id]/page.tsx': 'teams/[id]/page.tsx',
    '(protected)/members/page.tsx': 'members/page.tsx',
    '(protected)/members/[id]/page.tsx': 'members/[id]/page.tsx',
    '(protected)/members/[id]/photos/page.tsx': 'members/[id]/photos/page.tsx',
    '(protected)/daily/page.tsx': 'daily/page.tsx',
    '(protected)/daily/[id]/page.tsx': 'daily/[id]/page.tsx',
    '(protected)/knowledge/page.tsx': 'knowledge/page.tsx',
    '(protected)/knowledge/new/page.tsx': 'knowledge/new/page.tsx',
    '(protected)/knowledge/[id]/page.tsx': 'knowledge/[id]/page.tsx',
    '(protected)/knowledge/[id]/edit/page.tsx': 'knowledge/[id]/edit/page.tsx'
  };
  const logicalPages = pages.map((path) => groupedRoutes[path] ?? path);
  assert.equal(pages.length, 58);
  assert.equal(new Set(logicalPages).size, 58);
  assert.deepEqual([...logicalPages].sort(), reviewedRoutes);
  assert.deepEqual(
    pages.filter((path) => path.startsWith('(site)/') || path.startsWith('(protected)/')).sort(),
    Object.keys(groupedRoutes).sort()
  );
  assert.ok(returnedWrappingJsx(read('../app/admin/contact-requests/page.tsx'), 'SiteShell').length);
  const redirectRoutes = {
    'admin/album-categories/page.tsx': ['requirePageAdministrator', '/admin/featured'],
    'admin/invitations/page.tsx': ['requirePageAdministrator', '/admin/accounts?tab=invitations'],
    'admin/public-settings/page.tsx': ['requirePageSuperAdministrator', '/admin/contact-requests'],
    'admin/roles/page.tsx': ['requirePageSuperAdministrator', '/admin/accounts?tab=roles'],
    'me/profile/page.tsx': ['requirePageAccount', '/members/']
  };
  for (const path of pages) {
    const source = structuralSource('apps/web/app/' + path),
      redirectRoute = redirectRoutes[path];
    if (redirectRoute) {
      assert.ok(hasCall(source, redirectRoute[0]), path);
      assert.ok(hasCall(source, 'redirect'), path);
      assert.ok(literalStrings(source).includes(redirectRoute[1]), path);
    } else if (path === 'help-demo/page.tsx') {
      assert.ok(
        astNodes(
          source,
          (node) =>
            ts.isImportDeclaration(node) &&
            node.importClause?.name?.text === 'DemoPage' &&
            node.moduleSpecifier.text === '../../components/site-help/demo-page'
        ).length
      );
      assert.ok(jsxNodes(source, 'DemoPage').length);
    } else if (Object.hasOwn(groupedRoutes, path)) {
      // Only these six reviewed URLs, three lottery pages, three team pages and nine private content pages share the layout Shell.
      const layout = read(
        path.startsWith('(protected)/') ? '../app/(protected)/layout.tsx' : '../app/(site)/layout.tsx'
      );
      assert.equal(jsxNodes(layout, 'SiteShell').length, 1);
      if (path.startsWith('(protected)/')) {
        assert.equal(returnedWrappingJsx(layout, 'ProtectedSessionSnapshot').length, 1);
        assert.equal(
          jsxNodes(layout, 'SiteShell')[0].parent.parent.openingElement.tagName.getText(),
          'ProtectedSessionSnapshot'
        );
      } else assert.equal(returnedWrappingJsx(layout, 'SiteShell').length, 1);
      assert.equal(jsxNodes(source, 'SiteShell').length, 0, path);
      const payload = {
        '(site)/page.tsx': 'HomeContent',
        '(site)/resources/page.tsx': 'ResourceBrowser',
        '(protected)/activities/page.tsx': 'ActivityBrowser',
        '(protected)/activities/[id]/page.tsx': 'ActivityDetail',
        '(protected)/albums/page.tsx': 'AlbumBrowser',
        '(protected)/albums/[id]/page.tsx': 'AlbumDetail',
        '(protected)/lotteries/page.tsx': 'LotteryBrowser',
        '(protected)/lotteries/new/page.tsx': 'LotteryPublisher',
        '(protected)/lotteries/[id]/page.tsx': 'LotteryDetail',
        '(protected)/teams/page.tsx': 'TeamBrowser',
        '(protected)/teams/new/page.tsx': 'TeamCreate',
        '(protected)/teams/[id]/page.tsx': 'TeamWorkspace',
        '(protected)/members/page.tsx': 'MemberDirectory',
        '(protected)/members/[id]/page.tsx': 'MemberHome',
        '(protected)/members/[id]/photos/page.tsx': 'MemberPhotos',
        '(protected)/daily/page.tsx': 'DailyFeed',
        '(protected)/daily/[id]/page.tsx': 'DailyFeed',
        '(protected)/knowledge/page.tsx': 'KnowledgeBrowser',
        '(protected)/knowledge/new/page.tsx': 'KnowledgeEditor',
        '(protected)/knowledge/[id]/page.tsx': 'KnowledgeDetail',
        '(protected)/knowledge/[id]/edit/page.tsx': 'KnowledgeEditor'
      }[path];
      assert.equal(jsxNodes(source, payload).length, 1, path);
    } else assert.ok(returnedWrappingJsx(source, 'SiteShell').length, path);
  }
  const accountPage = read('../app/admin/accounts/page.tsx'),
    identity = read('./admin-management/identity-admin.tsx');
  const shellNode = jsxNodes(accountPage, 'SiteShell')[0];
  const suspense = shellNode?.parent.children?.find(
    (node) => ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'Suspense'
  );
  assert.ok(suspense && jsxNodes(suspense, 'IdentityAdmin').length);
  assert.ok(
    jsxNodes(identity, 'main').some(
      (node) =>
        jsxAttribute(node, 'className') === 'home-content management-content identity-admin' &&
        jsxAttribute(node, 'id') === 'main-content'
    )
  );
  for (const component of ['AccountManager', 'InvitationManager', 'RolesAdmin'])
    assert.ok(jsxNodes(identity, component).length, component);
  assert.ok(
    jsxNodes(identity, 'AdminReturnLink').some(
      (node) => jsxAttribute(node, 'disabled')?.identifier === 'locked'
    )
  );
  const admin = postcss.parse(read('./invitation/admin.module.css'));
  const main = admin.nodes.find((node) => node.selector === '.main');
  assert.equal(value(main, 'max-width'), '1440px');
  assert.equal(value(main, 'padding'), '24px 64px 64px');
  assert.equal(value(main, 'grid-template-columns'), 'minmax(0, 1fr)');
  assert.ok(
    jsxNodes(read('./account/account-ui.tsx'), 'Modal').some(
      (node) => jsxAttribute(node, 'open')?.identifier === 'open' && jsxAttribute(node, 'width') === 464
    )
  );
  assert.equal(cssDeclarations(read('./members/members.css'), '.member-editor-paper')['max-width'], '960px');
});

test('installed AntD portal lock still owns overflow and requests compensation for overflowing classic-scrollbar pages', () => {
  const antdReq = createRequire(req.resolve('antd/package.json'));
  const dialogReq = createRequire(antdReq.resolve('@rc-component/dialog/package.json'));
  const portalReq = createRequire(dialogReq.resolve('@rc-component/portal/package.json'));
  const lockerSource = readFileSync(portalReq.resolve('./es/useScrollLocker.js'), 'utf8');
  const utilSource = readFileSync(portalReq.resolve('./es/util.js'), 'utf8');
  function load(source, imports) {
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const loaded = { exports: {} };
    new Function('require', 'module', 'exports', compiled)((name) => imports[name], loaded, loaded.exports);
    return loaded.exports;
  }
  const beforeDocument = globalThis.document;
  const beforeWindow = globalThis.window;
  try {
    for (const [height, width, size, expectsCompensation] of [
      [1200, 985, 15, true],
      [600, 985, 15, false],
      [1200, 1000, 0, false]
    ]) {
      globalThis.document = {
        body: { scrollHeight: height, offsetWidth: width },
        documentElement: { clientHeight: 800 }
      };
      globalThis.window = { innerHeight: 800, innerWidth: 1000 };
      let injected = '';
      let cleanup;
      const utils = load(utilSource, {});
      const locker = load(lockerSource, {
        react: { useState: (factory) => [factory()] },
        '@rc-component/util': {
          getTargetScrollBarSize: () => ({ width: size }),
          updateCSS: (text) => {
            injected = text;
          },
          removeCSS: () => {
            injected = '';
          },
          useLayoutEffect: (effect) => {
            cleanup = effect();
          }
        },
        './util': utils
      }).default;
      locker(true);
      const injectedRule = cssRules(injected, 'html body')[0];
      assert.ok(injectedRule);
      const values = declarations(injectedRule);
      assert.equal(values['overflow-y'], 'hidden');
      assert.equal(values.width ? valueTokens(values.width)[0]?.[1] === 'calc' : false, expectsCompensation);
      cleanup();
      assert.equal(injected, '');
    }
  } finally {
    if (beforeDocument === undefined) delete globalThis.document;
    else globalThis.document = beforeDocument;
    if (beforeWindow === undefined) delete globalThis.window;
    else globalThis.window = beforeWindow;
  }
});

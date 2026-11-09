import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import ts from 'typescript';
import { useHydrated } from './use-hydrated.ts';

const require = createRequire(import.meta.url);
const accountUiUrl = new URL('./account-ui.tsx', import.meta.url);
const hookUrl = new URL('./use-hydrated.ts', import.meta.url);

// Execute the real source with inert visual dependencies. No DOM/browser,
// requests, timers, or authentication state are created by this regression test.
function loadSource(url, resolve) {
  const source = readFileSync(url, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(resolve, loaded, loaded.exports);
  return loaded.exports;
}
function renderModalInPhase(phase, props = {}) {
  let phaseValue = phase;
  const hookModule = loadSource(hookUrl, (name) =>
    name === 'react'
      ? {
          useSyncExternalStore(subscribe, client, server) {
            const cleanup = subscribe(() => {});
            assert.equal(typeof cleanup, 'function');
            cleanup();
            return phaseValue === 'client' ? client() : server();
          }
        }
      : require(name)
  );
  const component = loadSource(accountUiUrl, (name) => {
    if (name === './use-hydrated') return hookModule;
    if (name === 'antd')
      return {
        ConfigProvider: ({ children }) => children,
        Modal: (properties) =>
          createElement(
            'section',
            { 'data-modal-open': String(properties.open), 'data-width': properties.width },
            properties.title,
            properties.children
          ),
        theme: { useToken: () => ({ token: {} }) }
      };
    if (name === 'next/image') return () => null;
    if (name === '../home-content')
      return { PageHeading: ({ children }) => createElement('h2', null, children) };
    if (name.endsWith('.svg') || name.endsWith('.css')) return {};
    return require(name);
  });
  return {
    render(nextProps = {}) {
      return renderToString(
        createElement(
          component.AccountModal,
          { variant: 'register', open: true, onClose() {}, ...props, ...nextProps },
          '邀请内容'
        )
      );
    },
    setPhase(value) {
      phaseValue = value;
    }
  };
}
test('real React server rendering reports not hydrated on every direct request or refresh', () => {
  function Probe() {
    return createElement('output', null, String(useHydrated()));
  }
  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal(renderToString(createElement(Probe)), '<output>false</output>');
});
test('direct invite and refresh have identical empty server and first hydration output', () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const modal = renderModalInPhase('server');
    assert.equal(modal.render(), '');
    modal.setPhase('hydration');
    assert.equal(modal.render(), '');
    modal.setPhase('client');
    assert.match(modal.render(), /data-modal-open="true"/);
    assert.match(modal.render(), /data-width="464"/);
    assert.match(modal.render(), /邀请注册/);
  }
});
test('after hydration closing and reopening preserve the controlled open prop', () => {
  const modal = renderModalInPhase('client');
  assert.match(modal.render({ open: true }), /data-modal-open="true"/);
  assert.match(modal.render({ open: false }), /data-modal-open="false"/);
  assert.match(modal.render({ open: true }), /data-modal-open="true"/);
});
test('returning to the invite route after unmount starts with a fresh hydration-safe boundary', () => {
  const first = renderModalInPhase('client');
  assert.match(first.render(), /data-modal-open="true"/);
  const returned = renderModalInPhase('hydration');
  assert.equal(returned.render(), '');
  returned.setPhase('client');
  assert.match(returned.render(), /邀请内容/);
});
test('login and reset variants retain their existing client titles after the same boundary', () => {
  for (const [variant, title] of [
    ['login', '登录'],
    ['reset', '找回密码']
  ]) {
    const modal = renderModalInPhase('hydration', { variant });
    assert.equal(modal.render(), '');
    modal.setPhase('client');
    assert.ok(modal.render().includes(title));
  }
});

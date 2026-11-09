import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import { cssDeclarations } from '../../../tests/rev1105-format-css/syntax.mjs';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./control-focus.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', output)(loaded, loaded.exports);
const { installControlFocus } = loaded.exports;
const attr = 'data-artzoo-control-focus';

// Minimal event targets exercise the production listeners without pretending to
// be a CSS/layout engine. Real AntD structure is checked separately below.
function node({ shell = null, field = false, composite = false } = {}) {
  const attributes = new Map();
  return {
    nodeType: 1,
    attributes,
    closest(selector) {
      return selector.includes('.ant-input-affix-wrapper') ? shell : composite ? (shell ?? this) : null;
    },
    matches() {
      return field;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    }
  };
}
function setup(initial = null) {
  const listeners = new Map();
  const doc = {
    activeElement: initial,
    documentElement: node(),
    addEventListener(name, fn, capture) {
      assert.equal(capture, true);
      assert.ok(!listeners.has(name));
      listeners.set(name, fn);
    },
    removeEventListener(name, fn, capture) {
      assert.equal(capture, true);
      assert.equal(listeners.get(name), fn);
      listeners.delete(name);
    }
  };
  const dispose = installControlFocus(doc);
  return {
    doc,
    listeners,
    dispose,
    emit(name, target = doc.activeElement, extra = {}) {
      listeners.get(name)?.({ target, ...extra });
    },
    focus(target) {
      this.emit('focusout');
      doc.activeElement = target;
      this.emit('focusin', target);
    }
  };
}

test('pointer capture applies before focus, typing/IME/copy keep pointer focus and readonly selection stays untouched', () => {
  const h = setup();
  const input = node({ field: true });
  h.emit('pointerdown', input);
  h.focus(input);
  assert.equal(input.attributes.get(attr), 'pointer');
  for (const event of [
    { key: 'x' },
    { key: 'ArrowLeft' },
    { key: 'c', ctrlKey: true },
    { key: 'a', metaKey: true },
    { key: 'Tab', isComposing: true }
  ])
    h.emit('keydown', input, event);
  assert.equal(input.attributes.get(attr), 'pointer');
  h.dispose();
  assert.equal(input.attributes.has(attr), false);
});

test('Tab and Shift+Tab restore keyboard cue; clicking already focused field restores pointer cue', () => {
  const h = setup();
  const first = node({ field: true });
  const second = node({ field: true });
  h.emit('pointerdown', first);
  h.focus(first);
  h.emit('keydown', first, { key: 'Tab' });
  h.focus(second);
  assert.equal(first.attributes.has(attr), false);
  assert.equal(second.attributes.get(attr), 'keyboard');
  h.emit('keydown', second, { key: 'Tab', shiftKey: true });
  h.focus(first);
  assert.equal(first.attributes.get(attr), 'keyboard');
  h.emit('pointerdown', first);
  assert.equal(first.attributes.get(attr), 'pointer');
  h.dispose();
});

test('Input.Search, password, Select/Cascader, date/time and number inputs mark only their outer shell', () => {
  for (const label of ['search', 'password', 'select', 'cascader', 'date', 'time', 'number']) {
    const shell = node();
    const input = node({
      shell,
      field: true,
      composite: ['select', 'cascader', 'date', 'time'].includes(label)
    });
    const h = setup();
    h.emit('pointerdown', input);
    h.focus(input);
    assert.equal(shell.attributes.get(attr), 'pointer', label);
    assert.equal(input.attributes.has(attr), false, label);
    h.emit('keydown', input, { key: 'Tab' });
    assert.equal(shell.attributes.get(attr), 'keyboard', label);
    h.dispose();
  }
});

test('composite navigation restores keyboard cue and body portal fields use the same listeners', () => {
  const shell = node();
  const portalInput = node({ shell, field: true, composite: true });
  const h = setup();
  h.emit('pointerdown', portalInput, { pointerType: 'touch' });
  h.focus(portalInput);
  assert.equal(shell.attributes.get(attr), 'pointer');
  h.emit('keydown', portalInput, { key: 'ArrowDown' });
  assert.equal(shell.attributes.get(attr), 'keyboard');
  h.emit('pointerdown', portalInput, { pointerType: 'pen' });
  assert.equal(shell.attributes.get(attr), 'pointer');
  h.dispose();
});

test('initial/programmatic focus stays visible; leaving form controls removes marker; cleanup permits StrictMode remount', () => {
  const input = node({ field: true });
  const h = setup(input);
  assert.equal(input.attributes.get(attr), 'keyboard');
  h.focus(node()); // Button/link: native focus style remains outside this policy.
  assert.equal(input.attributes.has(attr), false);
  h.focus(input);
  h.dispose();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.doc.documentElement.attributes.has('data-artzoo-control-focus-ready'), false);
  assert.equal(input.attributes.has(attr), false);
  const disposeAgain = installControlFocus(h.doc);
  assert.equal(input.attributes.get(attr), 'keyboard');
  disposeAgain();
  assert.equal(h.listeners.size, 0);
});

test('actual AntD 6.6.5 SSR uses the shells targeted by the policy, including Cascader and read-only links', () => {
  const { createElement: el } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { Input, InputNumber, Select, Cascader, DatePicker, TimePicker, ConfigProvider } = require('antd');
  const cases = [
    [Input.Search, { allowClear: true }, 'ant-input-affix-wrapper'],
    [Input.Password, {}, 'ant-input-affix-wrapper'],
    [InputNumber, {}, 'ant-input-number'],
    [Select, { options: [{ value: 'a', label: 'a' }] }, 'ant-select'],
    [Cascader, { options: [{ value: 'region', children: [{ value: 'server' }] }] }, 'ant-select'],
    [DatePicker, {}, 'ant-picker'],
    [TimePicker, {}, 'ant-picker']
  ];
  for (const [Component, props, shell] of cases) {
    const html = renderToStaticMarkup(el(ConfigProvider, {}, el(Component, props)));
    assert.ok(html.includes(shell), shell);
    assert.match(html, /<input\b/);
  }
  const readonly = renderToStaticMarkup(el(Input, { readOnly: true, value: 'synthetic-link' }));
  assert.match(readonly, /read[oO]nly=""/);
  assert.doesNotMatch(readonly, /disabled=""/);
});

test('picker portal navigation keeps shadow suppression after input blur while AntD retains picker-focused', () => {
  const picker = node();
  picker.className = 'ant-picker ant-picker-outlined ant-picker-focused';
  const input = node({ shell: picker, field: true, composite: true });
  const portalButton = node();
  const h = setup();
  h.emit('pointerdown', input);
  h.focus(input);
  assert.equal(picker.attributes.get(attr), 'pointer');
  h.emit('pointerdown', portalButton);
  h.emit('focusout', input, { relatedTarget: portalButton });
  h.doc.activeElement = portalButton;
  h.emit('focusin', portalButton, { relatedTarget: input });
  // rc-picker retains its own focused class when relatedTarget is in its popup.
  assert.ok(picker.className.includes('ant-picker-focused'));
  assert.equal(picker.attributes.has(attr), false);
  assert.equal(portalButton.attributes.has(attr), false);
  assert.equal(h.doc.documentElement.attributes.has('data-artzoo-control-focus-ready'), true);
  h.emit('keydown', portalButton, { key: 'Tab' });
  h.focus(input);
  assert.equal(picker.attributes.get(attr), 'keyboard');
  h.dispose();
  assert.equal(h.doc.documentElement.attributes.has('data-artzoo-control-focus-ready'), false);
});

test('real AntD SSR shadow tokens inherit the ready-document override independently of focused-shell attributes', () => {
  const { createElement: el } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { StyleProvider, createCache, extractStyle } = require('@ant-design/cssinjs');
  const { ConfigProvider, Input, Select, DatePicker, TimePicker } = require('antd');
  const themeSource = readFileSync(new URL('./control-focus-theme.ts', import.meta.url), 'utf8');
  const themeJs = ts.transpileModule(themeSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText;
  const themeModule = { exports: {} };
  new Function('module', 'exports', themeJs)(themeModule, themeModule.exports);
  const { controlFocusShadows, selectFocusOutline } = themeModule.exports;
  const cache = createCache();
  renderToStaticMarkup(
    el(
      StyleProvider,
      { cache },
      el(
        ConfigProvider,
        {
          theme: {
            components: {
              Input: controlFocusShadows,
              DatePicker: controlFocusShadows,
              Select: selectFocusOutline
            }
          }
        },
        el(Input),
        el(Select),
        el(DatePicker),
        el(TimePicker)
      )
    )
  );
  const styles = extractStyle(cache);
  assert.ok(styles.includes('var(--artzoo-control-shadow,'));
  assert.ok(styles.includes('var(--artzoo-control-outline,'));
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const readyRule = cssDeclarations(css, ':root[data-artzoo-control-focus-ready]');
  assert.equal(readyRule['--artzoo-control-shadow'], 'none');
  assert.equal(readyRule['--artzoo-control-outline'], 'transparent');
  for (const property of ['outline', 'border', 'background'])
    assert.equal(Object.hasOwn(readyRule, property), false);
});

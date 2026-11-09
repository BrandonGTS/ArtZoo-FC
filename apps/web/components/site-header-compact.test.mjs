// Controller tests only: actual whole-page geometry and portal QA are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./use-compact-header.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(() => ({}), loaded, loaded.exports);
const { observeCompactHeader } = loaded.exports;

function harness({ desktop = true, bottom = 16, observer = true } = {}) {
  const previousWindow = globalThis.window;
  const previousObserver = globalThis.IntersectionObserver;
  let geometry = bottom;
  let nextFrame = 0;
  const frames = new Map();
  const listeners = new Map();
  const mediaListeners = new Set();
  const changes = [];
  const marker = { getBoundingClientRect: () => ({ bottom: geometry }) };
  const media = {
    matches: desktop,
    addEventListener: (name, callback) => mediaListeners.add(callback),
    removeEventListener: (name, callback) => mediaListeners.delete(callback)
  };
  const observers = [];
  globalThis.window = {
    matchMedia: (query) => {
      assert.equal(query, '(min-width: 984px)');
      return media;
    },
    addEventListener: (name, callback, options) => listeners.set(name, { callback, options }),
    removeEventListener: (name) => listeners.delete(name),
    requestAnimationFrame: (callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id)
  };
  globalThis.IntersectionObserver = observer
    ? class {
        constructor(callback, options) {
          this.callback = callback;
          observers.push(this);
          assert.equal(options.rootMargin, '-4px 0px 0px 0px');
        }
        observe(target) {
          this.target = target;
        }
        disconnect() {
          this.target = undefined;
        }
      }
    : undefined;
  const cleanup = observeCompactHeader(marker, (value) => changes.push(value));
  return {
    changes,
    listeners,
    frames,
    mediaListeners,
    get target() {
      return observers.at(-1)?.target;
    },
    enter(bottom) {
      geometry = bottom;
      observers.at(-1).callback([{ target: marker, boundingClientRect: { bottom } }]);
    },
    viewport(desktop, bottom = geometry) {
      media.matches = desktop;
      geometry = bottom;
      for (const callback of mediaListeners) callback();
    },
    scroll(bottom) {
      geometry = bottom;
      listeners.get('scroll').callback();
    },
    flush() {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback();
      }
    },
    cleanup,
    restore() {
      cleanup();
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousObserver === undefined) delete globalThis.IntersectionObserver;
      else globalThis.IntersectionObserver = previousObserver;
    }
  };
}

test('crossing the fixed edge and returning changes layout once per boundary', () => {
  const h = harness();
  try {
    assert.deepEqual(h.changes, []);
    assert.equal(h.listeners.size, 0, 'native observer adds no scroll listener');
    h.enter(4);
    h.enter(-100);
    h.enter(-200);
    assert.deepEqual(h.changes, [true]);
    h.enter(5);
    h.enter(16);
    assert.deepEqual(h.changes, [true, false]);
    h.enter(1200); // A marker below the viewport is not a scrolled-away marker.
    assert.deepEqual(h.changes, [true, false]);
  } finally {
    h.restore();
  }
});

test('restored deep scroll starts compact, mobile releases it, desktop restores from geometry', () => {
  const h = harness({ bottom: -300 });
  try {
    assert.deepEqual(h.changes, [true]);
    h.viewport(false);
    assert.equal(h.target, undefined);
    h.enter(-300); // A stale queued observer entry cannot fix mobile navigation.
    assert.deepEqual(h.changes, [true, false]);
    h.viewport(true);
    assert.ok(h.target);
    assert.deepEqual(h.changes, [true, false, true]);
  } finally {
    h.restore();
  }
});

test('initial narrow layout never fixes and cleans up its media observation', () => {
  const h = harness({ desktop: false, bottom: -100 });
  try {
    assert.deepEqual(h.changes, []);
    assert.equal(h.target, undefined);
    h.cleanup();
    assert.equal(h.mediaListeners.size, 0);
    h.enter(-100);
    assert.deepEqual(h.changes, []);
  } finally {
    h.restore();
  }
});

test('fallback batches rapid passive scrolling and cancels pending work on unmount', () => {
  const h = harness({ observer: false });
  try {
    assert.equal(h.listeners.get('scroll').options.passive, true);
    h.scroll(0);
    h.scroll(-10);
    h.scroll(-20);
    assert.equal(h.frames.size, 1);
    assert.deepEqual(h.changes, []);
    h.flush();
    assert.deepEqual(h.changes, [true]);
    h.scroll(16);
    h.flush();
    assert.deepEqual(h.changes, [true, false]);
    h.scroll(-20);
    h.cleanup();
    assert.equal(h.frames.size, 0);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.mediaListeners.size, 0);
  } finally {
    h.restore();
  }
});

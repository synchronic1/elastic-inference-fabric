import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ThemeToggle, { applyTheme, currentTheme, THEME_KEY } from '../src/ThemeToggle';

const startup = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');

function boot(saved: string | null, prefersLight: boolean, blocked = false) {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  let themeColor = '';
  const document = { documentElement: root, querySelector: () => ({ setAttribute: (_name: string, value: string) => { themeColor = value; } }) };
  const localStorage = { getItem: () => { if (blocked) throw new Error('storage blocked'); return saved; } };
  runInNewContext(startup, { document, localStorage, matchMedia: () => ({ matches: prefersLight }) });
  return { root, themeColor };
}

test('theme starts before paint with saved choice taking priority over system preference', () => {
  assert.equal(boot('light', false).root.dataset.theme, 'light');
  assert.equal(boot('dark', true).root.dataset.theme, 'dark');
  assert.equal(boot(null, true).root.dataset.theme, 'light');
  assert.equal(boot('unexpected', false).root.dataset.theme, 'dark');
  assert.equal(boot('light', false).themeColor, '#f4f6f9');
});

test('blocked storage still allows a system-selected initial theme', () => {
  const { root } = boot(null, true, true);
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.style.colorScheme, 'light');
});

test('theme changes apply to the whole document and persist, including switching back', () => {
  const { root } = boot(null, false);
  const writes: Array<[string, string]> = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root, querySelector: () => null } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: (key: string, value: string) => { writes.push([key, value]); } } });
  try {
    applyTheme('light');
    assert.equal(currentTheme(), 'light');
    assert.equal(root.style.colorScheme, 'light');
    assert.match(renderToStaticMarkup(createElement(ThemeToggle)), /aria-label="Switch to dark mode"/);
    applyTheme('dark');
    assert.equal(currentTheme(), 'dark');
    assert.match(renderToStaticMarkup(createElement(ThemeToggle)), /aria-label="Switch to light mode"/);
    assert.deepEqual(writes, [[THEME_KEY, 'light'], [THEME_KEY, 'dark']]);
  } finally { Reflect.deleteProperty(globalThis, 'document'); Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('theme toggle remains functional when preference persistence is blocked', () => {
  const { root } = boot(null, false);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root, querySelector: () => null } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: () => { throw new Error('storage blocked'); } } });
  try { assert.doesNotThrow(() => applyTheme('light')); assert.equal(currentTheme(), 'light'); }
  finally { Reflect.deleteProperty(globalThis, 'document'); Reflect.deleteProperty(globalThis, 'localStorage'); }
});

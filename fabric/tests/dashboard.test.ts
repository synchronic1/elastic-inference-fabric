import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/App';
import { PRIMARY_MODELS } from '../src/model-catalog';

test('public dashboard renders all five model roles without claiming live availability', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://fabric.example' } },
  });
  try {
    const markup = renderToStaticMarkup(createElement(App));
    assert.equal(PRIMARY_MODELS.length, 5);
    for (const model of PRIMARY_MODELS) {
      assert.ok(markup.includes(model.name));
      assert.ok(markup.includes(model.source_url));
    }
    assert.equal(markup.match(/Sign in to inspect/g)?.length, 5);
    assert.ok(!markup.includes('No node reports this model'));
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

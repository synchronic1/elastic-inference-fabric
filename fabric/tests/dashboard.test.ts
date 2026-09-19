import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/App';
import { AccessIntroduction } from '../src/AccessPanel';
import { PRIMARY_MODELS } from '../src/model-catalog';
import WorkloadAccess from '../src/WorkloadAccess';

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
    assert.match(markup, /id="flow"/);
    assert.match(markup, /data-view="demo"/);
    assert.match(markup, /Fabric flow diagram/);
    assert.match(markup, /href="#flow"/);
    assert.match(markup, /id="fabric-access"/);
    assert.ok(markup.indexOf('id="flow"') < markup.indexOf('class="model-roster"'));
    assert.ok(!markup.includes('data-active="true"'));
    assert.match(markup, /aria-label="Fabric account"/);
    assert.match(markup, /href="#access-tokens"/);
    assert.match(markup, /id="access-tokens"/);
    assert.match(markup, /aria-label="Sign in to Fabric"/);
    assert.match(markup, /id="fabric-token"/);
    assert.ok(markup.indexOf('id="fabric-token"') < markup.indexOf('id="flow"'));
    assert.ok(!markup.includes('aria-label="Issue a Fabric access token"'));
    assert.match(markup, /aria-label="Elastic Inference Fabric home"/);
    assert.match(markup, /class="brand-mark"/);
    assert.match(markup, /aria-label="Switch to light mode"/);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

test('public token setup explains administrator provisioning without enabling anonymous issuance', () => {
  const markup = renderToStaticMarkup(createElement(AccessIntroduction));
  assert.match(markup, /no public self-registration or anonymous token issuance/);
  assert.match(markup, /Only administrators can issue or revoke/);
  assert.match(markup, /bin\/fabric copy-token/);
  assert.match(markup, /Node connector tokens cannot sign in/);
  assert.ok(!markup.includes('<form'));
  assert.ok(!markup.includes('fat_'));
});

test('viewer UI replaces workload submission and private results with a read-only notice', () => {
  const children = createElement('form', { 'aria-label': 'Submit workload' }, 'private job result');
  const viewer = renderToStaticMarkup(createElement(WorkloadAccess, { readOnly: true, children }));
  assert.match(viewer, /Read-only demo access/);
  assert.match(viewer, /cannot submit workloads/);
  assert.ok(!viewer.includes('<form'));
  assert.ok(!viewer.includes('private job result</form>'));
  const agent = renderToStaticMarkup(createElement(WorkloadAccess, { readOnly: false, children }));
  assert.match(agent, /aria-label="Submit workload"/);
});

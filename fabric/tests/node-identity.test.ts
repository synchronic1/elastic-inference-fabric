import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import NodeIdentity, { nodePresentation } from '../src/NodeIdentity';

test('demo labels preserve canonical node IDs and only annotate known nodes', () => {
  for (const [id, name, sublabel] of [
    ['peter-mac-cpu', 'Mac', 'Portable · Local'],
    ['ubuntu-desktop-node', 'Ubuntu node', 'Remote · Sweden'],
  ]) {
    assert.deepEqual(nodePresentation(id), { name, sublabel });
    const markup = renderToStaticMarkup(createElement(NodeIdentity, { nodeId: id }));
    assert.ok(markup.includes(name));
    assert.ok(markup.includes(sublabel));
    assert.ok(markup.includes(`class="node-canonical-id">${id}</small>`));
  }
  for (const id of ['new-linux-node', 'peter-mac-cpu-2', 'constructor']) {
    assert.deepEqual(nodePresentation(id), { name: id, sublabel: null });
    const markup = renderToStaticMarkup(createElement(NodeIdentity, { nodeId: id }));
    assert.ok(!markup.includes('node-sublabel'));
  }
});

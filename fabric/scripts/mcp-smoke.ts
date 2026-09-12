import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';

const origin = process.env.FABRIC_ORIGIN ?? 'https://elasticinferencefabric.airanger.dev';
const token = process.env.GANGLION_FABRIC_TOKEN;
if (!token) throw new Error('GANGLION_FABRIC_TOKEN must be supplied by the credential helper');
const client = new Client({ name: 'ganglion-smoke', version: '0.2.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const { tools } = await client.listTools();
  console.log(JSON.stringify({ initialized: true, tools: tools.map((tool) => tool.name), resources: (await client.listResources()).resources.map((resource) => resource.uri) }));
  if (process.argv.includes('--submit')) {
    const task = JSON.parse(readFileSync(new URL('../../examples/qwen-task.json', import.meta.url), 'utf8'));
    const accepted = await client.callTool({ name: 'fabric_submit_task', arguments: task });
    if (accepted.isError) throw new Error(JSON.stringify(accepted.content));
    const id = (accepted.structuredContent as Record<string, unknown> | undefined)?.id;
    if (typeof id !== 'string') throw new Error('No job ID in MCP response');
    for (let attempt = 0; attempt < 90; attempt++) {
      const response = await client.callTool({ name: 'fabric_get_task', arguments: { job_id: id } });
      if (response.isError) throw new Error(JSON.stringify(response.content));
      const job = response.structuredContent as Record<string, unknown> | undefined;
      if (job?.status !== 'running') {
        console.log(JSON.stringify({ job }));
        if (job?.status !== 'succeeded') throw new Error('Inference task did not succeed');
        const result = job.result as Record<string, unknown> | undefined;
        if (result?.simulated !== false) throw new Error('Expected real native inference');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (attempt === 89) throw new Error('Task is still running after 90 seconds');
    }
  }
} finally {
  await client.close();
}

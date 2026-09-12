/** Credential-injecting MCP bridge for harnesses with stdio-only configuration. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const token = process.env.GANGLION_FABRIC_TOKEN;
if (!token) throw new Error('Fabric credential is unavailable');
const origin = process.env.FABRIC_ORIGIN ?? 'https://elasticinferencefabric.airanger.dev';
const remote = new Client({ name: 'ganglion-stdio-bridge', version: '0.2.0' });
await remote.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
const server = new Server({ name: 'ganglion-fabric', version: '0.2.0' }, { capabilities: { tools: {}, resources: {} }, instructions: remote.getInstructions() });
server.setRequestHandler(ListToolsRequestSchema, async () => remote.listTools());
server.setRequestHandler(CallToolRequestSchema, async (request) => remote.callTool(request.params));
server.setRequestHandler(ListResourcesRequestSchema, async () => remote.listResources());
server.setRequestHandler(ReadResourceRequestSchema, async (request) => remote.readResource(request.params));
server.onclose = () => { void remote.close(); };
await server.connect(new StdioServerTransport());

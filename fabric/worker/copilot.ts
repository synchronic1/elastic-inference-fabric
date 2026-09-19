import { AgentRunner, BuiltInAgent, CopilotRuntime, createCopilotRuntimeHandler,
  type BuiltInAgentCustomFactoryConfig, type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest, type AgentRunnerIsRunningRequest,
  type AgentRunnerStopRequest } from '@copilotkit/runtime/v2';
import { EventType, type BaseEvent } from '@ag-ui/client';
import { EMPTY, Observable } from 'rxjs';
import type { ChatMessage, FabricJob, FabricState, TaskRequest } from '../src/contracts';
import { InputError } from './domain';
import { readJsonBody } from './http';

type AgentFactoryContext = Parameters<BuiltInAgentCustomFactoryConfig['factory']>[0];

export interface CopilotFabric {
  resources(): FabricState;
  submit(task: TaskRequest): Promise<FabricJob>;
  task(id: string): FabricJob;
}

const SYSTEM_INSTRUCTION = 'You are a local inference assistant without web search or live location data. Answer directly and concisely. Do not invent current facts; explain when a request needs live information.';
const MAX_TURN_CHARACTERS = 12_000;
const MAX_CONTEXT_BYTES = 48_000;
const MAX_HISTORY_MESSAGES = 12;
const OUTPUT_TOKENS = 1024;
function escapeChatMl(content: string): string {
  return content.replaceAll('<|', '<\u200b|').replaceAll('<think>', '<\u200bthink>')
    .replaceAll('</think>', '<\u200b/think>');
}

function chatMlTask(chat: ChatMessage[]): Pick<TaskRequest, 'prefix' | 'prompt'> {
  const prior = chat.slice(0, -1).map(({ role, content }) =>
    `<|im_start|>${role}\n${escapeChatMl(content)}\n<|im_end|>\n`).join('');
  return { prefix: `${prior}<|im_start|>user\n`,
    prompt: `${escapeChatMl(chat.at(-1)!.content)}\n<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n` };
}

// One handler and runner per authenticated HTTP request. Never use the SDK's
// process-global InMemoryAgentRunner: unrelated Fabric identities share an isolate.
class FabricTurnRunner extends AgentRunner {
  run({ agent, input }: AgentRunnerRunRequest): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      void agent.runAgent(input, { onEvent: ({ event }) => subscriber.next(event) })
        .then(() => subscriber.complete(), (error) => subscriber.error(error));
      return () => { agent.abortRun(); };
    });
  }
  connect(_: AgentRunnerConnectRequest): Observable<BaseEvent> { return EMPTY; }
  isRunning(_: AgentRunnerIsRunningRequest) { return Promise.resolve(false); }
  stop(_: AgentRunnerStopRequest) { return Promise.resolve(false); }
}

export function completionTask(messages: AgentFactoryContext['input']['messages'], state: FabricState,
  excludeModels: ReadonlySet<string> = new Set()): TaskRequest {
  const latest = messages.at(-1);
  if (latest?.role !== 'user' || typeof latest.content !== 'string' || !latest.content.trim()) {
    throw new InputError('Send a plain-text user message. Attachments and tools are not supported.');
  }
  if (latest.content.length > MAX_TURN_CHARACTERS) throw new InputError('Use at most 12,000 characters per message.', 413);
  const history: ChatMessage[] = messages.slice(0, -1)
    .filter((item) => (item.role === 'user' || item.role === 'assistant')
      && typeof item.content === 'string' && !!item.content.trim()
      && item.content.length <= MAX_TURN_CHARACTERS)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({ role: item.role as 'user' | 'assistant', content: item.content as string }));
  const chat: ChatMessage[] = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    ...history,
    { role: 'user', content: latest.content },
  ];
  const encoder = new TextEncoder();
  const size = () => chat.reduce((total, item) => total + encoder.encode(item.content).byteLength, 0);
  while (chat.length > 2 && (chat[1].role === 'assistant' || size() > MAX_CONTEXT_BYTES)) chat.splice(1, 1);
  if (size() > MAX_CONTEXT_BYTES) throw new InputError('Message exceeds the local chat context limit.', 413);
  const candidates = state.nodes.filter((n) => n.status === 'online' && n.connected)
    .flatMap((n) => n.snapshot.models.map((model) => ({
      model, runtime: n.snapshot.runtimes.find((runtime) => runtime.id === model.runtime),
    })))
    .filter(({ model, runtime }) => !excludeModels.has(model.id)
      && model.available && model.resident && !model.simulated
      && model.capabilities.includes('complete') && runtime?.supports_chat === true);
  const idle = candidates.filter(({ runtime }) => runtime?.busy === false && runtime.state === 'ready')
    .sort((a, b) => Number(b.model.resident) - Number(a.model.resident)
      || a.model.id.localeCompare(b.model.id));
  const selected = idle[0];
  const model = selected?.model;
  if (!model) throw new InputError(candidates.length
    ? 'All resident chat models are busy. Try again in a moment.'
    : 'No online resident chat model is available.', candidates.length ? 429 : 409);
  const profile = selected?.runtime?.chat_profile;
  const verifiedRaw = profile?.status === 'verified' && profile.model_id === model.id
    && profile.format === 'raw_chatml_no_think';
  return {
    capability: 'complete', model_id: model.id, max_tokens: OUTPUT_TOKENS,
    temperature: 0.3, allow_simulated: false,
    ...(verifiedRaw ? chatMlTask(chat) : { messages: chat }),
  };
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('response disconnected')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

function completedText(job: FabricJob): string {
  const content = job.result?.content;
  if (typeof content === 'string' && content) return content;
  if (Array.isArray(content)) {
    const text = content.flatMap((part: unknown) => typeof part === 'string' ? [part]
      : part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('\n');
    if (text) return text;
  }
  throw new InputError('The node completed without a text response.', 502);
}

async function* completionEvents(ctx: AgentFactoryContext, fabric: CopilotFabric, signal: AbortSignal): AsyncIterable<BaseEvent> {
  // BuiltInAgent owns RUN_STARTED/RUN_FINISHED/RUN_ERROR in v1.71.1.
  try {
    if (signal.aborted) return;
    const attempted = new Set<string>();
    let job: FabricJob;
    for (;;) {
      const task = completionTask(ctx.input.messages, fabric.resources(), attempted);
      attempted.add(task.model_id!);
      job = await fabric.submit(task);
      const deadline = Date.now() + 185000;
      while (job.status === 'running') {
        if (Date.now() > deadline) throw new InputError('Response wait timed out. Check the Fabric job list.', 504);
        await waitForPoll(signal);
        // getTask rechecks expiry/revocation and ownership on every poll.
        job = fabric.task(job.id);
      }
      if (signal.aborted || job.status === 'succeeded') break;
      // A completed, empty generation is safe to try once on a different
      // resident model. Do not replay uncertain failures or keep a queue here.
      if (attempted.size >= 2 || job.status !== 'failed'
        || !/no visible answer/i.test(job.error ?? '')) break;
      try { completionTask(ctx.input.messages, fabric.resources(), attempted); }
      catch { break; }
    }
    if (signal.aborted) return;
    if (job.status !== 'succeeded') throw new InputError(job.error ?? `Fabric job ${job.status}`, 502);
    const text = completedText(job);
    const messageId = crypto.randomUUID();
    yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' };
    // Dendrite returns a completed response, not token streaming.
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text };
    yield { type: EventType.TEXT_MESSAGE_END, messageId };
  } catch (error) {
    if (!signal.aborted) throw new Error(error instanceof InputError ? error.message : 'Fabric completion failed.');
  }
}

export async function handleCopilot(request: Request, fabric: CopilotFabric): Promise<Response> {
  if (request.method !== 'POST') throw new InputError('Use POST for the CopilotKit endpoint.', 405);
  const envelope = await readJsonBody(request, 160 * 1024);
  if (!envelope || typeof envelope !== 'object' || !('method' in envelope)
    || !['info', 'agent/run', 'agent/connect', 'agent/stop'].includes(String(envelope.method))) {
    throw new InputError('Unsupported CopilotKit operation. History, tools and cloud services are disabled.');
  }
  if (envelope.method !== 'info' && (!('params' in envelope) || !envelope.params
    || typeof envelope.params !== 'object' || !('agentId' in envelope.params) || envelope.params.agentId !== 'fabric')) {
    throw new InputError('Unknown Fabric agent.');
  }
  fabric.resources(); // Revalidate after the asynchronous body read.
  const agent = new BuiltInAgent({ type: 'custom', factory: (ctx) =>
    completionEvents(ctx, fabric, AbortSignal.any([ctx.abortSignal, request.signal])) });
  // The SDK's default factory metadata advertises features our adapter does not
  // implement. Capability discovery must reflect this completion-only surface.
  agent.getCapabilities = async () => ({ tools: { supported: false, clientProvided: false },
    transport: { streaming: true }, humanInTheLoop: { interrupts: false } });
  const runtime = new CopilotRuntime({
    debug: false, runner: new FabricTurnRunner(),
    agents: { fabric: agent },
  });
  const handler = createCopilotRuntimeHandler({ runtime, basePath: '/api/copilotkit', mode: 'single-route', cors: false, activateChannels: false });
  // Authentication was handled by Fabric. Do not forward cookies/tokens into
  // SDK metadata, logs or any prospective transport.
  const sanitized = new Request(request.url, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: request.headers.get('accept') ?? 'text/event-stream' },
    body: JSON.stringify(envelope), signal: request.signal });
  const response = await handler(sanitized);
  if (envelope.method === 'info' && response.ok) {
    const info = await response.json() as Record<string, unknown>;
    return Response.json({ ...info, suggestions: false,
      singleRoute: { resourceOperations: false, threadEndpoints: info.threadEndpoints } },
    { headers: { 'Cache-Control': 'no-store' } });
  }
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

// Shared frontend/backend contract. Times are Unix milliseconds unless *_seconds.
export interface PrefixCandidate {
  prefix_sha256: string; prefix_bytes: number; expires_at: number;
  runtime_instance: string; model_fingerprint: string; slot_id: number;
  state: 'candidate'; portable: false; simulated: boolean;
}
export interface RuntimeSnapshot {
  id: string; kind: string; mode: string; state: string; busy: boolean;
  simulated: boolean; loaded_model: string | null; prefix_cache: PrefixCandidate[];
  runtime_instance: string; model_fingerprint: string | null;
  supports_model_switch: boolean; supports_cache_transfer: boolean;
}
export interface ModelSnapshot {
  id: string; runtime: string; capabilities: string[]; cached_on_disk: boolean;
  resident: boolean; available: boolean; simulated: boolean; size_bytes?: number;
  fingerprint?: string | null;
}
export interface NodeSnapshot {
  schema_version: string; node_id: string; observed_at: number; uptime_seconds: number;
  execution_scope: string; active_requests: number;
  hardware: { os: string; arch: string; hostname: string; cpu: string;
    logical_cpus: number; physical_cpus: number | null; memory_total_bytes: number;
    gpus: {vendor: string; name: string; memory_bytes: number | null; unified_memory?: boolean}[] };
  load: { load_average: number[] | null; memory_available_bytes: number; memory_used_percent: number };
  runtimes: RuntimeSnapshot[]; models: ModelSnapshot[];
}
export interface FabricNode {
  node_id: string; status: 'online' | 'stale' | 'offline'; connected: boolean;
  last_seen: number; snapshot: NodeSnapshot;
}
export interface FabricState {
  schema_version: '1'; generated_at: number;
  summary: { online_nodes: number; total_nodes: number; logical_cpus: number;
    memory_total_bytes: number; memory_available_bytes: number; gpu_count: number;
    resident_models: number; available_models: number; prefix_candidates: number;
    active_requests: number };
  capabilities: { name: string; nodes: number; available_models: number; resident_models: number }[];
  nodes: FabricNode[]; jobs: FabricJob[];
}
export interface TaskRequest {
  capability: string; prompt: string; prefix?: string; model_id?: string;
  max_tokens?: number; temperature?: number; allow_simulated?: boolean;
}
export interface FabricJob {
  id: string; status: 'running' | 'succeeded' | 'failed' | 'expired';
  capability: string; node_id: string; model_id: string; runtime_id: string;
  created_at: number; completed_at?: number;
  placement_reason: string; result?: Record<string, unknown>; error?: string;
}
// REST: GET /api/fabric -> FabricState. POST /v1/tasks -> 202 FabricJob.
// GET /v1/tasks/:id -> FabricJob. Auth: Bearer token or HttpOnly fabric_session cookie.
// POST /api/session {token:string} -> {ok:true} sets cookie. DELETE clears it.
// Public agent docs: /.well-known/agent.json, /llms.txt, /openapi.json.
// WebSocket node bridge GET /v1/nodes/connect?node_id=...; Bearer FABRIC_TOKEN.
// Node -> cloud: {type:'heartbeat', snapshot:NodeSnapshot}; first message immediately.
// Cloud -> node: {type:'execute', job_id:string, request:ExecuteRequest}
// Node -> cloud: {type:'result', job_id:string, result:ExecuteResponse}
//            or {type:'result', job_id:string, error:string, status_code?:number}

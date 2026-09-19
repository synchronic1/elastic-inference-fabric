import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FabricJob,
  FabricNode,
  FabricState,
  TaskRequest,
} from "./contracts";
import { PRIMARY_MODELS } from "./model-catalog";
import AccessPanel, { AccessIntroduction } from "./AccessPanel";
import FabricTopology from "./FabricTopology";
import BenchDiagram from "./bench/BenchDiagram";
import WorkloadAccess from "./WorkloadAccess";
import ThemeToggle from "./ThemeToggle";
import FabricMark from "./FabricMark";
import NodeIdentity from "./NodeIdentity";
import FabricCopilot from "./FabricCopilot";
import AmbiguousPanel from "./AmbiguousPanel";

type RequestState = "loading" | "ready" | "error" | "auth";
const API = "/api/fabric";

function bytes(value: number) {
  if (!Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n >= 10 || unit === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[unit]}`;
}
function ago(time: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
function resultText(result?: Record<string, unknown>) {
  if (!result) return "";
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part && "text" in part
            ? String(part.text)
            : JSON.stringify(part),
      )
      .join("\n");
  return JSON.stringify(result, null, 2);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        (await response.text()) || `${response.status} ${response.statusText}`,
      ),
      { status: response.status },
    );
  return response.json() as Promise<T>;
}

function Status({ value }: { value: string }) {
  return <span className={`status ${value}`}>{value}</span>;
}

function NodeCard({ node }: { node: FabricNode }) {
  const s = node.snapshot;
  const gpu = s.hardware.gpus.length
    ? s.hardware.gpus.map((g) => g.name).join(", ")
    : "No GPU reported";
  const runtime = s.runtimes.find((r) => r.busy) ?? s.runtimes[0];
  return (
    <article className="node-card">
      <div className="node-heading">
        <div>
          <h3><NodeIdentity nodeId={node.node_id} /></h3>
          <p>
            {s.hardware.hostname} · {s.hardware.os}/{s.hardware.arch}
          </p>
        </div>
        <Status value={node.status} />
      </div>
      <div className="meter-row">
        <span>
          CPU <b>{s.hardware.logical_cpus} threads</b>
        </span>
        <span>{s.load.load_average?.[0]?.toFixed(2) ?? "—"} load</span>
      </div>
      <div className="bar">
        <i
          style={{
            width: `${Math.min(100, s.load.load_average ? (s.load.load_average[0] / Math.max(s.hardware.logical_cpus, 1)) * 100 : 0)}%`,
          }}
        />
      </div>
      <div className="meter-row">
        <span>
          Memory <b>{bytes(s.load.memory_available_bytes)} free</b>
        </span>
        <span>{s.load.memory_used_percent.toFixed(0)}%</span>
      </div>
      <div className="bar memory">
        <i style={{ width: `${s.load.memory_used_percent}%` }} />
      </div>
      <dl className="node-details">
        <div>
          <dt>GPU</dt>
          <dd>{gpu}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>
            {runtime
              ? `${runtime.kind} · ${runtime.state}${runtime.busy ? " · busy" : ""}`
              : "None reported"}
          </dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd>
            {s.models
              .filter((m) => m.resident)
              .map((m) => m.id)
              .join(", ") || "No resident model"}
          </dd>
        </div>
        <div>
          <dt>Cache</dt>
          <dd>
            {s.runtimes.reduce((n, r) => n + r.prefix_cache.length, 0)} prefix
            candidate(s)
          </dd>
        </div>
      </dl>
      <footer>
        <span>{s.execution_scope}</span>
        <span>seen {ago(node.last_seen)}</span>
      </footer>
    </article>
  );
}

export default function App() {
  const [fabric, setFabric] = useState<FabricState | null>(null);
  const [state, setState] = useState<RequestState>("loading");
  const [message, setMessage] = useState("Connecting to fabric control plane…");
  const [filter, setFilter] = useState("all");
  const [token, setToken] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [task, setTask] = useState({
    mode: "chat" as "chat" | "raw",
    capability: "",
    prompt: "",
    prefix: "",
    model_id: "",
    max_tokens: "512",
  });
  const [job, setJob] = useState<FabricJob | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // The bench reads rates, heartbeats and ages against a clock rather than the
  // wall, and the clock only advances on a successful read: an interrupted poll
  // must not age a snapshot the fabric never sent.
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api<FabricState>(API);
      setFabric(next);
      setNow(Date.now());
      setState("ready");
      setMessage(`Updated ${new Date(next.generated_at).toLocaleTimeString()}`);
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        setFabric(null);
        setJob(null);
        setState("auth");
        setMessage("A fabric access token is required.");
      } else {
        setState("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "Fabric could not be reached.",
        );
      }
    }
  }, []);
  useEffect(() => {
    refresh();
    timer.current = window.setInterval(refresh, 5000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [refresh]);
  useEffect(() => {
    if (fabric?.read_only || !job || !["running"].includes(job.status)) return;
    const id = window.setInterval(async () => {
      try {
        setJob(await api<FabricJob>(`/v1/tasks/${job.id}`));
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Task status unavailable");
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [job?.id, job?.status, fabric?.read_only]);

  const capabilities = fabric?.capabilities ?? [];
  const nodes = useMemo(
    () =>
      !fabric
        ? []
        : filter === "all"
          ? fabric.nodes
          : fabric.nodes.filter((n) =>
              n.snapshot.models.some((m) => m.capabilities.includes(filter)),
            ),
    [fabric, filter],
  );
  const primaryModels = useMemo(
    () =>
      PRIMARY_MODELS.map((model) => {
        const matches =
          fabric?.nodes
            .flatMap((node) =>
              node.snapshot.models.map((snapshot) => ({ node, snapshot })),
            )
            .filter(({ snapshot }) => snapshot.id === model.id) ?? [];
        const live = matches.find(
          ({ node, snapshot }) => node.status === "online" && snapshot.resident,
        );
        const cached = matches.find(
          ({ snapshot }) => snapshot.cached_on_disk || snapshot.available,
        );
        return {
          ...model,
          status: !fabric
            ? "Sign in to inspect"
            : live
              ? "Running"
              : cached
                ? "Cached"
                : "Not provisioned",
          detail: !fabric
            ? "Live inventory is protected"
            : live
              ? `Resident on ${live.node.node_id}`
              : cached
                ? "Present locally; not resident"
                : "No node reports this model",
        };
      }),
    [fabric],
  );
  async function login(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    setTokenBusy(true);
    setAuthError("");
    try {
      await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ token: token.trim() }),
      });
      setToken("");
      await refresh();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setTokenBusy(false);
    }
  }
  async function logout() {
    try {
      const response = await fetch("/api/session", { method: "DELETE", credentials: "include" });
      if (!response.ok && response.status !== 401) throw new Error("Sign-out failed. Please retry.");
      setFabric(null);
      setJob(null);
      setAuthError("");
      setState("auth");
      setMessage("Signed out of the fabric control plane.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-out failed");
    }
  }
  async function submitTask(event: FormEvent) {
    event.preventDefault();
    const maxTokens = Number(task.max_tokens);
    if (fabric?.read_only || !task.capability || !task.prompt.trim()
      || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) return;
    setTaskBusy(true);
    setJob(null);
    try {
      const body: TaskRequest = {
        capability: task.capability,
        ...(task.mode === "chat"
          ? { messages: [{ role: "user" as const, content: task.prompt }] }
          : { prompt: task.prompt, ...(task.prefix ? { prefix: task.prefix } : {}) }),
        ...(task.model_id ? { model_id: task.model_id } : {}),
        max_tokens: maxTokens,
      };
      setJob(
        await api<FabricJob>("/v1/tasks", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    } catch (e) {
      setJob({
        id: "request-error",
        status: "failed",
        capability: task.capability,
        node_id: "—",
        model_id: "—",
        runtime_id: "—",
        created_at: Date.now(),
        placement_reason: "Request was not placed",
        error: e instanceof Error ? e.message : "Task request failed",
      });
    } finally {
      setTaskBusy(false);
    }
  }
  const curl = [
    `curl -X POST ${window.location.origin}/v1/tasks \\`,
    '  -H "Authorization: Bearer $FABRIC_TOKEN" \\',
    "  -H 'Content-Type: application/json' \\",
    `  -d '${JSON.stringify(task.mode === "chat"
      ? { capability: task.capability || "complete", messages: [{ role: "user", content: "Hello fabric" }] }
      : { capability: task.capability || "complete", prompt: "Hello fabric" })}'`,
  ].join("\n");

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Elastic Inference Fabric home">
          <FabricMark />
          <span className="brand-wordmark">
            <strong>Elastic Inference</strong>
            <small>FABRIC</small>
          </span>
        </a>
        <nav className="account-nav" aria-label="Fabric account">
          <a href="#fabric-access">{fabric ? "Your session" : "Sign in"}</a>
          <a href="#access-tokens">Access tokens</a>
          <ThemeToggle />
        </nav>
        <div className="connection" aria-live="polite">
          <span className={`pulse ${state === "ready" ? "on" : ""}`} />
          {state === "ready" ? `Live · ${message}` : message}
          {fabric && (
            <button className="link-button" onClick={logout}>
              Sign out
            </button>
          )}
        </div>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">DISTRIBUTED INFERENCE CONTROL PLANE</p>
          <h1>Fabric overview</h1>
          <p className="subtitle">
            Observe available local capacity, route work deliberately, and keep
            inference where the hardware lives.
          </p>
        </div>
        <div className="public-links">
          <a href="#flow">Flow diagram</a>
          <a href="#ambiguous">Ambiguous coworker</a>
          <a href="/.well-known/agent.json">Agent manifest</a>
          <a href="/llms.txt">LLM guide</a>
          <a href="/openapi.json">OpenAPI</a>
        </div>
      </section>
      <div id="fabric-access">
      {!fabric ? (
        <section className="auth-panel" aria-labelledby="sign-in-heading">
          <div>
            <p className="eyebrow">FABRIC AUTHENTICATION</p>
            <h2 id="sign-in-heading">Sign in to Fabric</h2>
            <p>
              Use your viewer, agent, or administrator access token. Sign-in creates an
              HttpOnly session cookie; the raw token is not saved in browser storage.
            </p>
            <p><a href="#access-tokens">Need a token? See access-token setup ↓</a></p>
          </div>
          <form onSubmit={login} aria-label="Sign in to Fabric">
            <label htmlFor="fabric-token">
              Fabric access token
              <input
                id="fabric-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="current-password"
                aria-describedby={authError ? "sign-in-error" : undefined}
                required
              />
            </label>
            <button disabled={tokenBusy}>
              {tokenBusy ? "Signing in…" : "Sign in"}
            </button>
            {authError && <p id="sign-in-error" className="sign-in-error" role="alert">{authError}</p>}
          </form>
        </section>
      ) : <section className="session-banner" aria-label="Current session"><span>{fabric.read_only ? "Live demo · read-only viewer" : "Signed in to Fabric"}</span><a href="#access-tokens">View identity &amp; access →</a></section>}
      {state === "error" && (
        <section className="notice error" role="alert">
          <span>Control-plane connection failed: {message}</span>
          <button onClick={refresh}>Retry</button>
        </section>
      )}
      {state === "loading" && (
        <section className="notice">
          <span className="spinner" /> Loading fabric inventory…
        </section>
      )}
      </div>
      <FabricTopology
        fabric={fabric}
        live={state === "ready"}
        activeNodeId={job?.status === "running" ? job.node_id : undefined}
      />
      <BenchDiagram fabric={fabric} now={now} live={state === "ready"} />
      {fabric && !fabric.read_only && <FabricCopilot />}
      <AmbiguousPanel key={fabric ? "signed-in" : "public"} signedIn={Boolean(fabric)} jobs={fabric?.jobs ?? []} />
      <div id="access-tokens">
        {fabric ? <AccessPanel /> : <AccessIntroduction />}
      </div>
      <section className="model-roster" aria-labelledby="roster-heading">
        <div className="section-head">
          <div>
            <p className="eyebrow">PRIMARY LOCAL ROSTER</p>
            <h2 id="roster-heading">
              Five small models{" "}
              <small>
                {fabric
                  ? "status derives only from node reports"
                  : "sign in to inspect the live inventory"}
              </small>
            </h2>
          </div>
        </div>
        <div className="model-grid">
          {primaryModels.map((model) => (
            <article className="model-card" key={model.id}>
              <div>
                <h3>{model.name}</h3>
                <span
                  className={`model-state ${model.status.toLowerCase().replaceAll(" ", "-")}`}
                >
                  {model.status}
                </span>
              </div>
              <p>
                {model.parameters} · {model.role}
              </p>
              <div className="model-caps">
                {model.capabilities.map((capability) => (
                  <span key={capability}>{capability}</span>
                ))}
              </div>
              <small>{model.detail}</small>
              <a href={model.source_url} target="_blank" rel="noreferrer">
                Official model card ↗
              </a>
            </article>
          ))}
        </div>
      </section>
      {fabric && (
        <>
          <section className="metrics" aria-label="Fabric resources">
            <div>
              <span>Online nodes</span>
              <strong>
                {fabric.summary.online_nodes}
                <small> / {fabric.summary.total_nodes}</small>
              </strong>
            </div>
            <div>
              <span>CPU threads</span>
              <strong>{fabric.summary.logical_cpus}</strong>
            </div>
            <div>
              <span>Available memory</span>
              <strong>{bytes(fabric.summary.memory_available_bytes)}</strong>
              <small>of {bytes(fabric.summary.memory_total_bytes)}</small>
            </div>
            <div>
              <span>Resident models</span>
              <strong>
                {fabric.summary.resident_models}
                <small> / {fabric.summary.available_models}</small>
              </strong>
            </div>
            <div className="warm">
              <span>Prefix candidates</span>
              <strong>{fabric.summary.prefix_candidates}</strong>
              <small>local runtime only</small>
            </div>
          </section>
          <section className="section-head">
            <div>
              <p className="eyebrow">NODE INVENTORY</p>
              <h2>
                Compute fabric{" "}
                <small>
                  {fabric.summary.active_requests} active request(s)
                </small>
              </h2>
            </div>
            <div className="filters" aria-label="Filter nodes by capability">
              <button
                className={filter === "all" ? "selected" : ""}
                onClick={() => setFilter("all")}
              >
                All ({fabric.nodes.length})
              </button>
              {capabilities.map((c) => (
                <button
                  key={c.name}
                  className={filter === c.name ? "selected" : ""}
                  onClick={() => setFilter(c.name)}
                >
                  {c.name} ({c.nodes})
                </button>
              ))}
            </div>
          </section>
          {nodes.length ? (
            <section className="node-grid">
              {nodes.map((node) => (
                <NodeCard key={node.node_id} node={node} />
              ))}
            </section>
          ) : (
            <section className="empty">
              <h3>No nodes match this capability</h3>
              <p>Change the filter or wait for a capable node heartbeat.</p>
            </section>
          )}
          <WorkloadAccess readOnly={fabric.read_only === true}>
          <section className="agent-panel">
            <div className="agent-copy">
              <p className="eyebrow">AGENT-NATIVE DROP POINT</p>
              <h2>Dispatch a capability task</h2>
              <p>
                Each submission is an independent inference task, not a conversation.
                The model has no live web search. Requests pass through the cloud
                control plane; inference runs on the selected node.
              </p>
              <label className="discovery">
                Discovery URL{" "}
                <code>{window.location.origin}/.well-known/agent.json</code>
              </label>
              <button
                className="copy"
                onClick={() =>
                  navigator.clipboard?.writeText(curl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  })
                }
              >
                {copied ? "Copied curl" : "Copy curl example"}
              </button>
              <p className="template-note">
                Chat messages use the selected node’s model template. Raw mode
                sends exact <code>prefix + prompt</code> bytes for advanced clients.
              </p>
              <button
                type="button"
                className="template-button"
                onClick={() =>
                  setTask({
                    mode: "raw",
                    capability: "complete",
                    model_id: "qwen3-1.7b",
                    prefix:
                      "<|im_start|>system\nYou are a concise local assistant. /no_think\n<|im_end|>\n<|im_start|>user\n",
                    prompt:
                      "Explain fabric routing in one sentence.\n<|im_end|>\n<|im_start|>assistant\n",
                    max_tokens: "512",
                  })
                }
              >
                Load Qwen ChatML /no_think example
              </button>
            </div>
            <form className="task-form" onSubmit={submitTask}>
              <label>
                Input mode
                <select
                  value={task.mode}
                  onChange={(e) => setTask({ ...task, mode: e.target.value as "chat" | "raw" })}
                >
                  <option value="chat">One-shot chat task · model formats message</option>
                  <option value="raw">Raw completion · exact prompt bytes</option>
                </select>
              </label>
              <label>
                Capability
                <select
                  value={task.capability}
                  onChange={(e) =>
                    setTask({ ...task, capability: e.target.value })
                  }
                  required
                >
                  <option value="">Choose capability…</option>
                  {capabilities.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} · {c.available_models} available model(s)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {task.mode === "chat" ? "Task instruction" : "Raw prompt"}
                <textarea
                  value={task.prompt}
                  onChange={(e) => setTask({ ...task, prompt: e.target.value })}
                  placeholder="What should the selected local model do?"
                  required
                />
              </label>
              <div className="form-row">
                <label>
                  Output token limit
                  <input
                    type="number"
                    min="1"
                    max="4096"
                    value={task.max_tokens}
                    onChange={(e) => setTask({ ...task, max_tokens: e.target.value })}
                    required
                  />
                </label>
                {task.mode === "raw" && <label>
                  Prefix{" "}
                  <input
                    value={task.prefix}
                    onChange={(e) =>
                      setTask({ ...task, prefix: e.target.value })
                    }
                    placeholder="Optional reusable context"
                  />
                </label>}
                <label>
                  Model ID{" "}
                  <input
                    value={task.model_id}
                    onChange={(e) =>
                      setTask({ ...task, model_id: e.target.value })
                    }
                    placeholder="Optional"
                  />
                </label>
              </div>
              <button disabled={taskBusy || !capabilities.length}>
                {taskBusy ? "Routing…" : "Send task →"}
              </button>
            </form>
          </section>
          {job && (
            <section className={`job-result ${job.status}`} aria-live="polite">
              <div className="job-title">
                <div>
                  <p className="eyebrow">TASK {job.status.toUpperCase()}</p>
                  <h3>
                    {job.capability} <Status value={job.status} />
                  </h3>
                </div>
                <span>{ago(job.created_at)}</span>
              </div>
              <dl>
                <div>
                  <dt>Selected node</dt>
                  <dd>{job.node_id}</dd>
                </div>
                <div>
                  <dt>Model / runtime</dt>
                  <dd>
                    {job.model_id} · {job.runtime_id}
                  </dd>
                </div>
                <div className="wide">
                  <dt>Routing reason</dt>
                  <dd>{job.placement_reason}</dd>
                </div>
              </dl>
              {job.status === "running" && (
                <p className="working">
                  <span className="spinner" /> Waiting for local node result…
                </p>
              )}
              {job.error && <pre className="failure">{job.error}</pre>}
              {job.result && (resultText(job.result).trim()
                ? <pre>{resultText(job.result)}</pre>
                : !job.error && <p className="failure">The model returned no visible answer. Try a higher output token limit or another model.</p>)}
            </section>
          )}
          </WorkloadAccess>
        </>
      )}
    </main>
  );
}

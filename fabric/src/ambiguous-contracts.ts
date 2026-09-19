export interface AmbiguousHandoff {
  id: string;
  kind: 'task' | 'result';
  job_id: string | null;
  title: string;
  state: 'pending' | 'succeeded' | 'uncertain';
  created_at: number;
  task_id: string | null;
  task_status: string | null;
  checked_at: number | null;
  url: string | null;
}

export interface AmbiguousStatus {
  configured: boolean;
  connected: boolean;
  can_write: boolean;
  agent: string;
  workspace: string;
  project: string;
  error?: string;
  handoffs?: AmbiguousHandoff[];
}

export type AmbiguousHandoffInput = {
  operation_id: string;
  title: string;
} & ({ kind: 'task'; description: string } | { kind: 'result'; job_id: string });

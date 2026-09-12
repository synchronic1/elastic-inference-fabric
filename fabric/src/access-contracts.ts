export type FabricRole = 'admin' | 'agent' | 'node';

export interface FabricPrincipal {
  id: string;
  label: string;
  role: FabricRole;
  node_id: string | null;
  expires_at: number | null;
}

export interface FabricAccessToken extends FabricPrincipal {
  token_prefix: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface CreateFabricToken {
  label: string;
  role: FabricRole;
  node_id?: string;
  expires_in_days?: number;
}

export interface IssuedFabricToken {
  token: string;
  access: FabricAccessToken;
}

// GET /api/me -> {principal: FabricPrincipal}
// Admin only: GET /api/tokens -> {tokens: FabricAccessToken[]}
// POST /api/tokens CreateFabricToken -> IssuedFabricToken (secret returned once)
// DELETE /api/tokens/:id -> {ok:true}; revokes token and its sessions/connections.
// POST /api/session {token} -> {ok:true,principal}; opaque HttpOnly session cookie.

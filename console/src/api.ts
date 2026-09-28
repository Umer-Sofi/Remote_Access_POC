// Thin typed wrapper over the broker's REST API. The login cookie is httpOnly,
// so the browser attaches it automatically and JS never sees the token.

export type Scope = 'view' | 'control';
export type SessionState = 'REQUESTED' | 'CONSENT_PENDING' | 'APPROVED' | 'ACTIVE' | 'ENDED' | 'DENIED';

export interface Target {
  id: string;
  platform: 'mac' | 'win';
  hostname: string;
  version: string;
  busy: boolean;
  posture: { allowed: boolean; reason?: string };
}

export interface SessionStatus {
  id: string;
  state: SessionState;
  scope: Scope;
  target: string;
  operator: string;
  reason?: string;
  endReason?: string;
  reconsentPending?: boolean;
  recording?: boolean;
  livekitUrl?: string;
  token?: string;
}

export interface SessionRow {
  id: string; operator: string; target: string; reason: string | null; scope: string;
  state: string; recording_url: string | null; created_at: string; ended_at: string | null;
}

export interface AuditEntry { event: string; detail: Record<string, unknown>; at: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export const api = {
  me: () => call<{ username: string }>('GET', '/api/me'),
  login: (username: string, password: string) => call<{ username: string }>('POST', '/api/login', { username, password }),
  logout: () => call('POST', '/api/logout'),
  targets: () => call<{ targets: Target[]; bootstrap: string }>('GET', '/api/targets'),
  startSession: (targetId: string, reason: string, scope: Scope) =>
    call<{ sessionId: string }>('POST', '/api/sessions', { targetId, reason, scope }),
  session: (id: string) => call<SessionStatus>('GET', `/api/sessions/${id}`),
  setScope: (id: string, scope: Scope) => call<{ scope: Scope; reconsentPending: boolean }>('POST', `/api/sessions/${id}/scope`, { scope }),
  endSession: (id: string) => call('POST', `/api/sessions/${id}/end`),
  sessions: () => call<{ sessions: SessionRow[] }>('GET', '/api/sessions'),
  audit: (id: string) =>
    call<{ session: SessionRow; events: AuditEntry[]; input: { type: string; n: number }[] }>('GET', `/api/sessions/${id}/audit`),
  smokeToken: () => call<{ livekitUrl: string; token: string; room: string }>('POST', '/api/dev/smoke-token'),
};

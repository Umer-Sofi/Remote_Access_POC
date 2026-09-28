// Audit event writer. Every session state transition and consent decision goes
// through here (spec §8.3). The tables are append-only (enforced in init.sql).
import { db } from './db.js';

export type AuditEvent =
  | 'requested'
  | 'consent_shown'
  | 'consent_granted'
  | 'consent_denied'
  | 'token_issued'
  | 'recording_started'
  | 'connected'
  | 'control_granted'
  | 'scope_changed'
  | 'disconnected'
  | 'recording_stopped'
  | 'ended'
  // additions beyond the spec's list, useful when debugging a session:
  | 'recording_failed'
  | 'recording_disabled'
  | 'endpoint_state';

export interface SessionRow {
  id: string;
  operator: string;
  target: string;
  reason: string | null;
  scope: string;
  state: string;
  recording_url: string | null;
  created_at: string;
  ended_at: string | null;
}

export async function audit(sessionId: string, event: AuditEvent, detail: Record<string, unknown> = {}) {
  await db.query('INSERT INTO audit_events (session_id, event, detail) VALUES ($1, $2, $3)', [sessionId, event, detail]);
  console.log(`[audit] ${sessionId.slice(0, 8)} ${event} ${JSON.stringify(detail)}`);
}

export async function insertSession(s: { id: string; operator: string; target: string; reason: string; scope: string; state: string }) {
  await db.query('INSERT INTO sessions (id, operator, target, reason, scope, state) VALUES ($1,$2,$3,$4,$5,$6)', [
    s.id, s.operator, s.target, s.reason, s.scope, s.state,
  ]);
}

export async function updateSession(id: string, fields: Partial<Pick<SessionRow, 'state' | 'scope' | 'recording_url'>> & { ended?: boolean }) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ['state', 'scope', 'recording_url'] as const) {
    if (fields[k] !== undefined) {
      vals.push(fields[k]);
      sets.push(`${k} = $${vals.length}`);
    }
  }
  if (fields.ended) sets.push('ended_at = now()');
  if (!sets.length) return;
  vals.push(id);
  await db.query(`UPDATE sessions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
}

export async function listSessions(limit = 50): Promise<SessionRow[]> {
  const r = await db.query('SELECT * FROM sessions ORDER BY created_at DESC LIMIT $1', [limit]);
  return r.rows;
}

export async function getSessionRow(id: string): Promise<SessionRow | undefined> {
  const r = await db.query('SELECT * FROM sessions WHERE id = $1', [id]);
  return r.rows[0];
}

export async function listAudit(sessionId: string) {
  const r = await db.query('SELECT event, detail, at FROM audit_events WHERE session_id = $1 ORDER BY id', [sessionId]);
  return r.rows;
}

export async function inputStats(sessionId: string) {
  const r = await db.query(
    `SELECT msg->>'t' AS type, count(*)::int AS n FROM input_events WHERE session_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
    [sessionId],
  );
  return r.rows as { type: string; n: number }[];
}

// ---- operator input log (spec §12.2) -------------------------------------------
// Messages arrive at up to ~60/s per session, so they are buffered and written in
// one multi-row INSERT per second instead of one round trip each.
type InputRow = { sessionId: string; sender: string; msg: unknown; at: Date };
let pending: InputRow[] = [];

export function logInput(sessionId: string, sender: string, msg: unknown) {
  pending.push({ sessionId, sender, msg, at: new Date() });
}

export async function flushInput() {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  const vals: unknown[] = [];
  const rows = batch.map((r, i) => {
    vals.push(r.sessionId, r.sender, JSON.stringify(r.msg), r.at);
    return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
  });
  try {
    await db.query(`INSERT INTO input_events (session_id, sender, msg, at) VALUES ${rows.join(',')}`, vals);
  } catch (err) {
    console.error('[audit] failed to write input batch', err);
  }
}

setInterval(() => void flushInput(), 1000).unref();

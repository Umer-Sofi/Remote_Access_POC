// Session lifecycle + state machine (spec §8.1).
//
//   REQUESTED → CONSENT_PENDING → APPROVED → ACTIVE → ENDED
//                      │
//                      └──────────── DENIED (terminal)
//
// Invariants enforced here:
//  * No LiveKit token for anyone before the user clicked Allow (state APPROVED).
//  * The room (and therefore recording) exists before any token is issued.
//  * Every transition and consent decision writes an audit_events row.
//  * If REQUIRE_RECORDING and egress has not started shortly after the target
//    publishes video, the session is ended: no unrecorded sessions.
import { randomUUID } from 'node:crypto';
import type { WebhookEvent } from 'livekit-server-sdk';
import { audit, insertSession, updateSession, type AuditEvent } from './audit.js';
import { config } from './config.js';
import { db } from './db.js';
import { getEndpoint, markBusy, sendToEndpoint, setEndpointHandlers } from './endpoints.js';
import { AuditTap, createRecordedRoom, deleteRoom, roomName } from './livekit.js';
import { providers } from './providers/index.js';
import { endpointIdentity, endpointToken, operatorIdentity, operatorToken, TAP_IDENTITY } from './tokens.js';

export type State = 'REQUESTED' | 'CONSENT_PENDING' | 'APPROVED' | 'ACTIVE' | 'ENDED' | 'DENIED';
export type Scope = 'view' | 'control';

const TRANSITIONS: Record<State, State[]> = {
  REQUESTED: ['CONSENT_PENDING', 'DENIED', 'ENDED'],
  CONSENT_PENDING: ['APPROVED', 'DENIED', 'ENDED'],
  APPROVED: ['ACTIVE', 'ENDED'],
  ACTIVE: ['ENDED'],
  ENDED: [],
  DENIED: [],
};
const TERMINAL: State[] = ['ENDED', 'DENIED'];

interface Session {
  id: string;
  operator: string;
  targetId: string;
  reason: string;
  scope: Scope;
  state: State;
  room: string;
  endReason?: string;
  reconsentPending: boolean; // view → control upgrade awaiting the user's Allow
  recordingStarted: boolean;
  recordingFiles: string[];
  timers: NodeJS.Timeout[];
  tap?: AuditTap;
}

export class SessionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const sessions = new Map<string, Session>();
const byRoom = new Map<string, Session>();

export function getSession(id: string) {
  return sessions.get(id);
}

async function transition(s: Session, to: State, event: AuditEvent, detail: Record<string, unknown> = {}) {
  if (!TRANSITIONS[s.state].includes(to)) {
    throw new Error(`illegal transition ${s.state} → ${to} for session ${s.id}`);
  }
  const from = s.state;
  s.state = to;
  await updateSession(s.id, { state: to, ended: TERMINAL.includes(to) });
  await audit(s.id, event, { from, to, ...detail });
}

// ---- operator-initiated ------------------------------------------------------

export async function requestSession(operator: string, targetId: string, reason: string, scope: Scope) {
  const ep = getEndpoint(targetId);
  if (!ep) throw new SessionError(404, 'target is not online');
  if (ep.sessionId) throw new SessionError(409, 'target already has a session in progress');
  const posture = await providers.posture.check(targetId);
  if (!posture.allowed) throw new SessionError(403, posture.reason ?? 'posture check failed');

  const id = randomUUID();
  const s: Session = {
    id, operator, targetId, reason, scope, state: 'REQUESTED', room: roomName(id),
    reconsentPending: false, recordingStarted: false, recordingFiles: [], timers: [],
  };
  sessions.set(id, s);
  byRoom.set(s.room, s);
  markBusy(targetId, id);

  await insertSession({ id, operator, target: targetId, reason, scope, state: 'REQUESTED' });
  await audit(id, 'requested', {
    operator, target: targetId, platform: ep.platform, reason, scope,
    lifecycle: providers.lifecycle.mode(), privilege: providers.privilege.context(),
  });

  sendToEndpoint(targetId, { type: 'session.request', sessionId: id, operator, reason, scope });
  await transition(s, 'CONSENT_PENDING', 'consent_shown', { stage: 'sent_to_endpoint' });

  // Server-side backstop: if the endpoint never answers, treat it as deny.
  s.timers.push(setTimeout(() => {
    if (s.state === 'CONSENT_PENDING') void deny(s, 'timeout');
  }, config.consentTimeoutS * 1000));
  return s;
}

/** Operator token is minted fresh on every poll once approved, so page reloads can rejoin. */
export async function sessionStatus(id: string, operator: string) {
  const s = sessions.get(id);
  if (!s) return undefined;
  const live = s.state === 'APPROVED' || s.state === 'ACTIVE';
  const base = {
    id: s.id, state: s.state, scope: s.scope, target: s.targetId, operator: s.operator,
    reason: s.reason, room: s.room, endReason: s.endReason, reconsentPending: s.reconsentPending,
    recording: s.recordingStarted,
  };
  if (!live || s.operator !== operator) return base;
  const token = await operatorToken(s.room, operator);
  return { ...base, livekitUrl: config.livekit.publicUrl, token };
}

export async function setScope(id: string, operator: string, scope: Scope) {
  const s = sessions.get(id);
  if (!s || s.operator !== operator) throw new SessionError(404, 'no such session');
  if (s.state !== 'ACTIVE' && s.state !== 'APPROVED') throw new SessionError(409, `session is ${s.state}`);
  if (scope === s.scope) return s;

  if (scope === 'view') {
    // Downgrade: always allowed, applied immediately.
    s.scope = 'view';
    s.reconsentPending = false;
    await updateSession(s.id, { scope });
    await audit(s.id, 'scope_changed', { to: 'view', by: operator });
    sendToEndpoint(s.targetId, { type: 'session.scope', sessionId: s.id, scope: 'view' });
  } else {
    // Upgrade: re-consent through the endpoint user (spec §8.2 "scope change triggers re-consent").
    s.reconsentPending = true;
    await audit(s.id, 'scope_changed', { to: 'control', by: operator, status: 'awaiting_consent' });
    sendToEndpoint(s.targetId, {
      type: 'session.request', sessionId: s.id, operator, reason: s.reason, scope: 'control',
    });
  }
  return s;
}

export async function endSession(id: string, reason: string, by: string) {
  const s = sessions.get(id);
  if (!s || TERMINAL.includes(s.state)) return;
  s.endReason = reason;
  s.timers.forEach(clearTimeout);
  await transition(s, 'ENDED', 'ended', { reason, by });
  sendToEndpoint(s.targetId, { type: 'session.end', sessionId: s.id, reason });
  markBusy(s.targetId, undefined);
  await s.tap?.stop();
  // Deleting the room stops the auto egress; its egress_ended webhook then
  // records recording_stopped and the recording_url.
  await deleteRoom(s.room);
  scheduleForget(s);
}

// ---- endpoint-initiated ------------------------------------------------------

async function deny(s: Session, why: string) {
  s.timers.forEach(clearTimeout);
  await transition(s, 'DENIED', 'consent_denied', { why });
  sendToEndpoint(s.targetId, { type: 'session.end', sessionId: s.id, reason: 'denied' });
  markBusy(s.targetId, undefined);
  scheduleForget(s);
}

async function approve(s: Session) {
  s.timers.forEach(clearTimeout);
  s.timers = [];
  // 1. Room with recording attached must exist BEFORE anyone can hold a token.
  try {
    await createRecordedRoom(s.id);
  } catch (err) {
    await audit(s.id, 'recording_failed', { stage: 'create_room', error: String(err) });
    await transition(s, 'APPROVED', 'consent_granted', { scope: s.scope });
    return endSession(s.id, 'room_creation_failed', 'broker');
  }
  await transition(s, 'APPROVED', 'consent_granted', { scope: s.scope });
  if (config.recordingMode === 'none') {
    // Make the absence of a recording explicit in the trail, not an unexplained gap.
    await audit(s.id, 'recording_disabled', { mode: 'none' });
  }

  // 2. Hidden audit tap joins first so it sees every input message.
  s.tap = new AuditTap(s.id, s.room, operatorIdentity(s.operator));
  try {
    await s.tap.start();
  } catch (err) {
    console.error('[tap] failed to join', err);
    await audit(s.id, 'recording_failed', { stage: 'audit_tap', error: String(err) });
    if (config.requireRecording) return endSession(s.id, 'audit_tap_failed', 'broker');
  }

  // 3. Endpoint token → endpoint. Operator gets theirs by polling GET /api/sessions/:id.
  const token = await endpointToken(s.room, s.targetId);
  await audit(s.id, 'token_issued', { to: endpointIdentity(s.targetId), ttl_s: config.tokenTtlS });
  sendToEndpoint(s.targetId, { type: 'session.token', sessionId: s.id, livekitUrl: config.livekit.publicUrl, token, room: s.room });
  sendToEndpoint(s.targetId, { type: 'session.scope', sessionId: s.id, scope: s.scope });
}

async function onEndpointMessage(targetId: string, msg: { type: string; [k: string]: unknown }) {
  const s = typeof msg.sessionId === 'string' ? sessions.get(msg.sessionId) : undefined;
  // An endpoint may only speak for the session addressed to it.
  if (!s || s.targetId !== targetId) return;

  switch (msg.type) {
    case 'consent.result': {
      const allow = msg.decision === 'allow';
      if (s.state === 'CONSENT_PENDING') {
        return allow ? approve(s) : deny(s, 'user_denied');
      }
      if (s.reconsentPending && (s.state === 'ACTIVE' || s.state === 'APPROVED')) {
        s.reconsentPending = false;
        if (allow) {
          s.scope = 'control';
          await updateSession(s.id, { scope: 'control' });
          await audit(s.id, 'consent_granted', { reconsent: true, scope: 'control' });
          await audit(s.id, 'control_granted', { operator: s.operator });
          sendToEndpoint(s.targetId, { type: 'session.scope', sessionId: s.id, scope: 'control' });
        } else {
          await audit(s.id, 'consent_denied', { reconsent: true, scope: 'control', why: 'user_denied' });
        }
      }
      return;
    }
    case 'session.state': {
      const state = String(msg.state);
      if (state === 'heartbeat') return;
      if (state === 'consent_shown') return audit(s.id, 'consent_shown', { stage: 'displayed_to_user' });
      if (state === 'ended') return endSession(s.id, 'ended_by_user', `endpoint:${targetId}`);
      if (state === 'streaming' && s.state === 'APPROVED') return activate(s, 'endpoint_report');
      return audit(s.id, 'endpoint_state', { state, detail: msg.detail ?? null });
    }
  }
}

async function activate(s: Session, source: string) {
  if (s.state !== 'APPROVED') return;
  await transition(s, 'ACTIVE', 'connected', { participant: endpointIdentity(s.targetId), source });
  if (s.scope === 'control') await audit(s.id, 'control_granted', { operator: s.operator });
  if (config.requireRecording && !s.recordingStarted) {
    s.timers.push(setTimeout(() => {
      if (!s.recordingStarted && s.state === 'ACTIVE') {
        void audit(s.id, 'recording_failed', { stage: 'egress_not_started' })
          .then(() => endSession(s.id, 'recording_not_started', 'broker'));
      }
    }, config.recordingGraceS * 1000));
  }
}

// ---- LiveKit webhooks: what the SFU itself observed ---------------------------

export async function onLivekitEvent(ev: WebhookEvent) {
  const name = ev.room?.name ?? ev.egressInfo?.roomName;
  const s = name ? byRoom.get(name) : undefined;
  if (!s) return;
  const identity = ev.participant?.identity;

  switch (ev.event) {
    case 'participant_joined':
      if (identity === TAP_IDENTITY) return;
      if (identity !== endpointIdentity(s.targetId)) await audit(s.id, 'connected', { participant: identity, source: 'sfu' });
      return;
    case 'participant_left':
      if (identity === TAP_IDENTITY) return;
      await audit(s.id, 'disconnected', { participant: identity, source: 'sfu' });
      if (identity === endpointIdentity(s.targetId)) await endSession(s.id, 'endpoint_left_room', 'sfu');
      return;
    case 'track_published':
      if (identity === endpointIdentity(s.targetId)) await activate(s, 'sfu_track_published');
      return;
    case 'egress_started':
      s.recordingStarted = true;
      await audit(s.id, 'recording_started', { egressId: ev.egressInfo?.egressId });
      return;
    case 'egress_ended': {
      const info = ev.egressInfo!;
      const files = [
        ...info.fileResults.map((f) => f.filename),
        ...(info.result?.case === 'file' ? [info.result.value.filename] : []),
      ].filter(Boolean);
      const urls = [...new Set(files)].map(toRecordingUrl);
      s.recordingFiles.push(...urls);
      await audit(s.id, 'recording_stopped', {
        egressId: info.egressId, status: info.status, error: info.error || undefined, files: urls,
      });
      if (urls.length) await updateSession(s.id, { recording_url: s.recordingFiles.join(' ') });
      if (info.error && config.requireRecording && !TERMINAL.includes(s.state)) {
        await audit(s.id, 'recording_failed', { stage: 'egress_ended', error: info.error });
        await endSession(s.id, 'recording_failed', 'broker');
      }
      return;
    }
  }
}

/** Egress writes /out/sess-…/file.webm; the broker serves the same volume under /api/recordings/. */
function toRecordingUrl(file: string) {
  const rel = file.startsWith(config.egressOutDir + '/') ? file.slice(config.egressOutDir.length + 1) : file;
  return `/api/recordings/${rel}`;
}

// Keep finished sessions in memory a while so late webhooks (egress_ended arrives
// seconds after the room is deleted) still find them.
function scheduleForget(s: Session) {
  setTimeout(() => {
    sessions.delete(s.id);
    byRoom.delete(s.room);
  }, 10 * 60_000).unref();
}

// ---- wiring ------------------------------------------------------------------

setEndpointHandlers({
  onMessage: (targetId, msg) => {
    onEndpointMessage(targetId, msg).catch((err) => console.error('[session] endpoint message failed', err));
  },
  onDisconnect: (targetId) => {
    for (const s of sessions.values()) {
      if (s.targetId === targetId && !TERMINAL.includes(s.state)) {
        void endSession(s.id, 'endpoint_link_lost', 'broker');
      }
    }
  },
});

/** After a broker restart, in-memory state is gone: close out anything the DB still thinks is live. */
export async function recoverAfterRestart() {
  const r = await db.query(`SELECT id FROM sessions WHERE state NOT IN ('ENDED','DENIED')`);
  for (const { id } of r.rows) {
    await db.query(`UPDATE sessions SET state = 'ENDED', ended_at = now() WHERE id = $1`, [id]);
    await audit(id, 'ended', { reason: 'broker_restart', by: 'broker' });
    await deleteRoom(roomName(id));
  }
}

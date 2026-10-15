// Endpoint control link (spec §8.1 "WebSocket (endpoint side)"). Each endpoint
// client opens ONE outbound WebSocket to the broker and keeps it open; that is how
// the broker reaches a target without any inbound port on it. This module owns
// the registry of connected targets and message framing; session logic lives in
// sessions.ts and is plugged in via setEndpointHandlers() to avoid an import cycle.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { verifyDevice } from './devices.js';

export interface EndpointInfo {
  targetId: string;
  platform: 'mac' | 'win';
  hostname: string;
  version: string;
  connectedAt: Date;
  sessionId?: string; // set while a session is in progress (one at a time per target)
}

interface Conn extends EndpointInfo {
  ws: WebSocket;
  alive: boolean;
}

type Msg = { type: string; [k: string]: unknown };

interface Handlers {
  onMessage(targetId: string, msg: Msg): void;
  onDisconnect(targetId: string): void;
}

const conns = new Map<string, Conn>();
let handlers: Handlers = { onMessage() {}, onDisconnect() {} };

export function setEndpointHandlers(h: Handlers) {
  handlers = h;
}

export function listEndpoints(): EndpointInfo[] {
  return [...conns.values()].map(({ ws: _ws, alive: _a, ...info }) => info);
}

export function getEndpoint(targetId: string): EndpointInfo | undefined {
  return conns.get(targetId);
}

export function sendToEndpoint(targetId: string, msg: Msg): boolean {
  const c = conns.get(targetId);
  if (!c || c.ws.readyState !== WebSocket.OPEN) return false;
  c.ws.send(JSON.stringify(msg));
  return true;
}

export function attachEndpointServer(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let conn: Conn | undefined;
    // The first frame must be a valid `hello` within 10 s, otherwise drop.
    const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 10_000);

    let authing = false; // a hello is being verified against the database; ignore frames until it finishes

    ws.on('message', (raw) => {
      let msg: Msg;
      try {
        msg = JSON.parse(raw.toString());
        if (typeof msg?.type !== 'string') throw new Error();
      } catch {
        return; // ignore malformed frames
      }

      if (!conn) {
        if (authing) return;
        if (msg.type !== 'hello') return void ws.close(4001, 'expected hello');
        authing = true;
        void authenticate(msg).then((ok) => {
          if (!ok || ws.readyState !== WebSocket.OPEN) {
            console.warn(`[endpoint] rejected hello from ${req.socket.remoteAddress} (${String(msg.targetId ?? '') || 'no id'})`);
            // An enrolled client whose device credential is rejected (revoked / removed)
            // is told to forget it, so it stops retrying and can re-enroll with a new invite.
            if (typeof msg.deviceToken === 'string' && msg.deviceToken) {
              try { ws.send(JSON.stringify({ type: 'revoked', reason: 'credential no longer valid' })); } catch { /* ignore */ }
              return void ws.close(4003, 'revoked');
            }
            return void ws.close(4001, 'unauthorized');
          }
          clearTimeout(helloTimer);
          const targetId = String(msg.targetId);
          const platform = msg.platform as 'mac' | 'win';
          // A re-launched client replaces a stale link for the same target.
          conns.get(targetId)?.ws.close(4002, 'replaced by new connection');
          conn = {
            ws, alive: true, targetId, platform,
            hostname: String(msg.hostname ?? targetId),
            version: String(msg.version ?? '?'),
            connectedAt: new Date(),
          };
          conns.set(targetId, conn);
          ws.send(JSON.stringify({ type: 'hello.ok', targetId }));
          console.log(`[endpoint] ${targetId} (${platform}, ${conn.hostname}) connected`);
        }).catch((err) => {
          console.error('[endpoint] hello check failed', err);
          ws.close(1011, 'server error');
        });
        return;
      }
      handlers.onMessage(conn.targetId, msg);
    });

    ws.on('pong', () => { if (conn) conn.alive = true; });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      // Only unregister if this socket is still the current one for the target.
      if (conn && conns.get(conn.targetId)?.ws === ws) {
        conns.delete(conn.targetId);
        console.log(`[endpoint] ${conn.targetId} disconnected`);
        handlers.onDisconnect(conn.targetId);
      }
    });
  });

  // Liveness: ping every 10 s; a link that misses a pong is terminated, which ends
  // its session (a frozen endpoint must not leave a session "active").
  setInterval(() => {
    for (const c of conns.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, 10_000).unref();
}

/**
 * Valid when the frame carries either an enrolled device's credential (bound to this exact
 * target id) or the shared ENDPOINT_SECRET (fake endpoint, e2e test, manually configured clients).
 */
async function authenticate(msg: Msg): Promise<boolean> {
  const targetId = String(msg.targetId ?? '');
  const platform = msg.platform === 'mac' || msg.platform === 'win';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(targetId) || !platform) return false;
  if (typeof msg.deviceToken === 'string' && msg.deviceToken) return verifyDevice(msg.deviceToken, targetId);
  return secretOk(String(msg.secret ?? ''));
}

/** Close a target's control link because its device credential was revoked. Tell the
 *  client first (so it clears its saved enrollment), then close with the revoked code. */
export function disconnectEndpoint(targetId: string, reason: string) {
  const c = conns.get(targetId);
  if (!c) return;
  try { c.ws.send(JSON.stringify({ type: 'revoked', reason })); } catch { /* ignore */ }
  c.ws.close(4003, reason);
}

export function markBusy(targetId: string, sessionId: string | undefined) {
  const c = conns.get(targetId);
  if (c) c.sessionId = sessionId;
}

function secretOk(given: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(config.endpointSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

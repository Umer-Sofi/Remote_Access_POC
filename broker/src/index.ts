// Broker bootstrap: REST API for the operator console, WebSocket for endpoint
// clients, LiveKit webhook receiver, and static hosting of the built console.
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { flushInput, getSessionRow, inputStats, listAudit, listSessions } from './audit.js';
import { config } from './config.js';
import { waitForDb } from './db.js';
import { attachEndpointServer, listEndpoints } from './endpoints.js';
import { smokeRoom, verifyWebhook } from './livekit.js';
import { providers, type Identity } from './providers/index.js';
import {
  endSession, onLivekitEvent, recoverAfterRestart, requestSession, sessionStatus, SessionError, setScope, type Scope,
} from './sessions.js';
import { smokeToken } from './tokens.js';

const COOKIE = 'ra_session';
const app = express();
app.disable('x-powered-by');
app.use(cookieParser());

// ---- LiveKit webhook (needs the raw body to verify the signature) --------------
app.post('/livekit/webhook', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const ev = await verifyWebhook(req.body, req.get('Authorization'));
    await onLivekitEvent(ev);
    res.sendStatus(200);
  } catch (err) {
    console.warn('[webhook] rejected', (err as Error).message);
    res.sendStatus(401);
  }
});

app.use(express.json({ limit: '32kb' }));

// ---- auth ----------------------------------------------------------------------
type AuthedRequest = Request & { operator: Identity };

async function requireOperator(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE] ?? req.get('Authorization')?.replace(/^Bearer /, '');
  try {
    if (!token) throw new Error('no token');
    (req as AuthedRequest).operator = await providers.identity.resolve(token);
    next();
  } catch {
    res.status(401).json({ error: 'not logged in' });
  }
}

const who = (req: Request) => (req as AuthedRequest).operator.username;

// Express 5 forwards rejected promises to the error handler, so handlers can be async.
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const token = await providers.identity.login(String(username ?? ''), String(password ?? ''));
  if (!token) return void res.status(401).json({ error: 'invalid credentials' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 8 * 3600_000 });
  res.json({ username });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie(COOKIE).json({ ok: true });
});

app.get('/api/me', requireOperator, (req, res) => {
  res.json((req as AuthedRequest).operator);
});

// ---- targets + sessions ----------------------------------------------------------
app.get('/api/targets', requireOperator, async (_req, res) => {
  const targets = await Promise.all(listEndpoints().map(async (e) => ({
    id: e.targetId,
    platform: e.platform,
    hostname: e.hostname,
    version: e.version,
    connectedAt: e.connectedAt,
    busy: !!e.sessionId,
    posture: await providers.posture.check(e.targetId),
  })));
  res.json({ targets, bootstrap: providers.bootstrap.instructions() });
});

app.post('/api/sessions', requireOperator, async (req, res) => {
  const { targetId, reason, scope } = req.body ?? {};
  const s = await requestSession(
    who(req),
    String(targetId ?? ''),
    String(reason ?? '').slice(0, 500),
    scope === 'view' ? 'view' : 'control',
  );
  res.status(201).json({ sessionId: s.id, state: s.state });
});

app.get('/api/sessions', requireOperator, async (_req, res) => {
  res.json({ sessions: await listSessions() });
});

app.get('/api/sessions/:id', requireOperator, async (req, res) => {
  const id = String(req.params.id);
  const live = await sessionStatus(id, who(req));
  if (live) return void res.json(live);
  const row = await getSessionRow(id).catch(() => undefined);
  if (!row) return void res.status(404).json({ error: 'no such session' });
  res.json({ id: row.id, state: row.state, scope: row.scope, target: row.target, operator: row.operator });
});

app.get('/api/sessions/:id/audit', requireOperator, async (req, res) => {
  const id = String(req.params.id);
  const session = await getSessionRow(id).catch(() => undefined);
  if (!session) return void res.status(404).json({ error: 'no such session' });
  res.json({ session, events: await listAudit(id), input: await inputStats(id) });
});

app.post('/api/sessions/:id/scope', requireOperator, async (req, res) => {
  const scope: Scope = req.body?.scope === 'view' ? 'view' : 'control';
  const s = await setScope(String(req.params.id), who(req), scope);
  res.json({ scope: s.scope, reconsentPending: s.reconsentPending });
});

app.post('/api/sessions/:id/end', requireOperator, async (req, res) => {
  await endSession(String(req.params.id), 'ended_by_operator', `operator:${who(req)}`);
  res.json({ ok: true });
});

// ---- recordings (operators only; path-traversal safe) ----------------------------
app.get('/api/recordings/*path', requireOperator, (req, res) => {
  const rel = normalize(([] as string[]).concat(req.params.path as string | string[]).join('/'));
  if (rel.startsWith('..') || rel.includes('\0')) return void res.sendStatus(400);
  res.sendFile(join(config.recordingsDir, rel), (err) => { if (err && !res.headersSent) res.sendStatus(404); });
});

// ---- M1 smoke test: two browser tabs share a screen through the SFU ---------------
app.post('/api/dev/smoke-token', requireOperator, async (req, res) => {
  const room = 'smoke-test';
  await smokeRoom(room);
  const identity = `smoke:${who(req)}:${Math.random().toString(36).slice(2, 6)}`;
  res.json({ livekitUrl: config.livekit.publicUrl, token: await smokeToken(room, identity), room });
});

app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

// ---- operator console (built SPA) ------------------------------------------------
if (existsSync(config.consoleDir)) {
  app.use(express.static(config.consoleDir));
  app.get('/{*spa}', (_req, res) => res.sendFile(join(config.consoleDir, 'index.html')));
} else {
  console.warn(`[broker] console build not found at ${config.consoleDir}; run the Vite dev server instead`);
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SessionError) return void res.status(err.status).json({ error: err.message });
  console.error('[broker] unhandled', err);
  res.status(500).json({ error: 'internal error' });
});

// ---- boot --------------------------------------------------------------------------
await waitForDb();
await recoverAfterRestart();

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
attachEndpointServer(wss);
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] !== '/ws/endpoint') return void socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(config.port, () => console.log(`[broker] listening on :${config.port}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await flushInput();
    process.exit(0);
  });
}

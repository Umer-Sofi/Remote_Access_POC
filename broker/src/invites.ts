// Invite-link onboarding (Phase 2).
//
//   operator creates invite ──▶ https://broker/join/<token> ──(sent by Teams, mail, …)──▶ user
//   user opens page ──▶ downloads the generic client ──▶ opens it ──▶ clicks "Connect"
//   remoteaccess://enroll?token=…&server=… ──▶ client POST /api/enroll ──▶ per-device credential
//
// Rules this file enforces:
//  * The token is shown to the operator once; only its hash is stored.
//  * Opening the page does NOT use up the token (Teams/Outlook link previews fetch URLs).
//    Only a successful POST /api/enroll does, atomically, so a link works for exactly one computer.
//  * Links expire (default 24 h, max 7 days) and can be revoked until used.
//  * Enrolling never starts a session. The operator still requests one and the user still clicks Allow.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { newSecret, sha256 } from './devices.js';
import { disconnectEndpoint, getEndpoint } from './endpoints.js';

const GENERIC_FILES = { mac: 'RemoteAccessEndpoint-mac-generic.zip', win: 'remote-access-endpoint-win-generic.zip' } as const;
type Platform = keyof typeof GENERIC_FILES;
const isPlatform = (p: unknown): p is Platform => typeof p === 'string' && Object.hasOwn(GENERIC_FILES, p);
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

async function inviteEvent(inviteId: string | null, event: string, detail: Record<string, unknown> = {}) {
  await db.query('INSERT INTO invite_events (invite_id, event, detail) VALUES ($1, $2, $3)', [inviteId, event, detail]);
  console.log(`[invite] ${inviteId?.slice(0, 8) ?? '-'} ${event} ${JSON.stringify(detail)}`);
}

const STATUS_SQL = `CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.enrolled_at IS NOT NULL THEN 'enrolled'
  WHEN i.expires_at < now() THEN 'expired' WHEN i.opened_at IS NOT NULL THEN 'opened' ELSE 'pending' END`;

/** A token that can still be used: exists, not revoked, not enrolled, not expired. */
async function usableInvite(token: string) {
  if (!TOKEN_RE.test(token)) return undefined;
  const r = await db.query(
    `SELECT id, created_by, note, base_url FROM invites i
     WHERE token_hash = $1 AND revoked_at IS NULL AND enrolled_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  return r.rows[0] as { id: string; created_by: string; note: string | null; base_url: string } | undefined;
}

// Tiny in-memory limiter for the unauthenticated routes (per client IP, per minute).
const hits = new Map<string, number[]>();
function limit(max: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${req.path.split('/')[1]}:${req.ip}`;
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= max) return void res.status(429).json({ error: 'too many requests, try again in a minute' });
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
setInterval(() => hits.clear(), 10 * 60_000).unref();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function joinPage(token: string, inv: { created_by: string; note: string | null; base_url: string }) {
  const deepLink = `remoteaccess://enroll?token=${token}&server=${encodeURIComponent(inv.base_url)}`;
  const dl = (p: Platform) => `/join/${token}/download/${p}`;
  const macInstall = `mv ~/Downloads/RemoteAccessEndpoint.app /Applications/
xattr -dr com.apple.quarantine /Applications/RemoteAccessEndpoint.app
open /Applications/RemoteAccessEndpoint.app`;
  const macRestart = `pkill -f RemoteAccessEndpoint
open /Applications/RemoteAccessEndpoint.app`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect this computer</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fa;--fg:#17212b;--muted:#5a6773;--panel:#fff;--line:#c9d2dc;--accent:#1d5fd1;--code:#0d1b2a;--codefg:#dce7f2}
@media (prefers-color-scheme:dark){:root{--bg:#0e141a;--fg:#e6ebf0;--muted:#93a1ae;--panel:#161e26;--line:#2d3945;--accent:#6ea2ff;--code:#05090d;--codefg:#d6e2ee}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{max-width:580px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
h1{font-size:24px;margin:0}h2{font-size:15px;margin:0}p{margin:0}.muted{color:var(--muted);font-size:14px}
[hidden]{display:none!important}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}
.tabs{display:flex;gap:8px}
.tab{flex:1;text-align:center;padding:11px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:9px;cursor:pointer;font:inherit}
.tab.active{border-color:var(--accent);color:var(--accent);font-weight:600;background:color-mix(in srgb,var(--accent) 10%,transparent)}
a.btn{font:inherit;display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;text-decoration:none;cursor:pointer;align-self:flex-start}
pre{position:relative;background:var(--code);color:var(--codefg);border:1px solid var(--line);border-radius:8px;padding:12px 56px 12px 12px;margin:0;overflow-x:auto;font:12.5px/1.6 ui-monospace,Menlo,monospace;white-space:pre}
.copy{position:absolute;top:7px;right:7px;font:11px system-ui;padding:3px 9px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:6px;cursor:pointer}
input{width:100%;box-sizing:border-box;font:12.5px ui-monospace,Menlo,monospace;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.step{display:flex;gap:10px}.num{flex:none;width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:700}
</style></head><body><main>
<h1>Connect this computer</h1>
<p class="muted"><b style="color:var(--fg)">${esc(inv.created_by)}</b> sent you this link so they can request remote access to your computer${inv.note ? ` (${esc(inv.note)})` : ''}.
Nothing is shared until you click <b>Allow</b> on a prompt on your screen, and you can end a session any time.</p>

<div class="tabs">
  <button id="tab-new" class="tab active">First time here</button>
  <button id="tab-have" class="tab">I already installed it</button>
</div>

<section id="pane-new" style="display:flex;flex-direction:column;gap:16px">
  <div class="card"><div class="step"><span class="num">1</span><h2>Download the app</h2></div>
    <a class="btn" id="primary" href="${dl('mac')}">Download for macOS</a></div>

  <div class="card" id="mac-install"><div class="step"><span class="num">2</span><h2>Install &amp; open it</h2></div>
    <p class="muted">Open <b>Terminal</b> (Spotlight → type “Terminal”) and paste these:</p>
    <pre data-copy>${esc(macInstall)}</pre></div>

  <div class="card" id="mac-perms"><div class="step"><span class="num">3</span><h2>Allow two permissions</h2></div>
    <p class="muted">Open <b>System Settings → Privacy &amp; Security</b> and turn <b>ON</b> “Remote Access” under
    <b>Screen &amp; System Audio Recording</b> and under <b>Accessibility</b>. Then restart the app so they take effect:</p>
    <pre data-copy>${esc(macRestart)}</pre></div>

  <div class="card" id="win-install" hidden><div class="step"><span class="num">2</span><h2>Open it</h2></div>
    <p class="muted">Unzip the download and double-click <b>remote-access-endpoint.exe</b>. If Windows SmartScreen warns,
    choose <b>More info → Run anyway</b>. No extra permissions are needed on Windows.</p></div>

  <div class="card"><div class="step"><span class="num" id="num-connect">4</span><h2>Connect</h2></div>
    <p class="muted">With the app running, click the button. Your browser will ask to open Remote Access — allow it.</p>
    <a class="btn" href="${esc(deepLink)}">Connect this computer</a></div>
</section>

<section id="pane-have" hidden style="display:flex;flex-direction:column;gap:16px">
  <div class="card"><h2>Already have Remote Access installed?</h2>
    <p class="muted">Make sure it’s running, then connect this computer to the new invite:</p>
    <a class="btn" href="${esc(deepLink)}">Connect this computer</a>
    <p class="muted">Button does nothing? Paste this into the app when it asks for the invite:</p>
    <input readonly value="${esc(deepLink)}" onclick="this.select()"></div>
</section>

<p class="muted">This link works for one computer and expires automatically.</p>
</main>
<script>
(function(){
  var win=/Windows/i.test(navigator.userAgent);
  if(win){
    var p=document.getElementById('primary');
    p.textContent='Download for Windows';p.href=${JSON.stringify(dl('win'))};
    document.getElementById('mac-install').hidden=true;
    document.getElementById('mac-perms').hidden=true;
    document.getElementById('win-install').hidden=false;
    document.getElementById('num-connect').textContent='3';
  }
  var tn=document.getElementById('tab-new'),th=document.getElementById('tab-have');
  var pn=document.getElementById('pane-new'),ph=document.getElementById('pane-have');
  tn.onclick=function(){tn.classList.add('active');th.classList.remove('active');pn.hidden=false;ph.hidden=true;};
  th.onclick=function(){th.classList.add('active');tn.classList.remove('active');ph.hidden=false;pn.hidden=true;};
  document.querySelectorAll('pre[data-copy]').forEach(function(pre){
    var text=pre.textContent;
    var b=document.createElement('button');b.className='copy';b.textContent='Copy';
    b.onclick=function(){navigator.clipboard.writeText(text.trim()).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy';},1200);});};
    pre.appendChild(b);
  });
})();
</script></body></html>`;
}

const gone = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not valid</title>
<body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 16px"><h1 style="font-size:22px">This link is no longer valid</h1>
<p>It may have expired, been used already, or been cancelled. Ask the person who sent it for a new one.</p></body>`;

export function registerInviteRoutes(app: Express, requireOperator: RequestHandler, who: (req: Request) => string) {
  // ---- public: the page the user opens -------------------------------------------
  app.get('/join/:token', limit(60), async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const token = String(req.params.token);
    const inv = await usableInvite(token);
    if (!inv) return void res.status(410).type('html').send(gone);
    const first = await db.query('UPDATE invites SET opened_at = now() WHERE id = $1 AND opened_at IS NULL RETURNING id', [inv.id]);
    if (first.rowCount) await inviteEvent(inv.id, 'opened', { ip: req.ip, ua: req.get('user-agent') ?? null });
    res.type('html').send(joinPage(token, inv));
  });

  // Generic client, no secret inside, so token-gated rather than login-gated.
  app.get('/join/:token/download/:platform', limit(30), async (req, res) => {
    const inv = await usableInvite(String(req.params.token));
    if (!inv) return void res.status(410).type('html').send(gone);
    const platform = req.params.platform;
    if (!isPlatform(platform)) return void res.status(404).send('unknown platform');
    const file = join(config.clientsDir, GENERIC_FILES[platform]);
    if (!existsSync(file)) return void res.status(404).send(`The ${platform} app has not been packaged on this server yet.`);
    await inviteEvent(inv.id, 'downloaded', { platform });
    res.download(file, GENERIC_FILES[platform].replace('-generic', ''));
  });

  // ---- public: called by the client app itself -----------------------------------
  app.post('/api/enroll', limit(10), async (req, res) => {
    const { token, platform, hostname } = req.body ?? {};
    if (typeof token !== 'string' || !isPlatform(platform)) return void res.status(400).json({ error: 'bad request' });
    const host = typeof hostname === 'string' ? hostname.slice(0, 100) : '';

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Single atomic claim: two simultaneous enrolls with one token cannot both win.
      const claimed = TOKEN_RE.test(token)
        ? await client.query(
            `UPDATE invites SET enrolled_at = now()
             WHERE token_hash = $1 AND enrolled_at IS NULL AND revoked_at IS NULL AND expires_at > now()
             RETURNING id, base_url`,
            [sha256(token)],
          )
        : { rows: [] as { id: string; base_url: string }[] };
      if (!claimed.rows[0]) {
        await client.query('ROLLBACK');
        await inviteEvent(null, 'enroll_rejected', { ip: req.ip, platform });
        return void res.status(410).json({ error: 'this invite is no longer valid' });
      }
      const { id: inviteId, base_url: baseUrl } = claimed.rows[0] as { id: string; base_url: string };

      const targetId = `${host.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || platform}-${newSecret().slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      const deviceToken = newSecret('dev_');
      await client.query(
        'INSERT INTO devices (id, invite_id, target_id, credential_hash, platform, hostname) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)',
        [inviteId, targetId, sha256(deviceToken), platform, host || null],
      );
      await client.query('COMMIT');
      await inviteEvent(inviteId, 'enrolled', { targetId, platform, hostname: host, ip: req.ip });
      res.json({ deviceToken, targetId, server: baseUrl, wsUrl: `${baseUrl.replace(/^http/, 'ws')}/ws/endpoint` });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  // ---- operators -------------------------------------------------------------------
  app.get('/api/invites/config', requireOperator, (req, res) => {
    res.json({ defaultServer: config.publicUrl ?? `${req.protocol}://${req.get('host')}` });
  });

  app.post('/api/invites', requireOperator, async (req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 120) : '';
    const ttlHours = Math.min(Math.max(Number(req.body?.ttlHours) || 24, 1), 168);
    let base: URL;
    try {
      base = new URL(String(req.body?.server ?? ''));
      if (!['http:', 'https:'].includes(base.protocol)) throw new Error();
    } catch {
      return void res.status(400).json({ error: 'server must be a full http(s) address, e.g. https://broker.example.com' });
    }
    const baseUrl = base.origin;
    const token = newSecret();
    const id = randomUUID();
    const r = await db.query(
      `INSERT INTO invites (id, token_hash, created_by, note, base_url, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) RETURNING expires_at`,
      [id, sha256(token), who(req), note || null, baseUrl, ttlHours],
    );
    await inviteEvent(id, 'created', { by: who(req), ttlHours, server: baseUrl });
    const local = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
    res.json({
      id, url: `${baseUrl}/join/${token}`, expiresAt: r.rows[0].expires_at,
      warning: local ? 'This address only works on this computer. Use an address the other person can reach (LAN IP or domain).' : undefined,
    });
  });

  app.get('/api/invites', requireOperator, async (_req, res) => {
    const r = await db.query(
      `SELECT i.id, i.created_by, i.note, i.created_at, i.expires_at, ${STATUS_SQL} AS status, d.target_id
       FROM invites i LEFT JOIN devices d ON d.invite_id = i.id ORDER BY i.created_at DESC LIMIT 50`,
    );
    res.json({ invites: r.rows });
  });

  app.post('/api/invites/:id/revoke', requireOperator, async (req, res) => {
    const r = await db.query(
      'UPDATE invites SET revoked_at = now() WHERE id = $1 AND enrolled_at IS NULL AND revoked_at IS NULL RETURNING id',
      [String(req.params.id)],
    ).catch(() => ({ rowCount: 0 }));
    if (!r.rowCount) return void res.status(404).json({ error: 'invite not found or already used' });
    await inviteEvent(String(req.params.id), 'revoked', { by: who(req) });
    res.json({ ok: true });
  });

  app.get('/api/devices', requireOperator, async (_req, res) => {
    const r = await db.query(
      `SELECT id, target_id, platform, hostname, enrolled_at, last_seen_at, revoked_at FROM devices ORDER BY enrolled_at DESC LIMIT 100`,
    );
    res.json({ devices: r.rows.map((d) => ({ ...d, online: !!getEndpoint(d.target_id) })) });
  });

  // Revoking drops the live connection too, so the computer disappears from Targets immediately.
  app.post('/api/devices/:id/revoke', requireOperator, async (req, res) => {
    const r = await db.query(
      'UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING target_id, invite_id',
      [String(req.params.id)],
    ).catch(() => ({ rowCount: 0, rows: [] as { target_id: string; invite_id: string }[] }));
    const d = r.rows[0] as { target_id: string; invite_id: string } | undefined;
    if (!d) return void res.status(404).json({ error: 'device not found or already revoked' });
    disconnectEndpoint(d.target_id, 'device revoked');
    await inviteEvent(d.invite_id, 'device_revoked', { by: who(req), targetId: d.target_id });
    res.json({ ok: true });
  });
}

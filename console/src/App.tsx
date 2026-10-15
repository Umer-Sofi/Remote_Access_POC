// Operator console shell, styled as the "GefyLink" dashboard. Login → sidebar
// dashboard (Targets, Audit history, Session recordings, SFU smoke test, Settings).
// All data comes from the existing broker API; no router library (few views).
import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AuditEntry, type Scope, type SessionRow, type Target } from './api';
import { Session } from './Session';
import { Smoke } from './Smoke';
import { Invites } from './Invites';

type View = 'targets' | 'invite' | 'history' | 'recordings' | 'download' | 'smoke' | 'settings';

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'targets', label: 'Targets', icon: '🖥️' },
  { id: 'invite', label: 'Invite link', icon: '✉️' },
  { id: 'history', label: 'Audit history', icon: '🕑' },
  { id: 'recordings', label: 'Session recordings', icon: '🎥' },
  { id: 'download', label: 'Download client', icon: '⬇️' },
  { id: 'smoke', label: 'SFU smoke test', icon: '🛡️' },
];

type Theme = 'light' | 'dark';
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem('theme') as Theme) || 'light'; } catch { return 'light'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

const PLATFORM = {
  mac: { label: 'macOS', icon: '', cls: 'mac' },
  win: { label: 'Windows', icon: '⊞', cls: 'win' },
} as const;

function timeAgo(iso?: string) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View>('targets');
  const [sessionId, setSessionId] = useState<string>();
  const [theme, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api.me().then((u) => setUser(u.username)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return null;
  if (user === null) return <Login onLogin={setUser} />;
  if (sessionId) return <Session sessionId={sessionId} onExit={() => setSessionId(undefined)} />;

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">🔗</div>
          <div>
            <div className="brand-name">GefyLink</div>
            <div className="brand-sub">Secure Remote Access</div>
          </div>
        </div>
        <span className="spacer" />
        <button className="icon-btn" title="Toggle theme" onClick={toggleTheme}>{theme === 'light' ? '🌙' : '☀️'}</button>
        <div className="user-menu">
          <button className="user-chip" onClick={() => setMenuOpen((o) => !o)}>
            <span className="avatar">{user[0]?.toUpperCase()}</span>
            <span>{user}</span>
            <span className="caret">▾</span>
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="menu">
                <button onClick={() => { setView('settings'); setMenuOpen(false); }}>⚙️&nbsp; Settings</button>
                <button className="danger" onClick={() => api.logout().then(() => setUser(null))}>⎋&nbsp; Log out</button>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <nav className="side-nav">
            {NAV.map((n) => (
              <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => setView(n.id)}>
                <span className="nav-icon">{n.icon}</span>
                {n.label}
              </button>
            ))}
          </nav>
          <div className="sys-status">
            <span className="dot ok" />
            <div>
              <div className="sys-title">System Online</div>
              <div className="sys-sub">All services healthy</div>
            </div>
          </div>
        </aside>

        <div className="main">
          <div className="content">
            {view === 'targets' && <Targets onStart={setSessionId} user={user} />}
            {view === 'invite' && <Invites />}
            {view === 'history' && <History />}
            {view === 'recordings' && <Recordings />}
            {view === 'download' && <Download />}
            {view === 'smoke' && <div className="card"><Smoke /></div>}
            {view === 'settings' && <Settings user={user} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (u: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      onLogin((await api.login(username, password)).username);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Invalid username or password' : String(err));
    }
  };
  return (
    <div className="login-bg">
      <form className="login card" onSubmit={submit}>
        <div className="brand login-brand">
          <div className="brand-mark">🔗</div>
          <div>
            <div className="brand-name">GefyLink</div>
            <div className="brand-sub">Secure Remote Access</div>
          </div>
        </div>
        <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="primary" type="submit">Log in</button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}

interface Stats { online: number; inSession: number; sessions: number; recordings: number }

function WelcomeBanner({ user, stats }: { user: string; stats: Stats }) {
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const name = user.charAt(0).toUpperCase() + user.slice(1);
  const cards = [
    { icon: '🖥️', label: 'Targets online', value: stats.online, sub: 'ready to connect' },
    { icon: '🟢', label: 'In session', value: stats.inSession, sub: 'active now' },
    { icon: '🗂️', label: 'Total sessions', value: stats.sessions, sub: 'all time' },
    { icon: '🎥', label: 'Recordings', value: stats.recordings, sub: 'saved server-side' },
  ];
  return (
    <div className="welcome">
      <div className="welcome-date">{date}</div>
      <h1 className="welcome-title">Welcome {name}!</h1>
      <p className="welcome-sub">Connect to your devices securely from anywhere — every session consented, recorded and audited.</p>
      <div className="stat-row">
        {cards.map((c) => (
          <div className="stat" key={c.label}>
            <div className="stat-icon">{c.icon}</div>
            <div>
              <div className="stat-label">{c.label}</div>
              <div className="stat-value">{c.value}<span className="stat-sub"> {c.sub}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Targets({ onStart, user }: { onStart: (id: string) => void; user: string }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [bootstrap, setBootstrap] = useState('');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<Scope>('control');
  const [error, setError] = useState<string>();
  const [q, setQ] = useState('');
  const [platform, setPlatform] = useState<'all' | 'mac' | 'win'>('all');
  const [status, setStatus] = useState<'all' | 'online' | 'busy'>('all');
  const [connectTarget, setConnectTarget] = useState<Target | null>(null);

  // "Connectable targets" = endpoints holding a live WSS link right now (spec §8.1).
  useEffect(() => {
    const load = () => {
      api.targets().then((r) => { setTargets(r.targets); setBootstrap(r.bootstrap); }).catch(() => {});
      api.sessions().then((r) => setSessions(r.sessions)).catch(() => {});
    };
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);

  const stats: Stats = {
    online: targets.filter((t) => !t.busy).length,
    inSession: targets.filter((t) => t.busy).length,
    sessions: sessions.length,
    recordings: sessions.filter((s) => s.recording_url).length,
  };

  const openConnect = (t: Target) => {
    setError(undefined);
    setReason('');
    setScope('control');
    setConnectTarget(t);
  };

  const connect = async () => {
    if (!connectTarget) return;
    setError(undefined);
    try {
      const id = (await api.startSession(connectTarget.id, reason, scope)).sessionId;
      setConnectTarget(null);
      onStart(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const filtered = useMemo(() => targets.filter((t) => {
    if (platform !== 'all' && t.platform !== platform) return false;
    if (status === 'online' && t.busy) return false;
    if (status === 'busy' && !t.busy) return false;
    const hay = `${t.id} ${t.hostname} ${t.platform}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }), [targets, q, platform, status]);

  return (
    <>
      <WelcomeBanner user={user} stats={stats} />
      <div className="card">
        <div className="card-head">
          <div className="card-head-left">
            <span className="card-icon">🖥️</span>
            <div>
              <h2>Targets</h2>
              <p className="muted">Manage and connect to your remote devices</p>
            </div>
          </div>
        </div>

        <div className="toolbar-row">
          <div className="search grow">
            <span className="search-icon">🔍</span>
            <input placeholder="Search targets…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select value={platform} onChange={(e) => setPlatform(e.target.value as any)}>
            <option value="all">All platforms</option>
            <option value="mac">macOS</option>
            <option value="win">Windows</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as any)}>
            <option value="all">All status</option>
            <option value="online">Online</option>
            <option value="busy">In session</option>
          </select>
        </div>

        {error && <div className="error">{error}</div>}

        {filtered.length ? (
          <>
            <table className="data">
              <thead><tr><th>Target</th><th>Platform</th><th>Host</th><th>Status</th><th>Last seen</th><th>Actions</th></tr></thead>
              <tbody>
                {filtered.map((t) => {
                  const p = PLATFORM[t.platform];
                  const blocked = !t.posture.allowed;
                  return (
                    <tr key={t.id}>
                      <td>
                        <div className="target-cell">
                          <span className={`platform-mark ${p.cls}`}>{p.icon || p.label[0]}</span>
                          <div>
                            <div className="target-name">{t.id}</div>
                            <div className="muted small">{t.version}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className={`chip ${p.cls}`}>{p.label}</span></td>
                      <td className="muted">{t.hostname}</td>
                      <td>
                        {blocked
                          ? <span className="status blocked">● Blocked</span>
                          : t.busy
                            ? <span className="status busy">● In session</span>
                            : <span className="status online">● Online</span>}
                      </td>
                      <td className="muted">{timeAgo(t.connectedAt)}</td>
                      <td>
                        <button className="connect" disabled={t.busy || blocked} onClick={() => openConnect(t)}>🖥️ Connect</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="card-foot muted">Showing {filtered.length} of {targets.length} targets</div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">🖥️</div>
            <h3>{targets.length ? 'No targets match your filters' : 'No targets online yet'}</h3>
            <p className="muted">
              {targets.length
                ? 'Try clearing the search or status filters above.'
                : 'Devices show up here automatically once the Remote Access client is installed and running on them.'}
            </p>
            {!targets.length && bootstrap && <div className="instruction">{bootstrap}</div>}
          </div>
        )}
      </div>

      {connectTarget && (
        <div className="modal-bg" onClick={() => setConnectTarget(null)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <h2>Connect to {connectTarget.id}</h2>
            <p className="muted">The user on {connectTarget.hostname} will see your reason and must approve before the session starts.</p>
            <label className="field">
              <span>Reason</span>
              <input
                autoFocus
                placeholder="e.g. Helping fix the VPN client"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Access level</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
                <option value="control">View + control</option>
                <option value="view">View only</option>
              </select>
            </label>
            {error && <div className="error">{error}</div>}
            <div className="row end">
              <button onClick={() => setConnectTarget(null)}>Cancel</button>
              <button className="primary" onClick={connect}>Request session</button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}

// Map a session state to a status pill (class + label).
const STATE_PILL: Record<string, { cls: string; label: string }> = {
  ACTIVE: { cls: 'ok', label: 'Live' },
  APPROVED: { cls: 'info', label: 'Approved' },
  REQUESTED: { cls: 'wait', label: 'Requested' },
  CONSENT_PENDING: { cls: 'wait', label: 'Awaiting consent' },
  DENIED: { cls: 'deny', label: 'Denied' },
  ENDED: { cls: 'off', label: 'Ended' },
};
const statePill = (s: string) => STATE_PILL[s] ?? { cls: 'off', label: s };

function History() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [open, setOpen] = useState<string>();
  const [detail, setDetail] = useState<{ events: AuditEntry[]; input: { type: string; n: number }[]; session: SessionRow }>();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'ended' | 'denied'>('all');
  const [limit, setLimit] = useState(10);

  useEffect(() => { api.sessions().then((r) => setRows(r.sessions)); }, []);
  useEffect(() => { if (open) api.audit(open).then(setDetail); else setDetail(undefined); }, [open]);
  useEffect(() => { setLimit(10); }, [q, filter]); // reset paging when the query changes

  const filtered = useMemo(() => rows.filter((r) => {
    if (filter === 'active' && r.state !== 'ACTIVE') return false;
    if (filter === 'ended' && r.state !== 'ENDED') return false;
    if (filter === 'denied' && r.state !== 'DENIED') return false;
    const hay = `${r.target} ${r.operator}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }), [rows, q, filter]);
  const visible = filtered.slice(0, limit);

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-head-left">
          <span className="card-icon">🕑</span>
          <div><h2>Audit history <span className="count">{rows.length}</span></h2><p className="muted">Every session and its consent trail</p></div>
        </div>
      </div>

      <div className="toolbar-row">
        <div className="search grow">
          <span className="search-icon">🔍</span>
          <input placeholder="Search by target or operator…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as any)}>
          <option value="all">All states</option>
          <option value="active">Live</option>
          <option value="ended">Ended</option>
          <option value="denied">Denied</option>
        </select>
      </div>

      {filtered.length ? (
        <table className="data">
          <thead><tr><th>Started</th><th>Operator</th><th>Target</th><th>Scope</th><th>State</th><th>Recording</th></tr></thead>
          <tbody>
            {visible.map((r) => {
              const p = statePill(r.state);
              const expanded = open === r.id;
              return (
                <Fragment key={r.id}>
                  <tr className={expanded ? 'selected' : ''} onClick={() => setOpen(expanded ? undefined : r.id)}>
                    <td>
                      <div className="target-name">{timeAgo(r.created_at)}</div>
                      <div className="muted small">{new Date(r.created_at).toLocaleString()}</div>
                    </td>
                    <td>
                      <div className="op-cell">
                        <span className="op-avatar">{(r.operator[0] ?? '?').toUpperCase()}</span>
                        {r.operator}
                      </div>
                    </td>
                    <td className="target-name">{r.target}</td>
                    <td><span className="chip">{r.scope === 'control' ? 'Control' : 'View'}</span></td>
                    <td><span className={`pill ${p.cls}`}>{p.label}</span></td>
                    <td>{r.recording_url ? <span className="pill info">▶ Recorded</span> : <span className="muted">–</span>}</td>
                  </tr>
                  {expanded && detail && detail.session.id === r.id && (
                    <tr className="audit-row">
                      <td colSpan={6}>
                        <div className="audit">
                          <h4>Consent trail</h4>
                          <ol className="trail">
                            {detail.events.map((e, i) => (
                              <li key={i}>
                                <code>{new Date(e.at).toLocaleTimeString()}</code>
                                <b>{e.event}</b>
                                {e.detail && Object.keys(e.detail).length > 0 && <span className="muted">{JSON.stringify(e.detail)}</span>}
                              </li>
                            ))}
                          </ol>
                          <h4>Operator input</h4>
                          <p className="muted">{detail.input.length ? detail.input.map((i) => `${i.type}: ${i.n}`).join(' · ') : 'No input recorded.'}</p>
                          {detail.session.recording_url?.split(' ').filter(Boolean).map((u) => (
                            <div key={u} className="rec-block">
                              <h4>Recording</h4>
                              <video src={u} controls className="recording" />
                              <div><a href={u} download>⬇ download {u.split('/').pop()}</a></div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="empty-state slim">
          <div className="empty-icon">🕑</div>
          <p className="muted">{rows.length ? 'No sessions match your filters.' : 'No sessions yet. They appear here once you connect to a target.'}</p>
        </div>
      )}
      {filtered.length > limit && (
        <div className="show-more">
          <button className="ghost-danger" onClick={() => setLimit((n) => n + 10)}>Show more ({filtered.length - limit} more)</button>
        </div>
      )}
      {filtered.length > 0 && <div className="card-foot muted">Showing {Math.min(limit, filtered.length)} of {filtered.length} sessions</div>}
    </div>
  );
}

function Recordings() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  useEffect(() => { api.sessions().then((r) => setRows(r.sessions.filter((s) => s.recording_url))); }, []);
  return (
    <div className="card">
      <div className="card-head"><div className="card-head-left"><span className="card-icon">🎥</span><div><h2>Session recordings</h2><p className="muted">Server-side recordings of completed sessions</p></div></div></div>
      {!rows.length && (
        <div className="empty-block">
          <p>No recordings yet.</p>
          <p className="muted small">Recording is on in local and production mode. In the internet-test (LiveKit Cloud) setup it is disabled, so sessions here won't produce files.</p>
        </div>
      )}
      <div className="rec-grid">
        {rows.map((r) => (
          <div className="rec-card" key={r.id}>
            <div className="rec-head">
              <div className="target-name">{r.target}</div>
              <div className="muted small">{new Date(r.created_at).toLocaleString()} · {r.operator}</div>
            </div>
            {r.recording_url!.split(' ').filter(Boolean).map((u) => (
              <video key={u} src={u} controls className="rec-video" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const guessPlatform = (): 'mac' | 'win' | undefined => {
  const ua = navigator.userAgent;
  return /Mac/i.test(ua) ? 'mac' : /Windows/i.test(ua) ? 'win' : undefined;
};

function Download() {
  const [available, setAvailable] = useState<{ mac: boolean; win: boolean }>();
  const mine = guessPlatform();
  useEffect(() => { api.clients().then(setAvailable).catch(() => setAvailable({ mac: false, win: false })); }, []);

  const card = (p: 'mac' | 'win', title: string, file: string, steps: string[]) => (
    <div className={`dl-card ${mine === p ? 'mine' : ''}`}>
      <div className="dl-head">
        <span className={`platform-mark ${p}`}>{p === 'mac' ? '' : '⊞'}</span>
        <div>
          <div className="dl-title">{title}</div>
          {mine === p && <span className="dl-badge">Your computer</span>}
        </div>
      </div>
      {available?.[p]
        ? <a className="primary dl-btn" href={`/api/clients/${p}`} download={file}>⬇ Download for {title}</a>
        : <button className="primary dl-btn" disabled>{available ? 'Not available yet' : 'Checking…'}</button>}
      {available?.[p] && <div className="muted small dl-file">{file}</div>}
      <ol className="dl-steps">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
    </div>
  );

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="card-head-left">
            <span className="card-icon">⬇️</span>
            <div>
              <h2>Download client</h2>
              <p className="muted">Install on a computer you want to be reachable — this server address is baked in.</p>
            </div>
          </div>
        </div>
        <p className="muted dl-note">The app stays idle until an operator requests a session, and the person at the computer must click <b>Allow</b> before anything is shared.</p>
      </div>

      <div className="dl-grid">
        {card('mac', 'macOS', 'RemoteAccessEndpoint-mac.zip', [
          'Unzip it and move Remote Access to Applications.',
          'Right-click the app and choose Open (it is not notarized yet), then confirm.',
          'Allow Screen Recording and Accessibility in System Settings → Privacy & Security, then open the app again.',
          'It appears in the Targets tab within a few seconds.',
        ])}
        {card('win', 'Windows', 'remote-access-endpoint-win.zip', [
          'Unzip it and double-click remote-access-endpoint.exe.',
          'If SmartScreen warns, choose More info → Run anyway.',
          'It appears in the Targets tab within a few seconds.',
        ])}
      </div>
    </>
  );
}

function Settings({ user }: { user: string }) {
  return (
    <div className="card">
      <div className="card-head"><div className="card-head-left"><span className="card-icon">⚙️</span><div><h2>Settings</h2><p className="muted">Operator & system information</p></div></div></div>
      <div className="settings">
        <div className="setting"><span className="muted">Signed in as</span><b>{user}</b></div>
        <div className="setting"><span className="muted">Role</span><b>Operator</b></div>
        <div className="setting"><span className="muted">Transport</span><b>WebRTC via SFU (DTLS-SRTP encrypted)</b></div>
        <div className="setting"><span className="muted">Recording</span><b>Server-side (local / production mode)</b></div>
        <div className="setting"><span className="muted">Audit</span><b>Append-only, tamper-evident</b></div>
        <p className="muted small">Role-based permissions and identity provider (Entra ID / AD) are planned — operators are currently local accounts.</p>
      </div>
    </div>
  );
}

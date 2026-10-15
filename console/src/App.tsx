// Operator console shell, styled as the "GefyLink" dashboard. Login → sidebar
// dashboard (Targets, Audit history, Session recordings, SFU smoke test, Settings).
// All data comes from the existing broker API; no router library (few views).
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AuditEntry, type Scope, type SessionRow, type Target } from './api';
import { Session } from './Session';
import { Smoke } from './Smoke';

type View = 'targets' | 'history' | 'recordings' | 'smoke' | 'settings';

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'targets', label: 'Targets', icon: '🖥️' },
  { id: 'history', label: 'Audit history', icon: '🕑' },
  { id: 'recordings', label: 'Session recordings', icon: '🎥' },
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
            {view === 'history' && <History />}
            {view === 'recordings' && <Recordings />}
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
  const [showAdd, setShowAdd] = useState(false);

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

  const connect = async (t: Target) => {
    setError(undefined);
    try {
      onStart((await api.startSession(t.id, reason, scope)).sessionId);
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
          <button className="primary" onClick={() => setShowAdd(true)}>+ Add Target</button>
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

        <div className="consent-bar">
          <input className="grow" placeholder="Reason (shown to the user in the consent prompt)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="control">View + control</option>
            <option value="view">View only</option>
          </select>
        </div>

        {error && <div className="error">{error}</div>}

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
                    <button className="connect" disabled={t.busy || blocked} onClick={() => connect(t)}>🖥️ Connect</button>
                  </td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr><td colSpan={6} className="empty">No targets online. {bootstrap}</td></tr>
            )}
          </tbody>
        </table>
        <div className="card-foot muted">Showing {filtered.length} of {targets.length} targets</div>
      </div>

      {showAdd && (
        <div className="modal-bg" onClick={() => setShowAdd(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <h2>Add a target</h2>
            <p className="muted">Targets appear here automatically once the endpoint app is running on them. There is nothing to add manually — just install and run the client:</p>
            <div className="instruction">{bootstrap || 'Download and run the Remote Access client on the target machine.'}</div>
            <div className="row end"><button className="primary" onClick={() => setShowAdd(false)}>Got it</button></div>
          </div>
        </div>
      )}
    </>
  );
}

function History() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [open, setOpen] = useState<string>();
  const [detail, setDetail] = useState<{ events: AuditEntry[]; input: { type: string; n: number }[]; session: SessionRow }>();

  useEffect(() => { api.sessions().then((r) => setRows(r.sessions)); }, []);
  useEffect(() => { if (open) api.audit(open).then(setDetail); else setDetail(undefined); }, [open]);

  return (
    <div className="card">
      <div className="card-head"><div className="card-head-left"><span className="card-icon">🕑</span><div><h2>Audit history</h2><p className="muted">Every session and its consent trail</p></div></div></div>
      <table className="data">
        <thead><tr><th>Started</th><th>Operator</th><th>Target</th><th>Scope</th><th>State</th><th>Recording</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={open === r.id ? 'selected' : ''} onClick={() => setOpen(open === r.id ? undefined : r.id)}>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.operator}</td>
              <td>{r.target}</td>
              <td><span className="chip">{r.scope}</span></td>
              <td><span className={`status ${r.state === 'ACTIVE' ? 'online' : r.state === 'DENIED' ? 'blocked' : 'neutral'}`}>● {r.state}</span></td>
              <td className="muted">{r.recording_url ? 'yes' : '–'}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="empty">No sessions yet.</td></tr>}
        </tbody>
      </table>
      {detail && (
        <div className="audit">
          <h3>Audit trail · <span className="muted">{detail.session.id}</span></h3>
          <ol>
            {detail.events.map((e, i) => (
              <li key={i}>
                <code>{new Date(e.at).toLocaleTimeString()}</code> <b>{e.event}</b> <span className="muted">{JSON.stringify(e.detail)}</span>
              </li>
            ))}
          </ol>
          <h3>Operator input log</h3>
          <p className="muted">{detail.input.length ? detail.input.map((i) => `${i.type}: ${i.n}`).join(' · ') : 'no input recorded'}</p>
          {detail.session.recording_url?.split(' ').filter(Boolean).map((u) => (
            <div key={u}>
              <h3>Recording</h3>
              <video src={u} controls className="recording" />
              <div><a href={u} download>download {u.split('/').pop()}</a></div>
            </div>
          ))}
        </div>
      )}
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

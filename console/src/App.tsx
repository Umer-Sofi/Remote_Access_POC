// Operator console shell: login → target list → session, plus audit history and
// the client download page and the M1 smoke test. Deliberately no router library; four views is not worth one.
import { useEffect, useState } from 'react';
import { api, ApiError, type AuditEntry, type Scope, type SessionRow, type Target } from './api';
import { Session } from './Session';
import { Smoke } from './Smoke';

type View = 'targets' | 'history' | 'download' | 'smoke';

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View>('targets');
  const [sessionId, setSessionId] = useState<string>();

  useEffect(() => {
    api.me().then((u) => setUser(u.username)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return null;
  if (user === null) return <Login onLogin={setUser} />;
  if (sessionId) return <Session sessionId={sessionId} onExit={() => setSessionId(undefined)} />;

  return (
    <div className="app">
      <header>
        <h1>Remote Access</h1>
        <nav>
          {(['targets', 'history', 'download', 'smoke'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {v === 'targets' ? 'Targets' : v === 'history' ? 'Audit history' : v === 'download' ? 'Download client' : 'SFU smoke test'}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="muted">{user}</span>
        <button onClick={() => api.logout().then(() => setUser(null))}>Log out</button>
      </header>
      {view === 'targets' && <Targets onStart={setSessionId} />}
      {view === 'history' && <History />}
      {view === 'download' && <Download />}
      {view === 'smoke' && <Smoke />}
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
    <form className="login" onSubmit={submit}>
      <h1>Remote Access</h1>
      <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Log in</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function Targets({ onStart }: { onStart: (id: string) => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [bootstrap, setBootstrap] = useState('');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<Scope>('control');
  const [error, setError] = useState<string>();

  // "Connectable targets" = endpoints holding a live WSS link right now (spec §8.1).
  useEffect(() => {
    const load = () => api.targets().then((r) => { setTargets(r.targets); setBootstrap(r.bootstrap); }).catch(() => {});
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);

  const connect = async (t: Target) => {
    setError(undefined);
    try {
      onStart((await api.startSession(t.id, reason, scope)).sessionId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <div className="row">
        <input className="grow" placeholder="Reason (shown to the user in the consent prompt)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="control">View + control</option>
          <option value="view">View only</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <table>
        <thead><tr><th>Target</th><th>Platform</th><th>Host</th><th>Status</th><th /></tr></thead>
        <tbody>
          {targets.map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>{t.platform === 'mac' ? 'macOS' : 'Windows'}</td>
              <td>{t.hostname}</td>
              <td>{t.busy ? 'in session' : t.posture.allowed ? 'online' : `blocked: ${t.posture.reason}`}</td>
              <td><button disabled={t.busy || !t.posture.allowed} onClick={() => connect(t)}>Connect</button></td>
            </tr>
          ))}
          {!targets.length && <tr><td colSpan={5} className="muted">No targets online. {bootstrap} Get the client from the “Download client” tab.</td></tr>}
        </tbody>
      </table>
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
    <div className="panel card">
      <h3>{title} {mine === p && <span className="badge">your computer</span>}</h3>
      {available?.[p]
        ? <a className="button" href={`/api/clients/${p}`} download={file}>Download {file}</a>
        : <button disabled>{available ? 'Not available yet' : 'Checking…'}</button>}
      <ol>{steps.map((s) => <li key={s}>{s}</li>)}</ol>
    </div>
  );

  return (
    <div className="panel">
      <p className="muted">
        Run this on the computer you want to be able to reach. The download already knows this server, so there is
        nothing to configure. It stays idle until an operator requests a session, and the person at the computer
        must click Allow before anything is shared.
      </p>
      <div className="cards">
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
    </div>
  );
}

function History() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [open, setOpen] = useState<string>();
  const [detail, setDetail] = useState<{ events: AuditEntry[]; input: { type: string; n: number }[]; session: SessionRow }>();

  useEffect(() => { api.sessions().then((r) => setRows(r.sessions)); }, []);
  useEffect(() => { if (open) api.audit(open).then(setDetail); else setDetail(undefined); }, [open]);

  return (
    <div className="panel">
      <table>
        <thead><tr><th>Started</th><th>Operator</th><th>Target</th><th>Scope</th><th>State</th><th>Recording</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={open === r.id ? 'selected' : ''} onClick={() => setOpen(open === r.id ? undefined : r.id)}>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.operator}</td>
              <td>{r.target}</td>
              <td>{r.scope}</td>
              <td>{r.state}</td>
              <td>{r.recording_url ? 'yes' : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail && (
        <div className="audit">
          <h3>Audit trail · {detail.session.id}</h3>
          <ol>
            {detail.events.map((e, i) => (
              <li key={i}>
                <code>{new Date(e.at).toLocaleTimeString()}</code> <b>{e.event}</b> <span className="muted">{JSON.stringify(e.detail)}</span>
              </li>
            ))}
          </ol>
          <h3>Operator input log</h3>
          <p>{detail.input.length ? detail.input.map((i) => `${i.type}: ${i.n}`).join(' · ') : 'no input recorded'}</p>
          {detail.session.recording_url?.split(' ').map((u) => (
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

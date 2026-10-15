// Invite links: the operator creates a one-time link, sends it (Teams, mail, ...) and watches it
// move pending → opened → enrolled. Enrolled computers can be revoked here.
import { useEffect, useMemo, useState } from 'react';
import { api, type DeviceRow, type InviteRow } from './api';

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '–');
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '–');

// Short relative time, e.g. "2m ago", "3h ago", "in 22h".
function rel(s: string | null): string {
  if (!s) return '–';
  const diff = new Date(s).getTime() - Date.now();
  const past = diff < 0;
  const m = Math.round(Math.abs(diff) / 60000);
  const txt = m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  if (m < 1) return 'just now';
  return past ? `${txt} ago` : `in ${txt}`;
}

export function Invites() {
  const [server, setServer] = useState('');
  const [note, setNote] = useState('');
  const [ttl, setTtl] = useState(24);
  const [created, setCreated] = useState<{ url: string; expiresAt: string; warning?: string }>();
  const [copied, setCopied] = useState(false);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string>();
  const [showServer, setShowServer] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);

  const refresh = () => {
    api.invites().then((r) => setInvites(r.invites)).catch(() => {});
    api.devices().then((r) => setDevices(r.devices)).catch(() => {});
  };
  useEffect(() => {
    api.inviteConfig().then((c) => setServer(c.defaultServer)).catch(() => {});
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  // Pending links are the only ones worth tracking; used/expired/revoked ones are history.
  const pending = useMemo(
    () => invites.filter((i) => i.status === 'pending' || i.status === 'opened'),
    [invites],
  );
  const activeDevices = useMemo(() => devices.filter((d) => !d.revoked_at), [devices]);
  const revokedDevices = useMemo(() => devices.filter((d) => d.revoked_at), [devices]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined); setCopied(false);
    try {
      setCreated(await api.createInvite(note, ttl, server));
      setNote('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      // Link copied — it can't be shown again, so dismiss the banner shortly after.
      setTimeout(() => { setCreated(undefined); setCopied(false); }, 900);
    } catch {
      setError('Copy failed; select the link and copy it manually.');
    }
  };

  const platform = (p: string) => (p === 'mac' ? 'macOS' : 'Windows');

  return (
    <>
      {/* ---- create a link ---- */}
      <div className="card">
        <div className="card-head">
          <div className="card-head-left">
            <span className="card-icon">✉️</span>
            <div>
              <h2>Invite a computer</h2>
              <p className="muted">Send a one-time link. The person opens it, installs the app and clicks Connect — then their computer shows up under Targets.</p>
            </div>
          </div>
        </div>

        <form className="invite-form" onSubmit={create}>
          <input className="grow" placeholder="Who is this for? (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
          <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            <option value={1}>Expires in 1 hour</option>
            <option value={24}>Expires in 24 hours</option>
            <option value={72}>Expires in 3 days</option>
            <option value={168}>Expires in 7 days</option>
          </select>
          <button className="primary" type="submit">Create link</button>
        </form>

        <button type="button" className="linkish" onClick={() => setShowServer((v) => !v)}>
          {showServer ? '▾' : '▸'} Server address the other computer will use
        </button>
        {showServer && (
          <input className="server-input" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.1.20:8080" />
        )}

        {error && <div className="error">{error}</div>}

        {created && (
          <div className="created">
            <b>Link ready — copy it now, it won't be shown again.</b>
            <div className="row">
              <input className="grow mono" readOnly value={created.url} onFocus={(e) => e.target.select()} />
              <button className="primary" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
            </div>
            <span className="muted">Works for one computer · expires {when(created.expiresAt)}.</span>
            {created.warning && <div className="error">{created.warning}</div>}
          </div>
        )}
      </div>

      {/* ---- pending links ---- */}
      <div className="card">
        <div className="card-head">
          <div className="card-head-left">
            <span className="card-icon">🔗</span>
            <div><h2>Pending links <span className="count">{pending.length}</span></h2>
              <p className="muted">Links that have been sent but not yet used.</p></div>
          </div>
        </div>
        {pending.length ? (
          <table className="data">
            <thead><tr><th>For</th><th>Created</th><th>Status</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {pending.map((i) => (
                <tr key={i.id}>
                  <td>{i.note || <span className="muted">—</span>}</td>
                  <td className="muted">{rel(i.created_at)}</td>
                  <td><span className={`pill ${i.status === 'opened' ? 'info' : 'wait'}`}>{i.status === 'opened' ? 'opened' : 'waiting'}</span></td>
                  <td className="muted">{rel(i.expires_at)}</td>
                  <td className="right"><button className="ghost-danger" onClick={() => api.revokeInvite(i.id).then(refresh)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state slim">
            <div className="empty-icon">🔗</div>
            <p className="muted">No pending links. Create one above and send it off.</p>
          </div>
        )}
      </div>

      {/* ---- enrolled computers ---- */}
      <div className="card">
        <div className="card-head">
          <div className="card-head-left">
            <span className="card-icon">💻</span>
            <div><h2>Computers <span className="count">{activeDevices.length}</span></h2>
              <p className="muted">Devices enrolled through an invite link.</p></div>
          </div>
          {revokedDevices.length > 0 && (
            <button className="linkish" onClick={() => setShowRevoked((v) => !v)}>
              {showRevoked ? 'Hide' : 'Show'} revoked ({revokedDevices.length})
            </button>
          )}
        </div>
        {activeDevices.length || (showRevoked && revokedDevices.length) ? (
          <table className="data">
            <thead><tr><th>Computer</th><th>Platform</th><th>Last connected</th><th>Status</th><th /></tr></thead>
            <tbody>
              {activeDevices.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="target-name">{d.target_id}</div>
                    <div className="muted small">{d.hostname ?? '–'}</div>
                  </td>
                  <td><span className="chip">{platform(d.platform)}</span></td>
                  <td className="muted">{d.last_seen_at ? rel(d.last_seen_at) : '–'}</td>
                  <td><span className={`pill ${d.online ? 'ok' : 'off'}`}>{d.online ? 'online' : 'offline'}</span></td>
                  <td className="right"><button className="ghost-danger" onClick={() => api.revokeDevice(d.id).then(refresh)}>Revoke</button></td>
                </tr>
              ))}
              {showRevoked && revokedDevices.map((d) => (
                <tr key={d.id} className="dim">
                  <td>
                    <div className="target-name">{d.target_id}</div>
                    <div className="muted small">{d.hostname ?? '–'}</div>
                  </td>
                  <td><span className="chip">{platform(d.platform)}</span></td>
                  <td className="muted">{date(d.revoked_at)}</td>
                  <td><span className="pill off">revoked</span></td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state slim">
            <div className="empty-icon">💻</div>
            <p className="muted">No computers enrolled yet.</p>
          </div>
        )}
      </div>
    </>
  );
}

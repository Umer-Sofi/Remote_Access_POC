// Invite links: the operator creates a one-time link, sends it (Teams, mail, ...) and watches it
// move pending → opened → enrolled. Enrolled computers can be revoked here.
import { useEffect, useState } from 'react';
import { api, type DeviceRow, type InviteRow } from './api';

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '–');

export function Invites() {
  const [server, setServer] = useState('');
  const [note, setNote] = useState('');
  const [ttl, setTtl] = useState(24);
  const [created, setCreated] = useState<{ url: string; expiresAt: string; warning?: string }>();
  const [copied, setCopied] = useState(false);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string>();

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
    try { await navigator.clipboard.writeText(created.url); setCopied(true); } catch { setError('Copy failed; select the link and copy it manually.'); }
  };

  return (
    <div className="panel">
      <p className="muted">
        Create a link and send it to the person whose computer you need. They open it, install the app and click Connect.
        The computer then appears under Targets. They still have to click Allow on every session.
      </p>
      <form className="row wrap" onSubmit={create}>
        <input className="grow" placeholder="Who is this for? (optional, shown on the page)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
        <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
          <option value={1}>Expires in 1 hour</option>
          <option value={24}>Expires in 24 hours</option>
          <option value={72}>Expires in 3 days</option>
          <option value={168}>Expires in 7 days</option>
        </select>
        <button type="submit">Create link</button>
      </form>
      <label className="muted field">Server address the other computer will use
        <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.1.20:8080" />
      </label>
      {error && <div className="error">{error}</div>}

      {created && (
        <div className="created">
          <b>Link created. Copy it now; it can't be shown again.</b>
          <div className="row"><input className="grow mono" readOnly value={created.url} onFocus={(e) => e.target.select()} />
            <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
          <span className="muted">Works for one computer. Expires {when(created.expiresAt)}.</span>
          {created.warning && <div className="error">{created.warning}</div>}
        </div>
      )}

      <h3>Links</h3>
      <table>
        <thead><tr><th>Created</th><th>For</th><th>By</th><th>Status</th><th>Computer</th><th /></tr></thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.id}>
              <td>{when(i.created_at)}</td><td>{i.note ?? '–'}</td><td>{i.created_by}</td>
              <td>{i.status}{i.status === 'pending' || i.status === 'opened' ? ` · until ${when(i.expires_at)}` : ''}</td>
              <td>{i.target_id ?? '–'}</td>
              <td>{(i.status === 'pending' || i.status === 'opened') && <button onClick={() => api.revokeInvite(i.id).then(refresh)}>Revoke</button>}</td>
            </tr>
          ))}
          {!invites.length && <tr><td colSpan={6} className="muted">No links yet.</td></tr>}
        </tbody>
      </table>

      <h3>Enrolled computers</h3>
      <table>
        <thead><tr><th>Target</th><th>Platform</th><th>Host</th><th>Enrolled</th><th>Last connected</th><th>Status</th><th /></tr></thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td>{d.target_id}</td><td>{d.platform === 'mac' ? 'macOS' : 'Windows'}</td><td>{d.hostname ?? '–'}</td>
              <td>{when(d.enrolled_at)}</td><td>{when(d.last_seen_at)}</td>
              <td>{d.revoked_at ? 'revoked' : d.online ? 'online' : 'offline'}</td>
              <td>{!d.revoked_at && <button className="danger" onClick={() => api.revokeDevice(d.id).then(refresh)}>Revoke</button>}</td>
            </tr>
          ))}
          {!devices.length && <tr><td colSpan={7} className="muted">No computers have enrolled yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

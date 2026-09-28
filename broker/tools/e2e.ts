// Automated end-to-end check of the server side, playing the operator:
//   login → request session → wait for APPROVED → join room → receive video →
//   send input → end → verify audit trail, input log and recording.
//
// Needs the docker stack up and a target online (e.g. tools/fake-endpoint.ts).
//   cd broker && npx tsx tools/e2e.ts --target fake-1
import { Room, RoomEvent, TrackKind } from '@livekit/rtc-node';

const B = process.env.BROKER ?? 'http://localhost:8080';
const target = process.argv[process.argv.indexOf('--target') + 1] ?? 'fake-1';
let cookie = '';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(B + path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (cond: unknown, what: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`);
  if (!cond) process.exitCode = 1;
};

await api('POST', '/api/login', { username: 'alice', password: process.env.E2E_PASSWORD ?? 'alice-pass' });
const expectRecording = process.env.EXPECT_RECORDING !== 'false'; // false for LiveKit Cloud mode
const { sessionId } = await api('POST', '/api/sessions', { targetId: target, reason: 'e2e test', scope: 'control' });
console.log('session', sessionId);

const early = await api('GET', `/api/sessions/${sessionId}`);
ok(!early.token, 'no token before consent');

let s: any;
for (let i = 0; i < 40; i++) {
  s = await api('GET', `/api/sessions/${sessionId}`);
  if (s.token || ['DENIED', 'ENDED'].includes(s.state)) break;
  await sleep(250);
}
ok(s.token && ['APPROVED', 'ACTIVE'].includes(s.state), `approved with token (state ${s.state})`);
if (!s.token) process.exit(1);

const room = new Room();
let gotVideo = false;
room.on(RoomEvent.TrackSubscribed, (track) => { if (track.kind === TrackKind.KIND_VIDEO) gotVideo = true; });
await room.connect(s.livekitUrl, s.token, { autoSubscribe: true, dynacast: false });
for (let i = 0; i < 40 && !gotVideo; i++) await sleep(250);
ok(gotVideo, 'operator receives the target video track through the SFU');

const enc = new TextEncoder();
const sendInput = (m: object) => room.localParticipant!.publishData(enc.encode(JSON.stringify(m)), { reliable: true, topic: 'input' });
for (let i = 0; i <= 20; i++) { await sendInput({ t: 'mm', x: i / 20, y: 0.5 }); await sleep(30); }
await sendInput({ t: 'mb', button: 'left', down: true });
await sendInput({ t: 'mb', button: 'left', down: false });
await sendInput({ t: 'kb', code: 'KeyH', down: true, mods: [] });
await sendInput({ t: 'kb', code: 'KeyH', down: false, mods: [] });
await sendInput({ t: 'cmd', name: 'ctrl-alt-del' });

// Let recording run a few seconds so the file has content.
await sleep(5000);
const active = await api('GET', `/api/sessions/${sessionId}`);
ok(active.state === 'ACTIVE', `session ACTIVE (${active.state})`);
if (expectRecording) ok(active.recording, 'broker saw egress_started (recording on)');

// Scope: downgrade applies immediately; upgrade needs the user's re-consent.
const down = await api('POST', `/api/sessions/${sessionId}/scope`, { scope: 'view' });
ok(down.scope === 'view' && !down.reconsentPending, 'downgrade to view applied immediately');
const up = await api('POST', `/api/sessions/${sessionId}/scope`, { scope: 'control' });
ok(up.scope === 'view' && up.reconsentPending, 'upgrade to control waits for re-consent');
await sleep(2000); // fake endpoint auto-allows after 0.8 s
const after = await api('GET', `/api/sessions/${sessionId}`);
ok(after.scope === 'control' && !after.reconsentPending, 'control restored after user re-consent');

await api('POST', `/api/sessions/${sessionId}/end`);
await room.disconnect();
await sleep(6000); // egress finalises the file and posts egress_ended

const audit = await api('GET', `/api/sessions/${sessionId}/audit`);
const events = audit.events.map((e: any) => e.event);
console.log('audit trail:', events.join(' → '));
const expected = ['requested', 'consent_shown', 'consent_granted', 'token_issued', 'connected', 'control_granted', 'ended'];
if (expectRecording) expected.push('recording_started', 'recording_stopped'); else expected.push('recording_disabled');
for (const e of expected) {
  ok(events.includes(e), `audit has ${e}`);
}
const input = Object.fromEntries(audit.input.map((r: any) => [r.type, r.n]));
ok(input.mm >= 20 && input.mb === 2 && input.kb === 2 && input.cmd === 1, `input log captured server-side ${JSON.stringify(input)}`);
if (expectRecording) ok(audit.session.recording_url, `recording_url set: ${audit.session.recording_url}`);
if (expectRecording && audit.session.recording_url) {
  const url = audit.session.recording_url.split(' ')[0];
  const res = await fetch(B + url, { headers: { cookie } });
  const size = Number(res.headers.get('content-length') ?? 0);
  ok(res.ok && size > 10_000, `recording downloadable (${size} bytes)`);
}
process.exit();

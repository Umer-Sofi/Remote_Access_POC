// Simulated endpoint client for testing the server side without native code.
// Speaks the same broker protocol as endpoint-mac / endpoint-win (shared/PROTOCOL.md),
// publishes a synthetic "screen" (VP9 screen-share track) and logs every input
// message it receives. It draws a crosshair where the operator's mouse is, so
// control can be verified end to end in the browser and in the recording.
//
//   cd broker && npx tsx tools/fake-endpoint.ts --target fake-1 [--deny] [--broker ws://localhost:8080/ws/endpoint]
//
// Reads ENDPOINT_SECRET from the environment or ../.env.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  LocalVideoTrack, Room, RoomEvent, TrackPublishOptions, TrackSource, VideoBufferType, VideoCodec, VideoFrame, VideoSource,
} from '@livekit/rtc-node';
import { WebSocket } from 'ws';

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const envFile = (() => { try { return readFileSync(new URL('../../.env', import.meta.url), 'utf8'); } catch { return ''; } })();
const secret = process.env.ENDPOINT_SECRET ?? /^ENDPOINT_SECRET=(.*)$/m.exec(envFile)?.[1] ?? '';
const brokerUrl = arg('broker', 'ws://localhost:8080/ws/endpoint')!;
const targetId = arg('target', 'fake-1')!;
const deny = flag('deny');
const seconds = Number(arg('seconds', '0')); // auto-end after N seconds (0 = never)

const W = 1280, H = 720;
let mouse = { x: 0.5, y: 0.5 }, pressed = false, keys = 0;
let room: Room | undefined;
let currentSession: string | undefined;

const ws = new WebSocket(brokerUrl);
const send = (m: object) => ws.send(JSON.stringify(m));

ws.on('open', () => send({ type: 'hello', targetId, platform: 'mac', hostname: `${hostname()} (fake)`, secret, version: 'fake-0.1' }));
ws.on('close', (code, reason) => { console.log(`broker link closed ${code} ${reason}`); void shutdown(); });
ws.on('message', async (raw) => {
  const m = JSON.parse(raw.toString());
  console.log('<-', m.type, m.type === 'session.token' ? '(token redacted)' : JSON.stringify(m));
  switch (m.type) {
    case 'session.request':
      currentSession = m.sessionId;
      send({ type: 'session.state', sessionId: m.sessionId, state: 'consent_shown' });
      setTimeout(() => send({ type: 'consent.result', sessionId: m.sessionId, decision: deny ? 'deny' : 'allow' }), 800);
      break;
    case 'session.token':
      send({ type: 'session.state', sessionId: m.sessionId, state: 'connecting' });
      await startStreaming(m.livekitUrl, m.token, m.sessionId);
      break;
    case 'session.end':
      await shutdown();
  }
});

async function startStreaming(url: string, token: string, sessionId: string) {
  room = new Room();
  room.on(RoomEvent.DataReceived, (payload, _participant, _k, topic) => {
    const msg = JSON.parse(new TextDecoder().decode(payload));
    if (msg.t === 'mm') mouse = { x: msg.x, y: msg.y };
    else if (msg.t === 'mb') pressed = msg.down;
    else if (msg.t === 'kb' && msg.down) keys++;
    if (msg.t !== 'mm') console.log(`input [${topic}]:`, JSON.stringify(msg));
  });
  await room.connect(url, token, { autoSubscribe: true, dynacast: false });

  const source = new VideoSource(W, H);
  const track = LocalVideoTrack.createVideoTrack('screen', source);
  await room.localParticipant!.publishTrack(track, new TrackPublishOptions({
    source: TrackSource.SOURCE_SCREENSHARE,
    videoCodec: VideoCodec.VP9,
    simulcast: false,
    videoEncoding: { maxBitrate: BigInt(3_000_000), maxFramerate: 15 },
  }));
  send({ type: 'session.state', sessionId, state: 'streaming' });
  console.log('streaming synthetic screen');

  const buf = new Uint8Array(W * H * 4);
  let frame = 0;
  const timer = setInterval(() => {
    draw(buf, frame++);
    source.captureFrame(new VideoFrame(buf, W, H, VideoBufferType.RGBA));
  }, 1000 / 15);
  const hb = setInterval(() => send({ type: 'session.state', sessionId, state: 'heartbeat' }), 5000);
  room.on(RoomEvent.Disconnected, () => { clearInterval(timer); clearInterval(hb); });
  if (seconds > 0) setTimeout(() => send({ type: 'session.state', sessionId, state: 'ended' }), seconds * 1000);
}

// Grey desktop, a moving bar (proves frames are live), a block per key typed,
// and a crosshair at the operator's mouse (red while a button is held).
function draw(buf: Uint8Array, n: number) {
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 40; buf[i + 1] = 44; buf[i + 2] = 52; buf[i + 3] = 255; }
  const rect = (x0: number, y0: number, w: number, h: number, r: number, g: number, b: number) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
        const o = (y * W + x) * 4; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
      }
  };
  rect((n * 8) % W, 40, 60, 20, 61, 139, 253);
  for (let k = 0; k < Math.min(keys, 60); k++) rect(20 + k * 20, 90, 14, 14, 48, 164, 108);
  const cx = Math.round(mouse.x * (W - 1)), cy = Math.round(mouse.y * (H - 1));
  const [r, g, b] = pressed ? [229, 72, 77] : [255, 255, 255];
  rect(cx - 15, cy - 1, 31, 3, r, g, b);
  rect(cx - 1, cy - 15, 3, 31, r, g, b);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`session ${currentSession ?? '-'} over; exiting (ephemeral)`);
  await room?.disconnect().catch(() => {});
  ws.close();
  process.exit(0);
}

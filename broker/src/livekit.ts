// Everything the broker does against LiveKit: create recorded rooms, tear them
// down, run the hidden "audit tap" participant, and verify webhooks.
import { Room as RtcRoom, RoomEvent } from '@livekit/rtc-node';
import { AutoTrackEgress, RoomEgress, RoomServiceClient, WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import { logInput } from './audit.js';
import { config } from './config.js';
import { TAP_IDENTITY, tapToken } from './tokens.js';

const rooms = new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);
const webhooks = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);

export const roomName = (sessionId: string) => `sess-${sessionId}`;

/**
 * Creates the session's room with Auto Track Egress attached. Every track anyone
 * publishes into this room is recorded to a file by the egress service, with no
 * per-track API call and nothing the endpoint can opt out of. Rooms cannot be
 * auto-created by clients (room.auto_create=false in livekit.yaml), so the only
 * way to get media into the SFU is a room made here, with recording on.
 *
 * Track egress is passthrough (VP9 in, .webm out, no transcoding), so recording
 * costs almost no CPU.
 */
export async function createRecordedRoom(sessionId: string) {
  const name = roomName(sessionId);
  await rooms.createRoom({
    name,
    emptyTimeout: 120,
    departureTimeout: 30,
    maxParticipants: 4, // endpoint + operator + audit tap (+1 spare for operator reconnect)
    metadata: JSON.stringify({ sessionId }),
    egress: config.recordingMode === 'local'
      ? new RoomEgress({
          tracks: new AutoTrackEgress({ filepath: `${config.egressOutDir}/${name}/{track_source}-{track_id}-{time}` }),
        })
      : undefined,
  });
  return name;
}

/** Deleting the room disconnects everyone and makes egress finalize the file. */
export async function deleteRoom(name: string) {
  try {
    await rooms.deleteRoom(name);
  } catch (err) {
    // Already gone (empty timeout, or never created) is fine.
    console.warn(`[livekit] deleteRoom ${name}: ${(err as Error).message}`);
  }
}

export async function smokeRoom(name: string) {
  await rooms.createRoom({ name, emptyTimeout: 300 });
}

export async function verifyWebhook(body: string, auth: string | undefined): Promise<WebhookEvent> {
  return webhooks.receive(body, auth);
}

/**
 * Audit tap (spec §12.2): the broker joins each session room as a hidden,
 * receive-only participant and logs every data-channel message the operator
 * sends. The log is captured server-side, independent of both the browser
 * and the endpoint, so neither side can leave anything out of it.
 */
export class AuditTap {
  private room = new RtcRoom();
  private decoder = new TextDecoder();

  /**
   * @param dataPublisher identity of the only participant whose token grants
   *   canPublishData in this room (the operator). rtc-node cannot always resolve
   *   the sender of a data packet (non-publishing participants are not in its
   *   participant map), but the SFU enforces grants, so attribution by grant is exact.
   */
  constructor(private sessionId: string, private name: string, private dataPublisher: string) {}

  async start() {
    this.room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== 'input') return;
      let msg: unknown;
      try {
        msg = JSON.parse(this.decoder.decode(payload));
      } catch {
        msg = { invalid: true, bytes: payload.length };
      }
      logInput(this.sessionId, participant?.identity ?? this.dataPublisher, msg);
    });
    await this.room.connect(config.livekit.wsUrl, await tapToken(this.name), { autoSubscribe: false, dynacast: false });
    console.log(`[tap] ${TAP_IDENTITY} joined ${this.name}`);
  }

  async stop() {
    try {
      await this.room.disconnect();
    } catch {
      /* room already deleted */
    }
  }
}

// M1 smoke test (spec §7 step 5): open this page in two tabs. Tab A shares its
// screen, tab B sees it, and the media path is browser → LiveKit SFU → browser,
// before any native endpoint code exists.
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export function Smoke() {
  const [room, setRoom] = useState<Room>();
  const [log, setLog] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const say = (s: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()} ${s}`]);

  useEffect(() => () => { void room?.disconnect(); }, [room]);

  const join = async () => {
    const { livekitUrl, token, room: name } = await api.smokeToken();
    const r = new Room({ adaptiveStream: false, dynacast: false });
    r.on(RoomEvent.ParticipantConnected, (p) => say(`participant joined: ${p.identity}`))
      .on(RoomEvent.TrackSubscribed, (t: RemoteTrack, _pub, p) => {
        if (t.kind === Track.Kind.Video && videoRef.current) {
          t.attach(videoRef.current);
          say(`receiving ${t.source} from ${p.identity} via SFU`);
        }
      });
    await r.connect(livekitUrl, token);
    say(`connected to room "${name}" as ${r.localParticipant.identity}`);
    setRoom(r);
  };

  const share = async () => {
    await room!.localParticipant.setScreenShareEnabled(
      true,
      { contentHint: 'text', resolution: { width: 1920, height: 1080, frameRate: 30 } },
      { videoCodec: 'vp9', screenShareEncoding: { maxBitrate: 6_000_000, maxFramerate: 30 } },
    );
    say('publishing screen share (VP9, contentHint=text)');
  };

  return (
    <div className="panel">
      <h2>SFU smoke test</h2>
      <p>Open this page in two tabs. Click <b>Join</b> in both, then <b>Share screen</b> in one.</p>
      <div className="row">
        <button onClick={join} disabled={!!room}>Join</button>
        <button onClick={share} disabled={!room}>Share screen</button>
      </div>
      <video ref={videoRef} autoPlay playsInline muted className="smoke-video" />
      <pre className="log">{log.join('\n')}</pre>
    </div>
  );
}

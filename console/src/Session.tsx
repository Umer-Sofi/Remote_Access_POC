// Live session: wait for consent → join LiveKit room → show the target's screen,
// capture input, offer the control panel. (spec §8.4)
import { RemoteTrack, Room, RoomEvent, Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Scope, type SessionStatus } from './api';
import { attachInput, enterFullscreenWithKeyboardLock, type InputMsg } from './input';

interface Stats {
  width?: number; height?: number; fps?: number; kbps?: number; codec?: string;
  rttMs?: number; route?: string; lost?: number;
}

const encoder = new TextEncoder();

export function Session({ sessionId, onExit }: { sessionId: string; onExit: () => void }) {
  const [status, setStatus] = useState<SessionStatus>();
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [stats, setStats] = useState<Stats>({});
  const [kbLock, setKbLock] = useState<boolean>();
  const roomRef = useRef<Room | null>(null);
  const trackRef = useRef<RemoteTrack | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<Scope>('control');

  const terminal = status?.state === 'ENDED' || status?.state === 'DENIED';
  scopeRef.current = status?.scope ?? 'control';

  // ---- poll the broker for state (and, once approved, a fresh join token) ----
  useEffect(() => {
    if (terminal) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.session(sessionId);
        if (stop) return;
        setStatus(s);
        if (s.token && s.livekitUrl && !roomRef.current) void join(s.livekitUrl, s.token);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, connected ? 2000 : 1000);
    return () => { stop = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, terminal, connected]);

  // ---- LiveKit room ----
  const join = async (url: string, token: string) => {
    const room = new Room({ adaptiveStream: false, dynacast: false });
    roomRef.current = room;
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
        if (track.kind !== Track.Kind.Video || !videoRef.current) return;
        pub.setVideoQuality(VideoQuality.HIGH);
        track.attach(videoRef.current);
        trackRef.current = track;
        setHasVideo(true);
        surfaceRef.current?.focus();
      })
      .on(RoomEvent.TrackUnsubscribed, () => { trackRef.current = null; setHasVideo(false); })
      .on(RoomEvent.Disconnected, () => { setConnected(false); setHasVideo(false); });
    try {
      await room.connect(url, token, { autoSubscribe: true });
      setConnected(true);
    } catch (e) {
      roomRef.current = null;
      setError(`could not join media room: ${(e as Error).message}`);
    }
  };

  useEffect(() => () => { void roomRef.current?.disconnect(); }, []);
  useEffect(() => { if (terminal) void roomRef.current?.disconnect(); }, [terminal]);

  // ---- input capture ----
  const send = useCallback((m: InputMsg) => {
    const room = roomRef.current;
    if (!room || room.state !== 'connected') return;
    void room.localParticipant.publishData(encoder.encode(JSON.stringify(m)), { reliable: true, topic: 'input' });
  }, []);

  useEffect(() => {
    if (!hasVideo || !surfaceRef.current || !videoRef.current) return;
    return attachInput(surfaceRef.current, videoRef.current, send, () => scopeRef.current === 'control');
  }, [hasVideo, send]);

  // ---- stats for the M6 legibility/latency check ----
  useEffect(() => {
    if (!hasVideo) return;
    let prev: { bytes: number; ts: number } | undefined;
    const id = setInterval(async () => {
      const t = trackRef.current as (RemoteTrack & { getReceiverStats?: () => Promise<any> }) | null;
      if (!t) return;
      const rs = await t.getReceiverStats?.();
      const report = await t.getRTCStatsReport();
      const next: Stats = {};
      if (rs) {
        next.width = rs.frameWidth;
        next.height = rs.frameHeight;
        next.codec = rs.mimeType?.replace('video/', '');
        next.lost = rs.packetsLost;
        if (prev && rs.bytesReceived) next.kbps = Math.round(((rs.bytesReceived - prev.bytes) * 8) / (rs.timestamp - prev.ts));
        prev = { bytes: rs.bytesReceived ?? 0, ts: rs.timestamp };
      }
      report?.forEach((r: any) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') next.fps = r.framesPerSecond;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
          next.rttMs = r.currentRoundTripTime !== undefined ? Math.round(r.currentRoundTripTime * 1000) : undefined;
          const local = report.get(r.localCandidateId);
          if (local) next.route = `${local.candidateType}/${local.relayProtocol ?? local.protocol}`;
        }
      });
      setStats(next);
    }, 1000);
    return () => clearInterval(id);
  }, [hasVideo]);

  // ---- control panel ----
  const toggleScope = async () => {
    const next: Scope = status?.scope === 'control' ? 'view' : 'control';
    try {
      const r = await api.setScope(sessionId, next);
      setStatus((s) => (s ? { ...s, scope: r.scope, reconsentPending: r.reconsentPending } : s));
      if (next === 'view') send({ t: 'scope', value: 'view' });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const disconnect = async () => {
    await api.endSession(sessionId).catch(() => undefined);
    await roomRef.current?.disconnect();
    onExit();
  };

  const fullscreen = async () => {
    if (!surfaceRef.current) return;
    setKbLock(await enterFullscreenWithKeyboardLock(surfaceRef.current));
    surfaceRef.current.focus();
  };

  // ---- render ----
  const phase = !status ? 'Loading…'
    : status.state === 'REQUESTED' || status.state === 'CONSENT_PENDING' ? 'Waiting for the user to allow the session…'
    : status.state === 'APPROVED' && !hasVideo ? 'Approved. Waiting for the target to start streaming…'
    : status.state === 'DENIED' ? 'The user denied the request (or it timed out).'
    : status.state === 'ENDED' ? `Session ended (${status.endReason ?? 'ended'}).`
    : null;

  return (
    <div className="session">
      <div className="toolbar">
        <strong>{status?.target}</strong>
        <span className={`badge state-${status?.state}`}>{status?.state}</span>
        <span className={`badge ${status?.recording ? 'rec' : ''}`}>{status?.recording ? '● REC' : 'not recording'}</span>
        <span className="badge">{status?.scope === 'control' ? 'Control' : 'View only'}</span>
        {status?.reconsentPending && <span className="badge warn">awaiting user approval for control</span>}
        <span className="spacer" />
        <button disabled={!hasVideo || status?.scope !== 'control'} onClick={() => send({ t: 'cmd', name: 'ctrl-alt-del' })}>
          Ctrl-Alt-Del
        </button>
        <button disabled={!hasVideo || status?.reconsentPending} onClick={toggleScope}>
          {status?.scope === 'control' ? 'Switch to view only' : 'Request control'}
        </button>
        <button disabled={!hasVideo} onClick={fullscreen}>Fullscreen</button>
        {terminal ? <button onClick={onExit}>Back</button> : <button className="danger" onClick={disconnect}>Disconnect</button>}
      </div>

      {error && <div className="error">{error}</div>}

      <div
        ref={surfaceRef}
        className={`viewer ${status?.scope === 'control' ? 'control' : ''}`}
        tabIndex={0}
      >
        <video ref={videoRef} autoPlay playsInline muted />
        {phase && <div className="overlay">{phase}</div>}
      </div>

      {hasVideo && (
        <div className="stats">
          <span>{stats.width}×{stats.height}</span>
          <span>{stats.fps?.toFixed?.(0) ?? '–'} fps</span>
          <span>{stats.kbps ?? '–'} kbps</span>
          <span>{stats.codec ?? '–'}</span>
          <span>RTT {stats.rttMs ?? '–'} ms</span>
          <span title="local ICE candidate type / protocol. relay = via TURN">route {stats.route ?? '–'}</span>
          <span>lost {stats.lost ?? 0}</span>
          {kbLock !== undefined && <span>keyboard lock: {kbLock ? 'on' : 'unsupported'}</span>}
        </div>
      )}
    </div>
  );
}

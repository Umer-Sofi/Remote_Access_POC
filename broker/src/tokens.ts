// LiveKit access-token minting. Every token is short-lived and scoped to exactly
// one room, with the minimum grants for its role (spec §8.1).
import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk';
import { config } from './config.js';

async function mint(identity: string, grant: VideoGrant, opts: { name?: string; metadata?: string } = {}) {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    name: opts.name,
    metadata: opts.metadata,
    ttl: config.tokenTtlS,
  });
  at.addGrant(grant);
  return at.toJwt();
}

export const endpointIdentity = (targetId: string) => `endpoint:${targetId}`;
export const operatorIdentity = (username: string) => `operator:${username}`;
export const TAP_IDENTITY = 'audit-tap';

/** Target machine: may publish ONLY a screen-share track. It needs no data-publish right; it only receives input. */
export function endpointToken(room: string, targetId: string) {
  return mint(endpointIdentity(targetId), {
    room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.SCREEN_SHARE],
    canPublishData: false,
    canSubscribe: true, // needed to receive data packets
  }, { name: targetId });
}

/** Operator browser: may watch and send input data, but never publish media. */
export function operatorToken(room: string, username: string) {
  return mint(operatorIdentity(username), {
    room,
    roomJoin: true,
    canPublish: false,
    canPublishData: true,
    canSubscribe: true,
  }, { name: username });
}

/** Broker's own hidden participant that logs every input message server-side. */
export function tapToken(room: string) {
  return mint(TAP_IDENTITY, {
    room,
    roomJoin: true,
    hidden: true,
    recorder: true,
    canPublish: false,
    canPublishData: false,
    canSubscribe: true,
  });
}

/** M1 smoke test only: a browser tab that may publish a screen share into the smoke room. */
export function smokeToken(room: string, identity: string) {
  return mint(identity, {
    room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.SCREEN_SHARE],
    canPublishData: true,
    canSubscribe: true,
  });
}

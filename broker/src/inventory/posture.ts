// Posture provider backed by Axonius inventory: a target may be connected to only if its
// live endpoint matches an inventory device that carries the remote-access-allowed tag.
// This is the SERVER-SIDE enforcement (the console gating is cosmetic). Used in place of
// AllowListPosture whenever INVENTORY_MODE is not "off".
import { getEndpoint } from '../endpoints.js';
import type { PostureProvider, PostureResult, TargetId } from '../providers/types.js';
import { matchEndpoint } from './matcher.js';

const REQUIRED_TAG = 'remote-access-allowed';

export class AxoniusPosture implements PostureProvider {
  async check(target: TargetId): Promise<PostureResult> {
    const e = getEndpoint(target);
    if (!e) return { allowed: false, reason: 'endpoint not connected' };
    // Match keys will include serial/MAC once the clients send them (today: hostname).
    const device = await matchEndpoint({ hostname: e.hostname });
    if (!device) return { allowed: false, reason: 'device is not in the Axonius inventory' };
    if (!device.tags.includes(REQUIRED_TAG)) {
      return { allowed: false, reason: `device is not tagged "${REQUIRED_TAG}"` };
    }
    return { allowed: true };
  }
}

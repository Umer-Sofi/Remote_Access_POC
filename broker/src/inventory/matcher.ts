// Links a live endpoint to its Axonius inventory record. Serial is the most reliable
// key (unique per machine), then MAC (can drift / be virtual), then hostname (weakest),
// so we try them in that order and take the first hit.
import { findByHostname, findByMac, findBySerial } from './store.js';
import type { InventoryDevice } from './types.js';

export interface MatchKeys {
  serial?: string | null;
  macs?: string[];
  hostname?: string | null;
}

export async function matchEndpoint(keys: MatchKeys): Promise<InventoryDevice | undefined> {
  if (keys.serial) {
    const hit = await findBySerial(keys.serial);
    if (hit) return hit;
  }
  if (keys.macs?.length) {
    const hit = await findByMac(keys.macs.map((m) => m.toUpperCase()));
    if (hit) return hit;
  }
  if (keys.hostname) {
    const hit = await findByHostname(keys.hostname);
    if (hit) return hit;
  }
  return undefined;
}

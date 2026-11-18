// Scheduled inventory refresh. Picks the provider from config (mock today, Axonius later),
// pulls the workstation list and upserts it into inventory_devices. This is the only file
// that decides which InventoryProvider is live — the "composition root" for inventory.
import { config } from '../config.js';
import { MockInventory } from './mock.js';
import { upsertDevices } from './store.js';
import type { InventoryProvider } from './types.js';

let provider: InventoryProvider | null = null;

export function inventoryEnabled(): boolean {
  return config.inventory.mode !== 'off';
}

function makeProvider(): InventoryProvider | null {
  switch (config.inventory.mode) {
    case 'mock':
      return new MockInventory();
    case 'axonius':
      // TODO: return new AxoniusInventory(config.inventory.axonius) once validated against a tenant.
      console.warn('[inventory] INVENTORY_MODE=axonius is not implemented yet; inventory disabled');
      return null;
    default:
      return null;
  }
}

/** Pull once now and upsert. Returns how many devices were synced. */
export async function syncNow(): Promise<number> {
  if (!provider) return 0;
  const devices = await provider.listWorkstations();
  const n = await upsertDevices(devices);
  console.log(`[inventory] synced ${n} device(s)`);
  return n;
}

/** Start the background refresh loop (no-op when disabled). Call once at boot. */
export function startInventorySync(): void {
  provider = makeProvider();
  if (!provider) {
    console.log('[inventory] disabled (INVENTORY_MODE=off)');
    return;
  }
  void syncNow().catch((e) => console.error('[inventory] initial sync failed', e));
  const ms = Math.max(1, config.inventory.syncMinutes) * 60_000;
  setInterval(() => void syncNow().catch((e) => console.error('[inventory] sync failed', e)), ms).unref();
  console.log(`[inventory] mode=${config.inventory.mode}, refresh every ${config.inventory.syncMinutes} min`);
}

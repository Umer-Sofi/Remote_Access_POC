// POC inventory source: serves the sample assets as if they came from Axonius.
// Implements the same InventoryProvider interface the real client will, so nothing
// downstream (sync, matcher, console) changes when we swap mock → real Axonius.
import { MOCK_ASSETS } from './mock-data.js';
import { parseAxoniusAsset } from './parse.js';
import type { InventoryDevice, InventoryProvider } from './types.js';

export class MockInventory implements InventoryProvider {
  private readonly devices: InventoryDevice[] = MOCK_ASSETS.map(parseAxoniusAsset);

  async listWorkstations(): Promise<InventoryDevice[]> {
    return this.devices;
  }

  async getDevice(axonId: string): Promise<InventoryDevice | undefined> {
    return this.devices.find((d) => d.axonId === axonId);
  }
}

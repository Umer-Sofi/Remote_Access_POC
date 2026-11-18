// The inventory layer, kept behind an interface so the POC mock and the real
// Axonius client are interchangeable (same pattern as broker/src/providers).

/** Normalized device record the rest of the broker uses — adapter-agnostic. */
export interface InventoryDevice {
  axonId: string;         // Axonius internal_axon_id — the stable unique id (goes into the audit log)
  hostname: string | null;
  os: string | null;      // e.g. "Windows 11", "macOS 15"
  serial: string | null;  // primary match key for linking a live endpoint
  macs: string[];         // uppercased MAC addresses (secondary match key)
  ips: string[];
  tags: string[];         // Axonius labels, e.g. ["remote-access-allowed", "finance"]
  lastSeen: string | null;
}

/** Pluggable inventory source: MockInventory now, AxoniusInventory later — same interface. */
export interface InventoryProvider {
  /** All workstation devices (already filtered to workstations by the saved query). */
  listWorkstations(): Promise<InventoryDevice[]>;
  /** One device by its Axonius id, or undefined if not found. */
  getDevice(axonId: string): Promise<InventoryDevice | undefined>;
}

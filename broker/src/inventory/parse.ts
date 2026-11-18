// Turns a raw Axonius asset (dotted field names, values as arrays) into our
// normalized InventoryDevice. Shared by the mock and the real Axonius client, so
// both produce identical records and only the transport differs.
import type { InventoryDevice } from './types.js';

type RawAsset = Record<string, unknown>;

/** First non-empty value of an Axonius field (which may be a scalar or an array). */
function first(v: unknown): string | null {
  if (Array.isArray(v)) {
    const hit = v.find((x) => x != null && x !== '');
    return hit == null ? null : String(hit);
  }
  return v == null || v === '' ? null : String(v);
}

/** All non-empty string values of an Axonius field. */
function all(v: unknown): string[] {
  if (Array.isArray(v)) return v.flat().filter((x): x is string => typeof x === 'string' && x !== '');
  return typeof v === 'string' && v ? [v] : [];
}

export function parseAxoniusAsset(a: RawAsset): InventoryDevice {
  const os = first(a['specific_data.data.os.type']);
  const dist = first(a['specific_data.data.os.distribution']);
  return {
    axonId: String(a['internal_axon_id'] ?? ''),
    hostname: first(a['specific_data.data.hostname']),
    os: os ? [os, dist].filter(Boolean).join(' ') : null,
    serial: first(a['specific_data.data.device_serial']),
    macs: all(a['specific_data.data.network_interfaces.mac_addresses']).map((m) => m.toUpperCase()),
    ips: all(a['specific_data.data.network_interfaces.ips']),
    tags: all(a['labels']),
    lastSeen: first(a['specific_data.data.last_seen']),
  };
}

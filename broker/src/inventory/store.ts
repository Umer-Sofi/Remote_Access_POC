// All database access for the inventory_devices table lives here: upsert (used by the
// sync), list (used by the console), and the three match lookups (used by the matcher).
import { db } from '../db.js';
import type { InventoryDevice } from './types.js';

type Row = {
  axon_id: string; hostname: string | null; os: string | null; serial: string | null;
  macs: string[]; ips: string[]; tags: string[]; last_seen: Date | null;
};

function toDevice(r: Row): InventoryDevice {
  return {
    axonId: r.axon_id, hostname: r.hostname, os: r.os, serial: r.serial,
    macs: r.macs ?? [], ips: r.ips ?? [], tags: r.tags ?? [],
    lastSeen: r.last_seen ? r.last_seen.toISOString() : null,
  };
}

const SELECT = `SELECT axon_id, hostname, os, serial, macs, ips, tags, last_seen FROM inventory_devices`;

/** Insert or update each device, keyed by its Axonius id (one row per device). */
export async function upsertDevices(devices: InventoryDevice[]): Promise<number> {
  for (const d of devices) {
    await db.query(
      `INSERT INTO inventory_devices (axon_id, hostname, os, serial, macs, ips, tags, last_seen, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (axon_id) DO UPDATE SET
         hostname = $2, os = $3, serial = $4, macs = $5, ips = $6, tags = $7, last_seen = $8, synced_at = now()`,
      [d.axonId, d.hostname, d.os, d.serial, d.macs, d.ips, d.tags, d.lastSeen],
    );
  }
  return devices.length;
}

export async function listDevices(): Promise<InventoryDevice[]> {
  const r = await db.query(`${SELECT} ORDER BY hostname`);
  return (r.rows as Row[]).map(toDevice);
}

export async function findBySerial(serial: string): Promise<InventoryDevice | undefined> {
  const r = await db.query(`${SELECT} WHERE serial = $1 LIMIT 1`, [serial]);
  return r.rows[0] ? toDevice(r.rows[0] as Row) : undefined;
}

/** Any device whose MAC list overlaps the given MACs (Postgres array overlap operator &&). */
export async function findByMac(macs: string[]): Promise<InventoryDevice | undefined> {
  if (!macs.length) return undefined;
  const r = await db.query(`${SELECT} WHERE macs && $1 LIMIT 1`, [macs]);
  return r.rows[0] ? toDevice(r.rows[0] as Row) : undefined;
}

export async function findByHostname(hostname: string): Promise<InventoryDevice | undefined> {
  const r = await db.query(`${SELECT} WHERE lower(hostname) = lower($1) LIMIT 1`, [hostname]);
  return r.rows[0] ? toDevice(r.rows[0] as Row) : undefined;
}

// Device credentials: what an endpoint that enrolled through an invite link presents in its
// `hello` frame instead of the shared ENDPOINT_SECRET. Each credential is bound to one
// target id, so a stolen credential cannot be used to impersonate a different computer.
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 256 random bits, URL-safe. High entropy, so a plain SHA-256 is enough to store it. */
export const newSecret = (prefix = '') => prefix + randomBytes(32).toString('base64url');

export async function verifyDevice(deviceToken: string, targetId: string): Promise<boolean> {
  if (!deviceToken.startsWith('dev_')) return false;
  const r = await db.query(
    'UPDATE devices SET last_seen_at = now() WHERE credential_hash = $1 AND target_id = $2 AND revoked_at IS NULL RETURNING id',
    [sha256(deviceToken), targetId],
  );
  return r.rowCount === 1;
}

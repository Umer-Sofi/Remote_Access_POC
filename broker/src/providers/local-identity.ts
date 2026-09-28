import { timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Identity, IdentityProvider } from './types.js';

/** POC identity: operators listed in OPERATORS="alice:pass,bob:pass", sessions are 8 h HS256 JWTs. */
export class LocalIdentityProvider implements IdentityProvider {
  private users = new Map<string, string>();
  private key: Uint8Array;

  constructor(operators: string, jwtSecret: string) {
    for (const pair of operators.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = pair.indexOf(':');
      if (i > 0) this.users.set(pair.slice(0, i), pair.slice(i + 1));
    }
    this.key = new TextEncoder().encode(jwtSecret);
  }

  async login(username: string, password: string): Promise<string | null> {
    const expected = this.users.get(username);
    if (!expected || !safeEqual(expected, password)) return null;
    return new SignJWT({ roles: ['operator'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(username)
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(this.key);
  }

  async resolve(token: string): Promise<Identity> {
    const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
    const username = String(payload.sub);
    if (!this.users.has(username)) throw new Error('unknown operator');
    return { username, displayName: username, roles: (payload.roles as string[]) ?? [] };
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

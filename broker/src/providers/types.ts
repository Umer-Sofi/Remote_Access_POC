// The five provider interfaces from spec §9. Session logic only ever talks to
// these interfaces; swapping a POC stub for a real integration (CrowdStrike RTR,
// Entra ID, Intune posture, ...) means writing a new class, not a rewrite.

export type TargetId = string;

export interface Identity {
  username: string;
  displayName: string;
  roles: string[];
}

export interface PostureResult {
  allowed: boolean;
  reason?: string;
}

/** How the endpoint client gets onto the target. POC: the user downloads it. Later: CrowdStrike RTR, Intune install. */
export interface BootstrapProvider {
  deliver(target: TargetId): Promise<void>;
  /** Human-readable instructions shown in the console for targets that are not online. */
  instructions(): string;
}

/** Ephemeral (exit after one session) vs persistent agent. POC: ephemeral. */
export interface LifecycleProvider {
  mode(): 'ephemeral' | 'agent';
}

/** Which security context the endpoint runs in. POC: the logged-in user. Later: SYSTEM service, step-up admin. */
export interface PrivilegeProvider {
  context(): 'user' | 'system';
}

/** Who the operator is. POC: local users from env. Later: Entra ID / AD. */
export interface IdentityProvider {
  /** Exchange credentials for a signed session token (the POC's "login"). */
  login(username: string, password: string): Promise<string | null>;
  /** Resolve a session token back to an identity (throws if invalid/expired). */
  resolve(token: string): Promise<Identity>;
}

/** Device trust for authorization. POC: static allow-list. Later: live CrowdStrike / Intune posture. */
export interface PostureProvider {
  check(target: TargetId): Promise<PostureResult>;
}

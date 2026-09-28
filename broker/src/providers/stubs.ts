import type {
  BootstrapProvider, LifecycleProvider, PostureProvider, PostureResult, PrivilegeProvider, TargetId,
} from './types.js';

/** POC: the target user downloads and runs the endpoint client themselves. */
export class UserDownloadBootstrap implements BootstrapProvider {
  async deliver(target: TargetId): Promise<void> {
    console.log(`[bootstrap] target ${target}: waiting for the user to run the downloaded client`);
  }
  instructions(): string {
    return 'Ask the user to download and run the Remote Access client (macOS: RemoteAccessEndpoint.app, Windows: remote-access-endpoint.exe).';
  }
}

/** POC: ephemeral, the client exits after one session. */
export class EphemeralLifecycle implements LifecycleProvider {
  mode() { return 'ephemeral' as const; }
}

/** POC: runs as the logged-in user (no SYSTEM service, no UAC secure desktop). */
export class UserPrivilege implements PrivilegeProvider {
  context() { return 'user' as const; }
}

/** POC: a static allow-list from TARGET_ALLOWLIST ("*" = any registered target). */
export class AllowListPosture implements PostureProvider {
  private allowAll: boolean;
  private allowed: Set<string>;
  constructor(list: string) {
    const items = list.split(',').map((s) => s.trim()).filter(Boolean);
    this.allowAll = items.includes('*');
    this.allowed = new Set(items);
  }
  async check(target: TargetId): Promise<PostureResult> {
    if (this.allowAll || this.allowed.has(target)) return { allowed: true };
    return { allowed: false, reason: `target ${target} is not on the posture allow-list` };
  }
}

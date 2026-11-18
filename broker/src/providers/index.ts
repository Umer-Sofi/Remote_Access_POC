// Composition root for providers: the ONE place that decides which implementation
// of each interface is live. Replace a line here to plug in a real integration.
import { config } from '../config.js';
import { AxoniusPosture } from '../inventory/posture.js';
import { LocalIdentityProvider } from './local-identity.js';
import { AllowListPosture, EphemeralLifecycle, UserDownloadBootstrap, UserPrivilege } from './stubs.js';
import type { BootstrapProvider, IdentityProvider, LifecycleProvider, PostureProvider, PrivilegeProvider } from './types.js';

export const providers: {
  bootstrap: BootstrapProvider;
  lifecycle: LifecycleProvider;
  privilege: PrivilegeProvider;
  identity: IdentityProvider;
  posture: PostureProvider;
} = {
  bootstrap: new UserDownloadBootstrap(),
  lifecycle: new EphemeralLifecycle(),
  privilege: new UserPrivilege(),
  identity: new LocalIdentityProvider(config.operators, config.jwtSecret),
  // With inventory enabled, the tag decides who may be connected; otherwise the static allow-list.
  posture: config.inventory.mode === 'off'
    ? new AllowListPosture(config.targetAllowlist)
    : new AxoniusPosture(),
};

export type * from './types.js';

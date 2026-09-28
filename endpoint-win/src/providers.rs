//! Client-side halves of the provider interfaces (spec §9). Identity and Posture
//! are owned by the broker; the endpoint only needs delivery, lifetime and privilege.
#![allow(dead_code)]

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleMode {
    Ephemeral,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrivilegeContext {
    User,
    System,
}

pub trait BootstrapProvider {
    fn delivery_method(&self) -> &'static str;
}
pub trait LifecycleProvider {
    fn mode(&self) -> LifecycleMode;
}
pub trait PrivilegeProvider {
    fn context(&self) -> PrivilegeContext;
}

/// POC: the user downloaded and ran the exe. Later: CrowdStrike RTR / Intune install.
pub struct UserDownload;
impl BootstrapProvider for UserDownload {
    fn delivery_method(&self) -> &'static str {
        "user-download"
    }
}

/// POC: exit after one session. Later: persistent agent that re-registers.
pub struct Ephemeral;
impl LifecycleProvider for Ephemeral {
    fn mode(&self) -> LifecycleMode {
        LifecycleMode::Ephemeral
    }
}

/// POC: runs in the interactive user's context, so no UAC secure desktop, no
/// SYSTEM capture, and no real SAS. Later: a SYSTEM service that can call SendSAS
/// and follow the secure desktop.
pub struct UserContext;
impl PrivilegeProvider for UserContext {
    fn context(&self) -> PrivilegeContext {
        PrivilegeContext::User
    }
}

pub const BOOTSTRAP: UserDownload = UserDownload;
pub const LIFECYCLE: Ephemeral = Ephemeral;
pub const PRIVILEGE: UserContext = UserContext;

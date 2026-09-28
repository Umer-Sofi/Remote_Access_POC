// Client-side halves of the provider interfaces (spec §9). The broker owns
// Identity and Posture; the endpoint only needs to know how it was delivered,
// how long it lives, and which security context it runs in.

protocol BootstrapProvider { var deliveryMethod: String { get } }
protocol LifecycleProvider { var mode: LifecycleMode { get } }
protocol PrivilegeProvider { var context: PrivilegeContext { get } }

enum LifecycleMode { case ephemeral, agent }
enum PrivilegeContext { case user, system }

/// POC: the user downloaded and launched the app themselves. Later: Intune / Jamf / RTR install.
struct UserDownloadBootstrap: BootstrapProvider { let deliveryMethod = "user-download" }

/// POC: exit after one session. An `agent` implementation would return to idle and re-register.
struct EphemeralLifecycle: LifecycleProvider { let mode = LifecycleMode.ephemeral }

/// POC: runs as the logged-in user. Pre-logon / SYSTEM-equivalent (a LaunchDaemon) is later-phase.
struct UserPrivilege: PrivilegeProvider { let context = PrivilegeContext.user }

enum Providers {
    static let bootstrap: BootstrapProvider = UserDownloadBootstrap()
    static let lifecycle: LifecycleProvider = EphemeralLifecycle()
    static let privilege: PrivilegeProvider = UserPrivilege()
}

// macOS endpoint client entry point (spec §8.5 step 1: launch in ephemeral mode).
//
// Configuration, first match wins:
//   1. command line: --broker ws://host:8080/ws/endpoint --target mac-1 --secret S [--max-fps 30] [--max-dimension 0]
//   2. environment:  RA_BROKER, RA_TARGET, RA_SECRET
//   3. endpoint.json inside the .app bundle's Resources (what a downloadable build ships with)
//   4. the enrollment saved in the Keychain after the user opened an invite link (remoteaccess://enroll?…)
//
//   RemoteAccessEndpoint --enroll 'remoteaccess://enroll?token=…&server=…' [--yes]   enroll from a script (managed installs)
//
//   RemoteAccessEndpoint --self-test   checks the shared contract vectors and exits.
import AppKit
import Foundation

func log(_ s: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write(Data("[\(ts)] \(s)\n".utf8))
}

struct EndpointConfig {
    let brokerURL: URL
    let targetId: String
    let secret: String?       // shared ENDPOINT_SECRET (manual / baked builds)
    let deviceToken: String?  // per-computer credential from invite enrollment
    let maxFps: Int
    let maxDimension: Int

    static func load() -> EndpointConfig? {
        let args = CommandLine.arguments
        func arg(_ n: String) -> String? { args.firstIndex(of: "--\(n)").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
        let env = ProcessInfo.processInfo.environment
        var file: [String: Any] = [:]
        if let url = Bundle.main.url(forResource: "endpoint", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { file = obj }

        let maxFps = Int(arg("max-fps") ?? "") ?? 30
        let maxDimension = Int(arg("max-dimension") ?? "") ?? 0
        let defaultTarget = (Host.current().localizedName ?? "mac")
            .replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)

        if let broker = arg("broker") ?? env["RA_BROKER"] ?? file["broker"] as? String,
           let url = URL(string: broker),
           let secret = arg("secret") ?? env["RA_SECRET"] ?? file["secret"] as? String {
            return EndpointConfig(
                brokerURL: url,
                targetId: arg("target") ?? env["RA_TARGET"] ?? file["target"] as? String ?? defaultTarget,
                secret: secret, deviceToken: nil, maxFps: maxFps, maxDimension: maxDimension)
        }
        return EndpointConfig.from(EnrollmentStore.load(), maxFps: maxFps, maxDimension: maxDimension)
    }

    static func from(_ e: Enrollment?, maxFps: Int = 30, maxDimension: Int = 0) -> EndpointConfig? {
        guard let e, let url = URL(string: e.wsUrl) else { return nil }
        return EndpointConfig(brokerURL: url, targetId: e.targetId, secret: nil, deviceToken: e.deviceToken,
                              maxFps: maxFps, maxDimension: maxDimension)
    }
}

if CommandLine.arguments.contains("--self-test") {
    exit(runSelfTest() ? 0 : 1)
}

// Accessory app: no Dock icon or menu bar, just the consent prompt and the banner.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: EndpointController?
    private var enrolling = false

    /// Starts the normal endpoint lifecycle for an enrolled / configured computer.
    func run(_ config: EndpointConfig) {
        guard controller == nil else { return }
        Permissions.checkOnStartup() // spec §12.1: detect missing grants, guide the user
        let c = EndpointController(config: config)
        c.onRevoked = { [weak self] in self?.revoked() }
        controller = c
        c.start()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Must be registered this early to receive the remoteaccess:// event that launched us.
        NSAppleEventManager.shared().setEventHandler(
            self, andSelector: #selector(handleURLEvent(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--enroll"), i + 1 < args.count {
            guard let link = EnrollLink(args[i + 1]) else { log("--enroll: not a valid invite link"); exit(2) }
            enrolling = true
            Task { await self.enroll(link, assumeYes: args.contains("--yes")) }
            return
        }
        if let config = EndpointConfig.load() { return run(config) }
        log("not enrolled yet; waiting for an invite link (remoteaccess://enroll?…)")
        // Opened by hand rather than by a link: give a launch-by-URL a moment to arrive, then ask.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            guard !self.enrolling, self.controller == nil else { return }
            guard let link = Enroller.askForLink() else { exit(0) }
            self.enrolling = true
            Task { await self.enroll(link) }
        }
    }

    @objc func handleURLEvent(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
        Task { @MainActor in
            guard let link = EnrollLink(text) else { return log("ignored an unrecognised link") }
            guard self.controller == nil, !self.enrolling else {
                return Enroller.showError("This computer is already connected. To use a different invite, quit Remote Access and remove its saved connection first.")
            }
            self.enrolling = true
            await self.enroll(link)
        }
    }

    private func enroll(_ link: EnrollLink, assumeYes: Bool = false) async {
        defer { enrolling = false }
        do {
            let e = try await Enroller.enroll(link, assumeYes: assumeYes)
            if let config = EndpointConfig.from(e) { run(config) }
        } catch EnrollError.declined {
            if controller == nil { exit(0) }
        } catch {
            if assumeYes { log("enroll failed: \(error.localizedDescription)"); exit(1) }
            Enroller.showError(error.localizedDescription)
            if controller == nil { exit(1) }
        }
    }

    /// The broker rejected our credential (computer was removed by an operator).
    private func revoked() {
        EnrollmentStore.clear()
        Enroller.showError("This computer was disconnected from the server. If you still need help, open a new invite link.")
        exit(0)
    }
}

let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate // NSApplication keeps only a weak reference; this global keeps it alive
signal(SIGINT) { _ in exit(0) }
app.run()

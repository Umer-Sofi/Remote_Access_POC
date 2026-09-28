// macOS endpoint client entry point (spec §8.5 step 1: launch in ephemeral mode).
//
// Configuration, first match wins:
//   1. command line: --broker ws://host:8080/ws/endpoint --target mac-1 --secret S [--max-fps 30] [--max-dimension 0]
//   2. environment:  RA_BROKER, RA_TARGET, RA_SECRET
//   3. endpoint.json inside the .app bundle's Resources (what a downloadable build ships with)
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
    let secret: String
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

        let defaultTarget = (Host.current().localizedName ?? "mac")
            .replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
        guard let broker = arg("broker") ?? env["RA_BROKER"] ?? file["broker"] as? String,
              let url = URL(string: broker),
              let secret = arg("secret") ?? env["RA_SECRET"] ?? file["secret"] as? String
        else { return nil }
        return EndpointConfig(
            brokerURL: url,
            targetId: arg("target") ?? env["RA_TARGET"] ?? file["target"] as? String ?? defaultTarget,
            secret: secret,
            maxFps: Int(arg("max-fps") ?? "") ?? 30,
            maxDimension: Int(arg("max-dimension") ?? "") ?? 0)
    }
}

if CommandLine.arguments.contains("--self-test") {
    exit(runSelfTest() ? 0 : 1)
}

guard let config = EndpointConfig.load() else {
    log("usage: RemoteAccessEndpoint --broker ws://host:8080/ws/endpoint --secret <ENDPOINT_SECRET> [--target id]")
    exit(2)
}

// Accessory app: no Dock icon or menu bar, just the consent prompt and the banner.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

MainActor.assumeIsolated {
    Permissions.checkOnStartup() // spec §12.1: detect missing grants, guide the user
    let controller = EndpointController(config: config)
    controller.start()
    objc_setAssociatedObject(app, "controller", controller, .OBJC_ASSOCIATION_RETAIN)
}

signal(SIGINT) { _ in exit(0) }
app.run()

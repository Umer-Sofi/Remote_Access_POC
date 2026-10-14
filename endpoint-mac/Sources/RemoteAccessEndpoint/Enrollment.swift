// Invite-link enrollment (Phase 2 onboarding).
//
//   remoteaccess://enroll?token=<one-time>&server=<https://broker>
//        │  (browser hands it to this app, or the user pastes it)
//        ▼
//   confirm with the user ──▶ POST <server>/api/enroll ──▶ { deviceToken, targetId, wsUrl }
//        ▼
//   keep the device credential in the login Keychain; from then on the app connects with it.
//
// Nothing is captured or shared by enrolling. Sessions still need the user's Allow every time.
import AppKit
import Foundation
import Security
import ServiceManagement

struct Enrollment: Codable {
    let server: String
    let wsUrl: String
    let targetId: String
    let deviceToken: String
}

enum EnrollmentStore {
    private static let service = "com.example.remoteaccess.endpoint"
    private static let account = "enrollment"

    private static var fallbackFile: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("RemoteAccess/enrollment.json")
    }

    static func save(_ e: Enrollment) -> Bool {
        guard let data = try? JSONEncoder().encode(e) else { return false }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        if SecItemAdd(add as CFDictionary, nil) == errSecSuccess { return true }
        // Keychain refused (locked, or no interaction allowed): fall back to a private file.
        log("keychain unavailable; storing enrollment in Application Support (owner-only)")
        let dir = fallbackFile.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard (try? data.write(to: fallbackFile, options: .atomic)) != nil else { return false }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fallbackFile.path)
        return true
    }

    static func load() -> Enrollment? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
           let e = try? JSONDecoder().decode(Enrollment.self, from: data) { return e }
        if let data = try? Data(contentsOf: fallbackFile), let e = try? JSONDecoder().decode(Enrollment.self, from: data) { return e }
        return nil
    }

    static func clear() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                       kSecAttrAccount as String: account] as CFDictionary)
        try? FileManager.default.removeItem(at: fallbackFile)
    }
}

struct EnrollLink {
    let token: String
    let server: URL

    /// Accepts remoteaccess://enroll?token=…&server=… (what the invite page produces).
    init?(_ text: String) {
        guard let comps = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              comps.scheme == "remoteaccess", comps.host == "enroll",
              let token = comps.queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty,
              let server = comps.queryItems?.first(where: { $0.name == "server" })?.value,
              let url = URL(string: server), ["http", "https"].contains(url.scheme), url.host != nil
        else { return nil }
        self.token = token
        self.server = url
    }
}

enum EnrollError: LocalizedError {
    case declined, rejected(String), network(String)
    var errorDescription: String? {
        switch self {
        case .declined: return "Cancelled."
        case .rejected(let m): return m
        case .network(let m): return "Could not reach the server: \(m)"
        }
    }
}

enum Enroller {
    /// Asks the user, then exchanges the invite for a device credential and stores it.
    /// `assumeYes` skips the question; it is only reachable from the command line (managed installs).
    @MainActor
    static func enroll(_ link: EnrollLink, assumeYes: Bool = false) async throws -> Enrollment {
        var autoStart = true
        if !assumeYes {
            let host = link.server.host ?? link.server.absoluteString
            let alert = NSAlert()
            alert.messageText = "Connect this computer to \(host)?"
            alert.informativeText = """
            People at \(host) will be able to ask to view and control this screen.

            Nothing is shared unless you click Allow on a prompt each time, a red banner shows while a session is running, and you can end it at any time.
            """
            let box = NSButton(checkboxWithTitle: "Start automatically when I log in", target: nil, action: nil)
            box.state = .on
            alert.accessoryView = box
            alert.addButton(withTitle: "Connect")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { throw EnrollError.declined }
            autoStart = box.state == .on
        }

        var req = URLRequest(url: link.server.appendingPathComponent("api/enroll"), timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let hostname = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": link.token, "platform": "mac", "hostname": hostname])

        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await URLSession.shared.data(for: req) } catch { throw EnrollError.network(error.localizedDescription) }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard status == 200, let token = obj["deviceToken"] as? String, let target = obj["targetId"] as? String,
              let ws = obj["wsUrl"] as? String else {
            throw EnrollError.rejected(obj["error"] as? String ?? "The server refused the invite (HTTP \(status)).")
        }
        let e = Enrollment(server: link.server.absoluteString, wsUrl: ws, targetId: target, deviceToken: token)
        guard EnrollmentStore.save(e) else { throw EnrollError.rejected("Could not save the connection on this computer.") }
        if autoStart { try? SMAppService.mainApp.register() }
        log("enrolled as \(target) with \(link.server.host ?? "?")")
        return e
    }

    @MainActor
    static func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Remote Access could not connect"
        alert.informativeText = message
        alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    /// Shown when the app is opened by hand and no invite arrived: let the user paste the link instead.
    @MainActor
    static func askForLink() -> EnrollLink? {
        let alert = NSAlert()
        alert.messageText = "Paste your invite link"
        alert.informativeText = "Go back to the page you were sent and click “Connect this computer”. If nothing happened, copy the box at the bottom of that page and paste it here."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
        field.placeholderString = "remoteaccess://enroll?token=…"
        alert.accessoryView = field
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Quit")
        NSApp.activate(ignoringOtherApps: true)
        alert.window.initialFirstResponder = field
        while alert.runModal() == .alertFirstButtonReturn {
            if let link = EnrollLink(field.stringValue) { return link }
            alert.informativeText = "That doesn't look like an invite link. It should start with remoteaccess://enroll"
        }
        return nil
    }
}

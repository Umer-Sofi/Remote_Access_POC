// macOS TCC checks (spec §12.1). Two separate grants are needed:
//   Screen Recording → ScreenCaptureKit returns real pixels (otherwise black/empty)
//   Accessibility    → CGEventPost actually injects (otherwise a silent no-op)
// Both are bound to the app's code signature, which is why the .app must be
// signed with a stable identity (scripts/build-app.sh).
import AppKit
import ApplicationServices
import CoreGraphics

enum Permissions {
    static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }
    static var accessibility: Bool { AXIsProcessTrusted() }

    /// Triggers the system prompts once (macOS only shows each prompt the first time).
    static func requestIfNeeded() {
        if !screenRecording { _ = CGRequestScreenCaptureAccess() }
        if !accessibility {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        }
    }

    enum Pane: String {
        case screenRecording = "Privacy_ScreenCapture"
        case accessibility = "Privacy_Accessibility"
    }

    static func open(_ pane: Pane) {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)")!)
    }

    /// Startup check: never fail silently. Explain exactly what is missing and
    /// offer to open the right System Settings pane.
    @MainActor
    static func checkOnStartup() {
        let missing = [
            screenRecording ? nil : ("Screen Recording", "so the support operator can see your screen", Pane.screenRecording),
            accessibility ? nil : ("Accessibility", "so the operator can move the mouse and type (view-only works without it)", Pane.accessibility),
        ].compactMap { $0 }
        log("permissions: screenRecording=\(screenRecording) accessibility=\(accessibility)")
        guard !missing.isEmpty else { return }

        requestIfNeeded()
        for (name, why, pane) in missing {
            let alert = NSAlert()
            alert.messageText = "Remote Access needs the \(name) permission"
            alert.informativeText = """
            Enable “Remote Access” in System Settings → Privacy & Security → \(name), \(why).

            macOS applies this permission after the app restarts: quit and reopen Remote Access once you have enabled it.
            """
            alert.addButton(withTitle: "Open System Settings")
            alert.addButton(withTitle: "Continue")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn { open(pane) }
        }
    }
}

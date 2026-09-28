// Product-owned consent prompt (PROTOCOL.md §4.2): "<operator> wants to view and
// control your screen — Allow / Deny", with a 30 s countdown where timeout = deny.
// A custom floating panel rather than NSAlert so the countdown can update live and
// the window stays above other apps.
import AppKit

@MainActor
final class ConsentPrompt: NSObject, NSWindowDelegate {
    static let timeoutSeconds = 30

    private var panel: NSPanel?
    private var timer: Timer?
    private var remaining = ConsentPrompt.timeoutSeconds
    private var countdown: NSTextField?
    private var continuation: CheckedContinuation<Bool, Never>?

    /// Shows the prompt and resolves to true only if the user clicks Allow in time.
    func ask(operatorName: String, reason: String, scope: Scope) async -> Bool {
        await withCheckedContinuation { cont in
            continuation = cont
            show(operatorName: operatorName, reason: reason, scope: scope)
        }
    }

    private func show(operatorName: String, reason: String, scope: Scope) {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 210),
                            styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Remote Access request"
        panel.level = .modalPanel
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.delegate = self

        let what = scope == .control ? "view and control your screen" : "view your screen"
        let title = label("\(operatorName) wants to \(what)", size: 15, bold: true)
        let why = label(reason.isEmpty ? "No reason given." : "Reason: \(reason)", size: 13)
        let note = label("The session will be recorded. You can end it at any time from the red banner.", size: 11)
        note.textColor = .secondaryLabelColor
        let countdown = label("", size: 11)
        countdown.textColor = .secondaryLabelColor
        self.countdown = countdown

        let deny = NSButton(title: "Deny", target: self, action: #selector(denyClicked))
        deny.keyEquivalent = "\u{1b}" // Esc
        let allow = NSButton(title: "Allow", target: self, action: #selector(allowClicked))
        // Deliberately NOT the default (Return) button: consent must be a conscious click.

        let buttons = NSStackView(views: [countdown, NSView(), deny, allow])
        buttons.orientation = .horizontal
        let stack = NSStackView(views: [title, why, note, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 16, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = NSView()
        panel.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor),
            stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor),
            stack.bottomAnchor.constraint(equalTo: panel.contentView!.bottomAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
        ])

        self.panel = panel
        remaining = Self.timeoutSeconds
        updateCountdown()
        panel.center()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)

        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.remaining -= 1
                self.updateCountdown()
                if self.remaining <= 0 { self.finish(false) } // timeout = deny
            }
        }
    }

    private func updateCountdown() {
        countdown?.stringValue = "Automatically denied in \(remaining) s"
    }

    @objc private func allowClicked() { finish(true) }
    @objc private func denyClicked() { finish(false) }

    /// Dismisses the prompt without an answer (e.g. the broker cancelled the request).
    func cancel() { finish(false) }

    private func finish(_ allowed: Bool) {
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
        panel = nil
        continuation?.resume(returning: allowed)
        continuation = nil
    }

    private func label(_ text: String, size: CGFloat, bold: Bool = false) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        l.preferredMaxLayoutWidth = 400
        return l
    }
}

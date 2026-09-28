// Non-suppressible session banner (spec §8.5 step 7): a red pill at the top of
// the screen for the whole session, on every Space and above full-screen apps.
//
// "Non-suppressible" in practice:
//  * no close/minimise controls; it is not in the window cycle or Mission Control;
//  * it re-asserts itself on top every second and follows display changes;
//  * the only way to make it go away is End session (ends the session) or killing
//    the process, which drops the broker link and so also ends the session.
import AppKit

@MainActor
final class SessionBanner {
    private var panel: NSPanel?
    private var text: NSTextField?
    private var timer: Timer?
    var onEnd: (() -> Void)?

    func show(operatorName: String, scope: Scope) {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 36),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .screenSaver // above normal, floating and full-screen windows
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true

        let bg = NSView()
        bg.wantsLayer = true
        bg.layer?.backgroundColor = NSColor(calibratedRed: 0.85, green: 0.16, blue: 0.2, alpha: 0.96).cgColor
        bg.layer?.cornerRadius = 18

        let text = NSTextField(labelWithString: "")
        text.textColor = .white
        text.font = .boldSystemFont(ofSize: 13)
        self.text = text

        let end = NSButton(title: "End session", target: self, action: #selector(endClicked))
        end.bezelStyle = .rounded
        end.controlSize = .small

        let stack = NSStackView(views: [text, end])
        stack.orientation = .horizontal
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 16, bottom: 4, right: 8)
        stack.translatesAutoresizingMaskIntoConstraints = false
        bg.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: bg.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: bg.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: bg.trailingAnchor),
        ])
        panel.contentView = bg
        self.panel = panel

        update(operatorName: operatorName, scope: scope)
        position()
        panel.orderFrontRegardless()

        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.position()
                self?.panel?.orderFrontRegardless()
            }
        }
    }

    func update(operatorName: String, scope: Scope) {
        text?.stringValue = scope == .control
            ? "●  REMOTE SESSION  ·  \(operatorName) can see and control this screen  ·  recorded"
            : "●  REMOTE SESSION  ·  \(operatorName) can see this screen  ·  recorded"
        if let panel, let text {
            let width = text.intrinsicContentSize.width + 140
            panel.setContentSize(NSSize(width: width, height: 36))
            position()
        }
    }

    private func position() {
        guard let panel, let screen = NSScreen.main else { return }
        let f = screen.frame
        let size = panel.frame.size
        // Just below the menu bar, horizontally centred.
        panel.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: screen.visibleFrame.maxY - size.height - 6))
    }

    @objc private func endClicked() { onEnd?() }

    func hide() {
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
        panel = nil
    }
}

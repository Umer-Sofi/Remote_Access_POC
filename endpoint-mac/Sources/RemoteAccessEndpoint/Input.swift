// Data channel → CGEvent injection (spec §8.5 step 8, §12). Platform-specific step.
//
// Coordinates: CGEvent works in global display POINTS (top-left origin of the
// main display), so fractions are multiplied by the display's point size; the
// Retina scale factor is already folded into points. (Capture is in pixels.)
//
// Requires the Accessibility grant: without it CGEventPost is a silent no-op, so
// the controller checks Permissions.accessibility and reports input_unavailable.
import CoreGraphics
import Foundation

final class InputInjector: @unchecked Sendable {
    private let queue = DispatchQueue(label: "input.inject", qos: .userInteractive) // preserves order
    private let source = CGEventSource(stateID: .hidSystemState)
    private var scope: Scope = .view
    private var position = CGPoint.zero
    private var buttonsDown = Set<MouseButton>()
    private var keysDown = Set<CGKeyCode>()
    private var lastClick: (button: MouseButton, at: Date, point: CGPoint, count: Int)?

    func setScope(_ s: Scope) {
        queue.async {
            self.scope = s
            if s == .view { self.releaseAll() } // PROTOCOL.md §4.6
        }
    }

    func handle(_ data: Data) {
        guard let msg = InputMessage.parse(data) else { return }
        queue.async { self.apply(msg) }
    }

    func shutdown() { queue.sync { releaseAll() } }

    // MARK: -

    private func apply(_ msg: InputMessage) {
        if case .scope(let s) = msg {
            // Informational only: a downgrade may be applied, an upgrade NEVER (PROTOCOL.md §3).
            if s == .view { scope = .view; releaseAll() }
            return
        }
        guard scope == .control else { return }

        switch msg {
        case .mouseMove(let x, let y):
            position = toScreenPoint(x, y)
            let (type, button): (CGEventType, CGMouseButton) =
                buttonsDown.contains(.left) ? (.leftMouseDragged, .left)
                : buttonsDown.contains(.right) ? (.rightMouseDragged, .right)
                : buttonsDown.contains(.middle) ? (.otherMouseDragged, .center)
                : (.mouseMoved, .left)
            post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: position, mouseButton: button))

        case .mouseButton(let b, let down):
            let (downType, upType, cg): (CGEventType, CGEventType, CGMouseButton) = switch b {
            case .left: (.leftMouseDown, .leftMouseUp, .left)
            case .right: (.rightMouseDown, .rightMouseUp, .right)
            case .middle: (.otherMouseDown, .otherMouseUp, .center)
            }
            if down { buttonsDown.insert(b) } else { buttonsDown.remove(b) }
            let ev = CGEvent(mouseEventSource: source, mouseType: down ? downType : upType, mouseCursorPosition: position, mouseButton: cg)
            // macOS needs an explicit click count for double/triple clicks.
            ev?.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount(b, down: down)))
            post(ev)

        case .wheel(let dx, let dy):
            // DOM: +dy = content scrolls down. CG: positive wheel1 = scroll up.
            post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                         wheel1: Int32(clamping: -dy), wheel2: Int32(clamping: -dx), wheel3: 0))

        case .key(let code, let down, let mods):
            guard let vk = Generated.macKeyCodes[code] else { return } // unknown codes are ignored
            if down { keysDown.insert(vk) } else { keysDown.remove(vk) }
            let ev = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: down)
            ev?.flags = flags(mods)
            post(ev)

        case .command("ctrl-alt-del"):
            // macOS has no SAS; Cmd+Option+Esc (Force Quit Applications) is the closest equivalent.
            pressCombo([55, 58], key: 53, flags: [.maskCommand, .maskAlternate])

        case .command("release-all"):
            releaseAll()

        default:
            break
        }
    }

    private func toScreenPoint(_ x: Double, _ y: Double) -> CGPoint {
        let b = CGDisplayBounds(CGMainDisplayID()) // points
        let (px, py) = toPixels(x, y, width: Int(b.width), height: Int(b.height))
        return CGPoint(x: b.origin.x + CGFloat(px), y: b.origin.y + CGFloat(py))
    }

    private func clickCount(_ b: MouseButton, down: Bool) -> Int {
        guard down else { return lastClick?.count ?? 1 }
        let now = Date()
        if let l = lastClick, l.button == b, now.timeIntervalSince(l.at) < 0.5,
           abs(l.point.x - position.x) < 5, abs(l.point.y - position.y) < 5 {
            lastClick = (b, now, position, l.count + 1)
        } else {
            lastClick = (b, now, position, 1)
        }
        return lastClick!.count
    }

    private func flags(_ mods: Set<String>) -> CGEventFlags {
        var f: CGEventFlags = []
        if mods.contains("ctrl") { f.insert(.maskControl) }
        if mods.contains("alt") { f.insert(.maskAlternate) }
        if mods.contains("shift") { f.insert(.maskShift) }
        if mods.contains("meta") { f.insert(.maskCommand) }
        return f
    }

    private func pressCombo(_ modifiers: [CGKeyCode], key: CGKeyCode, flags: CGEventFlags) {
        for m in modifiers { post(CGEvent(keyboardEventSource: source, virtualKey: m, keyDown: true), flags: flags) }
        post(CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true), flags: flags)
        post(CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false), flags: flags)
        for m in modifiers.reversed() { post(CGEvent(keyboardEventSource: source, virtualKey: m, keyDown: false), flags: []) }
    }

    private func releaseAll() {
        for k in keysDown { post(CGEvent(keyboardEventSource: source, virtualKey: k, keyDown: false), flags: []) }
        keysDown.removeAll()
        for b in buttonsDown {
            let (t, cg): (CGEventType, CGMouseButton) = b == .left ? (.leftMouseUp, .left) : b == .right ? (.rightMouseUp, .right) : (.otherMouseUp, .center)
            post(CGEvent(mouseEventSource: source, mouseType: t, mouseCursorPosition: position, mouseButton: cg))
        }
        buttonsDown.removeAll()
    }

    private func post(_ ev: CGEvent?, flags: CGEventFlags? = nil) {
        guard let ev else { return }
        if let flags { ev.flags = flags }
        ev.post(tap: .cghidEventTap)
    }
}

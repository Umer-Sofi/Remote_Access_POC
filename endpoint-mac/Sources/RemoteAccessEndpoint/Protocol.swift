// Swift side of the shared endpoint contract (shared/PROTOCOL.md). The Windows
// client has the same logic in endpoint-win/src/protocol.rs; both are checked
// against shared/test-vectors.json via `--self-test` / `cargo test`.
import Foundation

enum Scope: String { case view, control }

// MARK: - Input wire protocol (data channel, topic "input")

enum MouseButton: String { case left, right, middle }

enum InputMessage: Equatable {
    case mouseMove(x: Double, y: Double)
    case mouseButton(MouseButton, down: Bool)
    case wheel(dx: Int, dy: Int)
    case key(code: String, down: Bool, mods: Set<String>)
    case command(String)
    case scope(Scope)

    /// Returns nil for anything malformed or unknown; the caller drops it.
    static func parse(_ data: Data) -> InputMessage? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["t"] as? String else { return nil }
        func num(_ k: String) -> Double? { (obj[k] as? NSNumber)?.doubleValue }
        switch t {
        case "mm":
            guard let x = num("x"), let y = num("y"), x.isFinite, y.isFinite else { return nil }
            return .mouseMove(x: x, y: y)
        case "mb":
            guard let b = (obj["button"] as? String).flatMap(MouseButton.init), let d = obj["down"] as? Bool else { return nil }
            return .mouseButton(b, down: d)
        case "mw":
            return .wheel(dx: Int(num("dx") ?? 0), dy: Int(num("dy") ?? 0))
        case "kb":
            guard let c = obj["code"] as? String, let d = obj["down"] as? Bool else { return nil }
            return .key(code: c, down: d, mods: Set(obj["mods"] as? [String] ?? []))
        case "cmd":
            guard let n = obj["name"] as? String else { return nil }
            return .command(n)
        case "scope":
            guard let v = (obj["value"] as? String).flatMap(Scope.init) else { return nil }
            return .scope(v)
        default:
            return nil
        }
    }
}

/// PROTOCOL.md §2: px = min(W-1, floor(clamp(x,0,1) * W)). Identical on Windows.
func toPixels(_ x: Double, _ y: Double, width w: Int, height h: Int) -> (Int, Int) {
    let cx = min(max(x, 0), 1), cy = min(max(y, 0), 1)
    return (min(w - 1, Int((cx * Double(w)).rounded(.down))), min(h - 1, Int((cy * Double(h)).rounded(.down))))
}

// MARK: - Broker control link messages

struct SessionRequest { let sessionId, operatorName, reason: String; let scope: Scope }
struct SessionToken { let sessionId, livekitUrl, token, room: String }

enum BrokerMessage {
    case helloOk
    case request(SessionRequest)
    case token(SessionToken)
    case scope(sessionId: String, Scope)
    case end(sessionId: String, reason: String)

    static func parse(_ text: String) -> BrokerMessage? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let type = obj["type"] as? String else { return nil }
        let s = { (k: String) in obj[k] as? String ?? "" }
        switch type {
        case "hello.ok": return .helloOk
        case "session.request":
            return .request(.init(sessionId: s("sessionId"), operatorName: s("operator"), reason: s("reason"),
                                  scope: Scope(rawValue: s("scope")) ?? .control))
        case "session.token":
            return .token(.init(sessionId: s("sessionId"), livekitUrl: s("livekitUrl"), token: s("token"), room: s("room")))
        case "session.scope":
            return .scope(sessionId: s("sessionId"), Scope(rawValue: s("scope")) ?? .view)
        case "session.end":
            return .end(sessionId: s("sessionId"), reason: s("reason"))
        default: return nil
        }
    }
}

enum ClientMessage {
    static func hello(targetId: String, secret: String) -> [String: Any] {
        ["type": "hello", "targetId": targetId, "platform": "mac", "hostname": Host.current().localizedName ?? targetId,
         "secret": secret, "version": EndpointVersion]
    }
    static func consent(_ sessionId: String, allow: Bool) -> [String: Any] {
        ["type": "consent.result", "sessionId": sessionId, "decision": allow ? "allow" : "deny"]
    }
    static func state(_ sessionId: String, _ state: String, detail: String? = nil) -> [String: Any] {
        var m: [String: Any] = ["type": "session.state", "sessionId": sessionId, "state": state]
        if let detail { m["detail"] = detail }
        return m
    }
}

let EndpointVersion = "mac-0.1.0"

// MARK: - Self test against shared/test-vectors.json (via Generated.swift)

func runSelfTest() -> Bool {
    var ok = true
    for v in Generated.coordVectors {
        let (px, py) = toPixels(v.x, v.y, width: v.w, height: v.h)
        if px != v.px || py != v.py {
            print("FAIL coords (\(v.x),\(v.y)) \(v.w)x\(v.h) → (\(px),\(py)) expected (\(v.px),\(v.py))"); ok = false
        }
    }
    for v in Generated.messageVectors where (InputMessage.parse(Data(v.raw.utf8)) != nil) != v.valid {
        print("FAIL message \(v.raw) expected valid=\(v.valid)"); ok = false
    }
    for code in ["KeyA", "Enter", "ArrowLeft", "MetaLeft"] where Generated.macKeyCodes[code] == nil {
        print("FAIL keymap missing \(code)"); ok = false
    }
    print(ok ? "self-test PASS (\(Generated.coordVectors.count) coord, \(Generated.messageVectors.count) message vectors, \(Generated.macKeyCodes.count) keys)" : "self-test FAILED")
    return ok
}

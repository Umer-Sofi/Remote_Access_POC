// The shared endpoint lifecycle (spec §8.5 steps 1-9, PROTOCOL.md §4). The Windows
// client implements the same state flow in endpoint-win/src/main.rs.
//
//   idle ──session.request──▶ consenting ──Allow──▶ approved ──session.token──▶ streaming
//                                  │ Deny/timeout                                   │
//                                  ▼                                                ▼
//                                idle                     session.end / banner End / link lost
//                                                                           → teardown → exit
import AppKit
import Foundation

@MainActor
final class EndpointController {
    private enum Phase: Equatable { case idle, consenting(String), approved(String), streaming(String), tearingDown }

    private let cfg: EndpointConfig
    private let link: BrokerLink
    private let consent = ConsentPrompt()
    private let banner = SessionBanner()
    private let injector = InputInjector()
    private var capture: ScreenCapture?
    private var media: MediaStream?
    private var phase = Phase.idle
    private var operatorName = ""
    private var scope = Scope.view
    private var heartbeat: Timer?
    private var registered = false

    init(config: EndpointConfig) {
        cfg = config
        link = BrokerLink(url: config.brokerURL)
    }

    func start() {
        link.onOpen = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.link.send(ClientMessage.hello(targetId: self.cfg.targetId, secret: self.cfg.secret))
            }
        }
        link.onMessage = { [weak self] m in Task { @MainActor in self?.handle(m) } }
        link.onClose = { [weak self] why in Task { @MainActor in self?.linkLost(why) } }
        log("connecting to broker \(cfg.brokerURL) as \(cfg.targetId)")
        link.connect()
    }

    // MARK: broker messages

    private func handle(_ m: BrokerMessage) {
        switch m {
        case .helloOk:
            registered = true
            log("registered with broker; waiting for a session request (\(Providers.lifecycle.mode == .ephemeral ? "ephemeral" : "agent") mode)")

        case .request(let r):
            switch phase {
            case .idle: Task { await askConsent(r, initial: true) }
            case .streaming(let id) where id == r.sessionId && r.scope == .control:
                Task { await askConsent(r, initial: false) } // re-consent for view → control
            default:
                link.send(ClientMessage.consent(r.sessionId, allow: false)) // busy
            }

        case .token(let t):
            // Capture nothing before Allow: a token is only acted on if WE approved this session.
            guard phase == .approved(t.sessionId) else { return log("ignoring unexpected token") }
            Task { await startStreaming(t) }

        case .scope(let id, let s):
            guard phase == .streaming(id) || phase == .approved(id) else { return }
            scope = s
            injector.setScope(s)
            banner.update(operatorName: operatorName, scope: s)
            log("scope is now \(s.rawValue)")

        case .end(let id, let reason):
            switch phase {
            case .consenting(id): consent.cancel()
            case .approved(id), .streaming(id): Task { await teardown(reason: "broker: \(reason)") }
            default: break
            }
        }
    }

    // MARK: consent

    private func askConsent(_ r: SessionRequest, initial: Bool) async {
        if initial {
            // Without Screen Recording the capture would be black: tell the user and decline.
            guard Permissions.screenRecording else {
                link.send(ClientMessage.state(r.sessionId, "error", detail: "screen_recording_permission_missing"))
                link.send(ClientMessage.consent(r.sessionId, allow: false))
                Permissions.checkOnStartup()
                return
            }
            phase = .consenting(r.sessionId)
            operatorName = r.operatorName
        }
        link.send(ClientMessage.state(r.sessionId, "consent_shown"))
        let allowed = await consent.ask(operatorName: r.operatorName, reason: r.reason, scope: r.scope)
        log("consent \(allowed ? "ALLOWED" : "denied") for \(r.sessionId) (scope \(r.scope.rawValue))")

        if initial {
            guard phase == .consenting(r.sessionId) else { return } // cancelled meanwhile
            phase = allowed ? .approved(r.sessionId) : .idle
            scope = r.scope
        }
        link.send(ClientMessage.consent(r.sessionId, allow: allowed))
    }

    // MARK: streaming

    private func startStreaming(_ t: SessionToken) async {
        let sessionId = t.sessionId
        link.send(ClientMessage.state(sessionId, "connecting"))
        banner.onEnd = { [weak self] in
            Task { @MainActor in
                self?.link.send(ClientMessage.state(sessionId, "ended"))
                await self?.teardown(reason: "user ended session from banner")
            }
        }
        banner.show(operatorName: operatorName, scope: scope)

        let capture = ScreenCapture(maxFps: cfg.maxFps, maxDimension: cfg.maxDimension)
        let media = MediaStream()
        self.capture = capture
        self.media = media
        media.onInput = { [injector] data in injector.handle(data) }
        media.onDisconnected = { [weak self] why in
            Task { @MainActor in await self?.teardown(reason: "SFU: \(why)") }
        }
        capture.onStopped = { [weak self] err in
            Task { @MainActor in
                self?.link.send(ClientMessage.state(sessionId, "error", detail: "capture_stopped: \(err?.localizedDescription ?? "")"))
                await self?.teardown(reason: "capture stopped")
            }
        }

        do {
            try await media.connect(url: t.livekitUrl, token: t.token)
            try await capture.start()
            await media.prepareTrack(width: capture.pixelWidth, height: capture.pixelHeight, fps: cfg.maxFps)
            capture.onFrame = { [media] px in media.feed(px) }
            try await media.publishAfterFirstFrame(maxFps: cfg.maxFps)
        } catch {
            log("streaming failed: \(error)")
            link.send(ClientMessage.state(sessionId, "error", detail: "stream_failed: \(error.localizedDescription)"))
            await teardown(reason: "stream failed")
            return
        }

        phase = .streaming(sessionId)
        injector.setScope(scope)
        link.send(ClientMessage.state(sessionId, "streaming"))
        if !Permissions.accessibility {
            // View works; control cannot. Say so rather than failing silently (spec §8.5 note).
            link.send(ClientMessage.state(sessionId, "input_unavailable", detail: "accessibility_permission_missing"))
        }
        heartbeat = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.link.send(ClientMessage.state(sessionId, "heartbeat")) }
        }
    }

    // MARK: teardown (ephemeral cleanup, spec §8.5 step 9)

    private func teardown(reason: String) async {
        guard phase != .tearingDown else { return }
        phase = .tearingDown
        log("ending session: \(reason)")
        heartbeat?.invalidate()
        injector.shutdown()
        await capture?.stop()
        banner.hide()
        await media?.disconnect()
        link.close()
        finish()
    }

    private func linkLost(_ why: String) {
        log("broker link lost: \(why)")
        switch phase {
        case .idle where !registered:
            // Never registered (broker not reachable yet): retry quietly.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.link.connect() }
        case .tearingDown:
            break
        default:
            // Losing the control link mid-session must stop capture immediately.
            Task { await teardown(reason: "broker link lost") }
        }
    }

    private func finish() {
        switch Providers.lifecycle.mode {
        case .ephemeral:
            log("ephemeral mode: exiting")
            exit(0)
        case .agent:
            break // later phase: return to idle and re-register
        }
    }
}

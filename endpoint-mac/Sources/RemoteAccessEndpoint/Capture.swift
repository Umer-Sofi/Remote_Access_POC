// macOS screen capture via ScreenCaptureKit (spec §12). Platform-specific step.
//
// * Captures the main display at its NATIVE backing-pixel size (Retina), so
//   small text survives encoding (spec §12 "capture at the native resolution").
// * NV12 (420f) output: what the WebRTC encoder consumes without a conversion.
// * ScreenCaptureKit only delivers frames when something changes. The last frame
//   is re-sent once a second on a static screen, so a newly joined viewer (or one
//   recovering from loss) gets a keyframe promptly instead of a black picture.
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "capture.frames", qos: .userInteractive)
    private var lastFrame: CVPixelBuffer?
    private var lastFrameAt = Date.distantPast
    private var repeatTimer: DispatchSourceTimer?

    /// Called on the capture queue for every frame to encode.
    var onFrame: ((CVPixelBuffer) -> Void)?
    var onStopped: ((Error?) -> Void)?

    private(set) var pixelWidth = 0
    private(set) var pixelHeight = 0

    let maxFps: Int
    let maxDimension: Int // 0 = native

    init(maxFps: Int = 30, maxDimension: Int = 0) {
        self.maxFps = maxFps
        self.maxDimension = maxDimension
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
            throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display found"])
        }

        // Native pixel size (points × backing scale). CGDisplayMode.pixelWidth is the
        // real panel resolution in the current mode; display.width is in points.
        let mode = CGDisplayCopyDisplayMode(display.displayID)
        var w = mode?.pixelWidth ?? display.width * 2
        var h = mode?.pixelHeight ?? display.height * 2
        if maxDimension > 0, max(w, h) > maxDimension {
            let s = Double(maxDimension) / Double(max(w, h))
            w = Int(Double(w) * s) & ~1
            h = Int(Double(h) * s) & ~1
        }
        pixelWidth = w
        pixelHeight = h

        let cfg = SCStreamConfiguration()
        cfg.width = w
        cfg.height = h
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(maxFps))
        cfg.showsCursor = true
        cfg.queueDepth = 5
        cfg.capturesAudio = false

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
        log("capture started: display \(display.displayID) \(display.width)x\(display.height) pt → \(w)x\(h) px @ ≤\(maxFps) fps")

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, let f = self.lastFrame, Date().timeIntervalSince(self.lastFrameAt) >= 1 else { return }
            self.onFrame?(f)
        }
        t.resume()
        repeatTimer = t
    }

    func stop() async {
        repeatTimer?.cancel()
        repeatTimer = nil
        try? await stream?.stopCapture()
        stream = nil
        queue.sync { lastFrame = nil }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: raw) == .complete, // .idle frames carry no new pixels
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        lastFrame = pixels
        lastFrameAt = Date()
        onFrame?(pixels)
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("capture stopped: \(error.localizedDescription)")
        onStopped?(error)
    }
}

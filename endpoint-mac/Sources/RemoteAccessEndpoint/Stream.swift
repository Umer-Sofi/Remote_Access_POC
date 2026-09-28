// LiveKit publishing (spec §8.5 step 6): outbound connection to the SFU, one
// screen-share video track fed from ScreenCapture, and the input data channel.
//
// Text legibility settings (spec §8.2):
//  * source .screenShareVideo → WebRTC "screencast" mode, the native equivalent
//    of the browser's contentHint = "text" (tuned for sharp edges, not motion);
//  * degradation preference maintainResolution → under congestion the encoder
//    drops frames rather than resolution, which is what keeps 10-11 pt text readable;
//  * VP9, no simulcast (one high-quality layer; there is only one viewer);
//  * 6 Mbps max bitrate. WebRTC has no hard bitrate floor; maintainResolution is the lever.
import CoreVideo
import Foundation
import LiveKit

final class MediaStream: RoomDelegate, @unchecked Sendable {
    private let room = Room()
    private var track: LocalVideoTrack?
    private var capturer: BufferCapturer?
    private var firstFrame: CheckedContinuation<Void, Never>?
    private var gotFirstFrame = false
    private let lock = NSLock()

    /// Raw data-channel payloads on topic "input" (called on a LiveKit queue).
    var onInput: ((Data) -> Void)?
    var onDisconnected: ((String) -> Void)?

    func connect(url: String, token: String) async throws {
        room.add(delegate: self)
        try await room.connect(url: url, token: token,
                               roomOptions: RoomOptions(adaptiveStream: false, dynacast: false))
        log("connected to SFU room \(room.name ?? "?")")
    }

    /// Creates the track; frames must start flowing into `feed` before `publish`.
    func prepareTrack(width: Int, height: Int, fps: Int) async {
        let t = await LocalVideoTrack.createBufferTrack(
            name: "screen", source: .screenShareVideo,
            options: BufferCaptureOptions(dimensions: Dimensions(width: Int32(width), height: Int32(height)), fps: fps))
        track = t
        capturer = t.capturer as? BufferCapturer
    }

    /// Called on the capture queue for every frame.
    func feed(_ pixels: CVPixelBuffer) {
        capturer?.capture(pixels)
        lock.lock()
        let cont = gotFirstFrame ? nil : firstFrame
        if !gotFirstFrame, firstFrame != nil { gotFirstFrame = true; firstFrame = nil }
        lock.unlock()
        cont?.resume()
    }

    /// The SDK needs at least one captured frame to resolve dimensions before publishing.
    func publishAfterFirstFrame(maxFps: Int) async throws {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock()
            if gotFirstFrame { lock.unlock(); c.resume(); return }
            firstFrame = c
            lock.unlock()
        }
        guard let track else { return }
        let options = VideoPublishOptions(
            name: "screen",
            screenShareEncoding: VideoEncoding(maxBitrate: 6_000_000, maxFps: maxFps),
            simulcast: false,
            preferredCodec: .vp9,
            degradationPreference: .maintainResolution)
        try await room.localParticipant.publish(videoTrack: track, options: options)
        log("published screen track (VP9, screencast, maintainResolution)")
    }

    func disconnect() async {
        await room.disconnect()
    }

    // MARK: RoomDelegate

    func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String, encryptionType: EncryptionType) {
        guard topic == "input" else { return }
        onInput?(data)
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        onDisconnected?(error?.localizedDescription ?? "disconnected")
    }
}

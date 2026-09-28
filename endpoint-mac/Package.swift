// swift-tools-version:5.9
// macOS endpoint client. Build: `swift build -c release` (Command Line Tools are
// enough). Package as a signed .app with scripts/build-app.sh so TCC grants
// (Screen Recording, Accessibility) stick to a stable code identity.
import PackageDescription

let package = Package(
    name: "RemoteAccessEndpoint",
    platforms: [.macOS(.v13)], // ScreenCaptureKit with SCStreamConfiguration features we use
    dependencies: [
        .package(url: "https://github.com/livekit/client-sdk-swift.git", from: "2.17.0"),
    ],
    targets: [
        .executableTarget(
            name: "RemoteAccessEndpoint",
            dependencies: [.product(name: "LiveKit", package: "client-sdk-swift")],
            path: "Sources/RemoteAccessEndpoint"
        ),
    ]
)

// Outbound WebSocket control link to the broker (spec §8.5 step 1). The target
// never listens on a port; everything rides on this one outbound connection.
import Foundation

final class BrokerLink: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private var task: URLSessionWebSocketTask?
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private let url: URL

    var onOpen: (() -> Void)?
    var onMessage: ((BrokerMessage) -> Void)?
    var onClose: ((String) -> Void)?

    init(url: URL) { self.url = url }

    func connect() {
        let t = session.webSocketTask(with: url)
        t.maximumMessageSize = 64 * 1024
        task = t
        t.resume()
        receive(t)
    }

    func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(s)) { err in if let err { log("send failed: \(err.localizedDescription)") } }
    }

    func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, t === self.task else { return }
            switch result {
            case .success(.string(let text)):
                if let m = BrokerMessage.parse(text) { self.onMessage?(m) }
                self.receive(t)
            case .success:
                self.receive(t)
            case .failure(let err):
                self.task = nil
                self.onClose?(err.localizedDescription)
            }
        }
    }

    // URLSessionWebSocketTask answers the broker's pings automatically.
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let why = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        guard webSocketTask === task else { return }
        task = nil
        onClose?("closed \(closeCode.rawValue) \(why)")
    }
}

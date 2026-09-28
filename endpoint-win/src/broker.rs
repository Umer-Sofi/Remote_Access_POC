//! Outbound WebSocket control link to the broker (spec §8.5 step 1). The target
//! never listens on a port; everything rides on this one outbound connection.
use crate::protocol::BrokerMessage;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

pub enum LinkEvent {
    Message(BrokerMessage),
    Closed(String),
}

/// Connects and returns (sender for outgoing JSON frames, receiver of events).
pub async fn connect(url: &str) -> anyhow::Result<(UnboundedSender<String>, UnboundedReceiver<LinkEvent>)> {
    let (ws, _) = tokio_tungstenite::connect_async(url).await?;
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = unbounded_channel::<String>();
    let (ev_tx, ev_rx) = unbounded_channel::<LinkEvent>();

    // Writer. The periodic flush matters: tungstenite queues the Pong for the
    // broker's liveness Ping and only sends it on the next write/flush. Without
    // it an idle endpoint would be dropped after ~20 s.
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3));
        loop {
            tokio::select! {
                msg = out_rx.recv() => match msg {
                    Some(text) => if sink.send(Message::text(text)).await.is_err() { break },
                    None => { let _ = sink.close().await; break }
                },
                _ = tick.tick() => if sink.flush().await.is_err() { break },
            }
        }
    });

    // Reader.
    tokio::spawn(async move {
        let why = loop {
            match stream.next().await {
                Some(Ok(Message::Text(t))) => {
                    if let Some(m) = BrokerMessage::parse(&t) {
                        let _ = ev_tx.send(LinkEvent::Message(m));
                    }
                }
                Some(Ok(Message::Close(frame))) => break format!("closed {frame:?}"),
                Some(Ok(_)) => {}
                Some(Err(e)) => break e.to_string(),
                None => break "stream ended".into(),
            }
        };
        let _ = ev_tx.send(LinkEvent::Closed(why));
    });

    Ok((out_tx, ev_rx))
}

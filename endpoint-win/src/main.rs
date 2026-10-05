//! Windows endpoint client (spec §8.5). Same lifecycle and protocol as the macOS
//! client (endpoint-mac/Sources/RemoteAccessEndpoint/EndpointController.swift):
//!
//!   idle ──session.request──▶ consenting ──Allow──▶ approved ──session.token──▶ streaming
//!                                  │ Deny/timeout                                   │
//!                                  ▼                                                ▼
//!                                idle                     session.end / banner End / link lost
//!                                                                           → teardown → exit
//!
//! Configuration (first match wins): --broker/--target/--secret/--max-fps,
//! env RA_BROKER/RA_TARGET/RA_SECRET, or endpoint.json next to the exe.
mod generated;
mod protocol;
mod providers;

#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod consent;
#[cfg(windows)]
mod input;
#[cfg(windows)]
mod stream;
#[cfg(windows)]
mod broker;
#[cfg(windows)]
mod banner;

#[cfg(not(windows))]
fn main() {
    eprintln!("remote-access-endpoint is Windows-only. On macOS use endpoint-mac. (`cargo test` runs the shared contract tests anywhere.)");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(win::run())
}

/// Always-on-top session indicator (spec §8.5 step 7, acceptance criterion 4).
/// Implemented for Windows in `banner.rs`. If an indicator cannot be created the
/// client DECLINES the session rather than stream without a visible indicator.
#[allow(dead_code)]
pub trait SessionIndicator: Send {
    fn show(&mut self, operator: &str, scope: protocol::Scope);
    fn update(&mut self, operator: &str, scope: protocol::Scope);
    fn hide(&mut self);
}

#[cfg(windows)]
pub fn session_indicator(on_end: tokio::sync::mpsc::UnboundedSender<()>) -> Option<Box<dyn SessionIndicator>> {
    Some(Box::new(banner::WindowsBanner::new(on_end)))
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn session_indicator(_on_end: tokio::sync::mpsc::UnboundedSender<()>) -> Option<Box<dyn SessionIndicator>> {
    None
}

#[cfg(windows)]
mod win {
    use crate::broker::{self, LinkEvent};
    use crate::protocol::{self as p, BrokerMessage, Scope};
    use crate::providers::{LifecycleMode, LifecycleProvider, LIFECYCLE};
    use crate::stream::{Media, MediaEvent};
    use crate::{capture::Capture, consent, input::Injector, session_indicator, SessionIndicator};
    use std::time::Duration;
    use tokio::sync::mpsc::unbounded_channel;

    struct Config {
        broker: String,
        target: String,
        secret: String,
        max_fps: u32,
    }

    fn load_config() -> Option<Config> {
        let args: Vec<String> = std::env::args().collect();
        let arg = |n: &str| args.iter().position(|a| a == &format!("--{n}")).and_then(|i| args.get(i + 1).cloned());
        let env = |n: &str| std::env::var(n).ok();
        let file: serde_json::Value = std::env::current_exe()
            .ok()
            .and_then(|p| std::fs::read_to_string(p.with_file_name("endpoint.json")).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let from_file = |k: &str| file.get(k).and_then(|v| v.as_str()).map(String::from);
        let hostname = env("COMPUTERNAME").unwrap_or_else(|| "win".into());
        Some(Config {
            broker: arg("broker").or_else(|| env("RA_BROKER")).or_else(|| from_file("broker"))?,
            secret: arg("secret").or_else(|| env("RA_SECRET")).or_else(|| from_file("secret"))?,
            target: arg("target").or_else(|| env("RA_TARGET")).or_else(|| from_file("target")).unwrap_or(hostname),
            max_fps: arg("max-fps").and_then(|s| s.parse().ok()).unwrap_or(30),
        })
    }

    #[derive(PartialEq, Clone)]
    enum Phase {
        Idle,
        Consenting(String),
        Approved(String),
        Streaming(String),
    }

    enum Ev {
        Link(LinkEvent),
        Consent { session: String, allow: bool, initial: bool, scope: Scope },
        Media(MediaEvent),
        IndicatorEnd,
        Heartbeat,
    }

    pub async fn run() -> anyhow::Result<()> {
        set_dpi_aware();
        let Some(cfg) = load_config() else {
            eprintln!("usage: remote-access-endpoint --broker wss://host/ws/endpoint --secret <ENDPOINT_SECRET> [--target id]");
            std::process::exit(2);
        };
        let hostname = std::env::var("COMPUTERNAME").unwrap_or_else(|_| cfg.target.clone());

        // Connect, retrying quietly until the broker is reachable (nothing is captured meanwhile).
        eprintln!("connecting to broker {} as {}", cfg.broker, cfg.target);
        let (out, mut link_rx) = loop {
            match broker::connect(&cfg.broker).await {
                Ok(l) => break l,
                Err(e) => {
                    eprintln!("broker unreachable ({e}); retrying in 3 s");
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }
        };
        let send = |s: String| {
            let _ = out.send(s);
        };
        send(p::hello(&cfg.target, &cfg.secret, &hostname));

        let (ev_tx, mut ev_rx) = unbounded_channel::<Ev>();
        {
            let tx = ev_tx.clone();
            tokio::spawn(async move {
                while let Some(e) = link_rx.recv().await {
                    let _ = tx.send(Ev::Link(e));
                }
            });
        }

        let mut phase = Phase::Idle;
        let mut operator = String::new();
        let mut scope = Scope::View;
        let mut injector = Injector::new();
        let mut media: Option<Media> = None;
        let mut capture: Option<Capture> = None;
        let mut indicator: Option<Box<dyn SessionIndicator>> = None;

        while let Some(ev) = ev_rx.recv().await {
            match ev {
                Ev::Link(LinkEvent::Closed(why)) => {
                    // Losing the control link must stop capture immediately.
                    eprintln!("broker link lost: {why}");
                    injector.release_all();
                    if let Some(mut c) = capture.take() { c.stop(); }
                    if let Some(i) = indicator.as_mut() { i.hide(); }
                    if let Some(m) = media.take() { m.close().await; }
                    finish("broker link lost");
                }
                Ev::Link(LinkEvent::Message(m)) => match m {
                    BrokerMessage::HelloOk => eprintln!("registered with broker; waiting for a session request (ephemeral)"),

                    BrokerMessage::Request(r) => {
                        let initial = phase == Phase::Idle;
                        let reconsent = phase == Phase::Streaming(r.session_id.clone()) && r.scope == Scope::Control;
                        if !initial && !reconsent {
                            send(p::consent(&r.session_id, false)); // busy
                            continue;
                        }
                        if initial {
                            // Fail safe: never stream without the visible session indicator.
                            let (end_tx, mut end_rx) = unbounded_channel::<()>();
                            match session_indicator(end_tx) {
                                Some(ind) => {
                                    indicator = Some(ind);
                                    let tx = ev_tx.clone();
                                    tokio::spawn(async move {
                                        if end_rx.recv().await.is_some() { let _ = tx.send(Ev::IndicatorEnd); }
                                    });
                                }
                                None => {
                                    send(p::state(&r.session_id, "error", Some("session_banner_unavailable")));
                                    send(p::consent(&r.session_id, false));
                                    continue;
                                }
                            }
                            phase = Phase::Consenting(r.session_id.clone());
                            operator = r.operator.clone();
                        }
                        send(p::state(&r.session_id, "consent_shown", None));
                        let tx = ev_tx.clone();
                        tokio::task::spawn_blocking(move || {
                            let allow = consent::ask(&r.operator, &r.reason, r.scope);
                            let _ = tx.send(Ev::Consent { session: r.session_id, allow, initial, scope: r.scope });
                        });
                    }

                    BrokerMessage::Token(t) => {
                        // Capture nothing before Allow: only act on a token for a session WE approved.
                        if phase != Phase::Approved(t.session_id.clone()) {
                            eprintln!("ignoring unexpected token");
                            continue;
                        }
                        send(p::state(&t.session_id, "connecting", None));
                        if let Some(i) = indicator.as_mut() { i.show(&operator, scope); }
                        let (w, h) = crate::input::screen_size();
                        let (mtx, mut mrx) = unbounded_channel();
                        let res = async {
                            let m = Media::connect(&t.livekit_url, &t.token, w as u32, h as u32, cfg.max_fps, mtx).await?;
                            let c = Capture::start(m.source.clone(), cfg.max_fps)?;
                            anyhow::Ok((m, c))
                        }
                        .await;
                        match res {
                            Ok((m, c)) => {
                                media = Some(m);
                                capture = Some(c);
                                phase = Phase::Streaming(t.session_id.clone());
                                injector.set_scope(scope);
                                send(p::state(&t.session_id, "streaming", None));
                                let tx = ev_tx.clone();
                                tokio::spawn(async move {
                                    while let Some(e) = mrx.recv().await { let _ = tx.send(Ev::Media(e)); }
                                });
                                let tx = ev_tx.clone();
                                tokio::spawn(async move {
                                    let mut i = tokio::time::interval(Duration::from_secs(5));
                                    loop { i.tick().await; if tx.send(Ev::Heartbeat).is_err() { break } }
                                });
                            }
                            Err(e) => {
                                send(p::state(&t.session_id, "error", Some(&format!("stream_failed: {e}"))));
                                if let Some(i) = indicator.as_mut() { i.hide(); }
                                tokio::time::sleep(Duration::from_millis(300)).await; // let the frame flush
                                finish("stream failed");
                            }
                        }
                    }

                    BrokerMessage::Scope { session_id, scope: s } => {
                        if phase == Phase::Streaming(session_id.clone()) || phase == Phase::Approved(session_id) {
                            scope = s;
                            injector.set_scope(s);
                            if let Some(i) = indicator.as_mut() { i.update(&operator, s); }
                            eprintln!("scope is now {}", s.as_str());
                        }
                    }

                    BrokerMessage::End { session_id, reason } => {
                        let ours = matches!(&phase, Phase::Consenting(id) | Phase::Approved(id) | Phase::Streaming(id) if *id == session_id);
                        if !ours { continue; }
                        if matches!(phase, Phase::Consenting(_)) {
                            // Denied/timed out: nothing was captured; the consent box closes on its own timeout.
                            phase = Phase::Idle;
                            indicator = None;
                            continue;
                        }
                        injector.release_all();
                        if let Some(mut c) = capture.take() { c.stop(); }
                        if let Some(i) = indicator.as_mut() { i.hide(); }
                        if let Some(m) = media.take() { m.close().await; }
                        finish(&format!("broker: {reason}"));
                    }
                },

                Ev::Consent { session, allow, initial, scope: s } => {
                    eprintln!("consent {} for {session} (scope {})", if allow { "ALLOWED" } else { "denied" }, s.as_str());
                    if initial {
                        if phase != Phase::Consenting(session.clone()) { continue; } // cancelled meanwhile
                        phase = if allow { Phase::Approved(session.clone()) } else { Phase::Idle };
                        if !allow { indicator = None; }
                        scope = s;
                    }
                    send(p::consent(&session, allow));
                }

                Ev::Media(MediaEvent::Input(data)) => injector.handle(&data),

                ev @ (Ev::Media(MediaEvent::Disconnected(_)) | Ev::IndicatorEnd) => {
                    let why = match ev {
                        Ev::Media(MediaEvent::Disconnected(w)) => format!("SFU: {w}"),
                        _ => "user ended session from banner".to_string(),
                    };
                    if let Phase::Streaming(id) | Phase::Approved(id) = &phase {
                        send(p::state(id, "ended", None));
                    }
                    injector.release_all();
                    if let Some(mut c) = capture.take() { c.stop(); }
                    if let Some(i) = indicator.as_mut() { i.hide(); }
                    if let Some(m) = media.take() { m.close().await; }
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    finish(&why);
                }

                Ev::Heartbeat => {
                    if let Phase::Streaming(id) = &phase { send(p::state(id, "heartbeat", None)); }
                }
            }
        }
        Ok(())
    }

    /// Ephemeral cleanup (spec §8.5 step 9): the process exits after one session.
    fn finish(reason: &str) -> ! {
        eprintln!("ending session: {reason}");
        match LIFECYCLE.mode() {
            LifecycleMode::Ephemeral => {
                eprintln!("ephemeral mode: exiting");
                std::process::exit(0)
            }
            LifecycleMode::Agent => unreachable!("agent mode is later-phase"),
        }
    }

    fn set_dpi_aware() {
        use windows_sys::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        // Real pixels from GetSystemMetrics and the capturer, so coordinate maths is exact.
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    }
}

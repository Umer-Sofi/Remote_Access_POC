//! LiveKit publishing (spec §8.5 step 6): outbound connection to the SFU, one
//! screen-share video track, and the input data channel.
//!
//! Text legibility settings, identical intent to the macOS client:
//!  * NativeVideoSource::new(.., is_screencast = true): WebRTC "screencast"
//!    content type, the native equivalent of the browser's contentHint = "text";
//!  * degradation_preference MaintainResolution: under congestion the encoder
//!    drops frames, not resolution;
//!  * VP9, no simulcast, 6 Mbps max bitrate.
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::prelude::{DegradationPreference, RtcVideoSource, VideoResolution};
use livekit::webrtc::video_source::native::NativeVideoSource;
use tokio::sync::mpsc::UnboundedSender;

pub enum MediaEvent {
    Input(Vec<u8>),
    Disconnected(String),
}

pub struct Media {
    room: Room,
    pub source: NativeVideoSource,
}

impl Media {
    /// Connects, publishes the screen track and starts forwarding events.
    /// Publishing before the first captured frame is fine in Rust: the native
    /// source emits black keepalive frames until capture starts.
    pub async fn connect(
        url: &str,
        token: &str,
        width: u32,
        height: u32,
        fps: u32,
        events: UnboundedSender<MediaEvent>,
    ) -> anyhow::Result<Media> {
        let mut opts = RoomOptions::default();
        opts.adaptive_stream = false;
        opts.dynacast = false;
        let (room, mut rx) = Room::connect(url, token, opts).await?;
        eprintln!("connected to SFU room {}", room.name());

        let source = NativeVideoSource::new(VideoResolution { width, height }, true);
        let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
        room.local_participant()
            .publish_track(
                LocalTrack::Video(track),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    video_codec: VideoCodec::VP9,
                    simulcast: false,
                    video_encoding: Some(VideoEncoding { max_bitrate: 6_000_000, max_framerate: fps as f64 }),
                    degradation_preference: Some(DegradationPreference::MaintainResolution),
                    ..Default::default()
                },
            )
            .await?;
        eprintln!("published screen track (VP9, screencast, maintainResolution)");

        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                match ev {
                    RoomEvent::DataReceived { payload, topic, .. } if topic.as_deref() == Some("input") => {
                        let _ = events.send(MediaEvent::Input(payload.to_vec()));
                    }
                    RoomEvent::Disconnected { reason } => {
                        let _ = events.send(MediaEvent::Disconnected(format!("{reason:?}")));
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(Media { room, source })
    }

    pub async fn close(&self) {
        let _ = self.room.close().await;
    }
}

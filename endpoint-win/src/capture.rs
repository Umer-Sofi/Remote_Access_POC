//! Windows screen capture (spec §8.5 step 5). Platform-specific step.
//!
//! Uses libwebrtc's DesktopCapturer (re-exported by the livekit crate), which
//! on Windows enables Windows.Graphics.Capture with DXGI Desktop Duplication
//! as fallback, the exact pair spec §4 asks for, maintained upstream instead
//! of hand-written COM/D3D11 code here.
//!
//! Frames arrive as BGRA (libyuv calls that byte order "ARGB") and are
//! converted to I420 for the encoder. Capture runs on its own thread, driven at
//! the target frame rate, and stops when `stop` is set.
use livekit::webrtc::desktop_capturer::{DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::{I420Buffer, VideoBuffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    /// Starts capturing the primary screen into `source`. Only called after consent.
    pub fn start(source: NativeVideoSource, fps: u32) -> anyhow::Result<Capture> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<anyhow::Result<()>>();

        let thread = std::thread::Builder::new().name("capture".into()).spawn(move || {
            let mut opts = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
            opts.set_include_cursor(true);
            let Some(mut capturer) = DesktopCapturer::new(opts) else {
                let _ = ready_tx.send(Err(anyhow::anyhow!("could not create desktop capturer")));
                return;
            };
            // First source is the primary display. Multi-monitor is out of POC scope.
            let primary = capturer.get_source_list().into_iter().next();
            // One reusable frame; its I420 buffer is refilled in place every capture.
            let mut out: Option<VideoFrame<I420Buffer>> = None;
            capturer.start_capture(primary, move |result| {
                let Ok(frame) = result else { return }; // temporary errors: skip frame
                let (w, h) = (frame.width(), frame.height());
                if w <= 0 || h <= 0 {
                    return;
                }
                // (Re)allocate on first frame or resolution change.
                let vf = match &mut out {
                    Some(vf) if vf.buffer.width() == w as u32 && vf.buffer.height() == h as u32 => vf,
                    _ => out.insert(VideoFrame::new(VideoRotation::VideoRotation0, I420Buffer::new(w as u32, h as u32))),
                };
                let (sy, su, sv) = vf.buffer.strides();
                let (y, u, v) = vf.buffer.data_mut();
                yuv_helper::argb_to_i420(frame.data(), frame.stride(), y, sy, u, su, v, sv, w, h);
                source.capture_frame(vf);
            });
            let _ = ready_tx.send(Ok(()));

            let interval = Duration::from_millis(1000 / fps.max(1) as u64);
            while !stop_t.load(Ordering::Relaxed) {
                let t0 = Instant::now();
                capturer.capture_frame(); // callback above runs synchronously
                if let Some(rest) = interval.checked_sub(t0.elapsed()) {
                    std::thread::sleep(rest);
                }
            }
        })?;

        ready_rx.recv().map_err(|_| anyhow::anyhow!("capture thread died"))??;
        eprintln!("capture started (WGC, DXGI fallback) @ ≤{fps} fps");
        Ok(Capture { stop, thread: Some(thread) })
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

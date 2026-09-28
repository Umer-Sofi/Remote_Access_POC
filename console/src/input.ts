// DOM events on the video viewer → input wire protocol messages (shared/PROTOCOL.md §2).
//
// Coordinates are sent as fractions (0..1) of the REMOTE screen. The <video>
// element uses object-fit: contain, so the picture is letterboxed inside the
// element; we map against the actual picture rectangle, not the element box.

export type InputMsg =
  | { t: 'mm'; x: number; y: number }
  | { t: 'mb'; button: 'left' | 'right' | 'middle'; down: boolean }
  | { t: 'mw'; dx: number; dy: number }
  | { t: 'kb'; code: string; down: boolean; mods: string[] }
  | { t: 'cmd'; name: 'ctrl-alt-del' | 'release-all' }
  | { t: 'scope'; value: 'view' | 'control' }; // informational; the broker is authoritative

const MOVE_INTERVAL_MS = 1000 / 60; // spec: throttle mm to ≤ 60/s
const BUTTONS = ['left', 'middle', 'right'] as const; // PointerEvent.button 0,1,2

/** Picture rectangle of a letterboxed <video>, in client coordinates. */
export function contentRect(video: HTMLVideoElement) {
  const box = video.getBoundingClientRect();
  const vw = video.videoWidth || box.width;
  const vh = video.videoHeight || box.height;
  const scale = Math.min(box.width / vw, box.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
}

export function toFraction(video: HTMLVideoElement, clientX: number, clientY: number) {
  const r = contentRect(video);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: Number(clamp((clientX - r.left) / r.width).toFixed(5)),
    y: Number(clamp((clientY - r.top) / r.height).toFixed(5)),
  };
}

function mods(e: KeyboardEvent | WheelEvent | PointerEvent) {
  const m: string[] = [];
  if (e.ctrlKey) m.push('ctrl');
  if (e.altKey) m.push('alt');
  if (e.shiftKey) m.push('shift');
  if (e.metaKey) m.push('meta');
  return m;
}

/**
 * Wire up input capture. `surface` is the focusable wrapper that receives keyboard
 * events; `video` is the viewer used for coordinate mapping.
 * Returns a cleanup function.
 */
export function attachInput(
  surface: HTMLElement,
  video: HTMLVideoElement,
  send: (m: InputMsg) => void,
  canControl: () => boolean,
) {
  let pendingMove: { x: number; y: number } | null = null;
  let lastMoveSent = 0;
  let moveTimer: number | undefined;

  const emit = (m: InputMsg) => { if (canControl()) send(m); };

  const flushMove = () => {
    moveTimer = undefined;
    if (!pendingMove) return;
    emit({ t: 'mm', ...pendingMove });
    pendingMove = null;
    lastMoveSent = performance.now();
  };

  const onPointerMove = (e: PointerEvent) => {
    pendingMove = toFraction(video, e.clientX, e.clientY);
    const wait = MOVE_INTERVAL_MS - (performance.now() - lastMoveSent);
    if (wait <= 0) flushMove();
    else if (moveTimer === undefined) moveTimer = window.setTimeout(flushMove, wait);
  };

  const onPointerButton = (down: boolean) => (e: PointerEvent) => {
    const button = BUTTONS[e.button];
    if (!button) return;
    e.preventDefault();
    surface.focus();
    // Always send the exact position first so the click lands where it was aimed,
    // even if a throttled move is still pending.
    if (moveTimer !== undefined) { clearTimeout(moveTimer); moveTimer = undefined; }
    pendingMove = null;
    emit({ t: 'mm', ...toFraction(video, e.clientX, e.clientY) });
    emit({ t: 'mb', button, down });
    if (down) surface.setPointerCapture(e.pointerId); // keep drags alive outside the video
    else if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Normalise to pixels (deltaMode 1 = lines, 2 = pages).
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    const clamp = (v: number) => Math.max(-1200, Math.min(1200, Math.round(v * k)));
    emit({ t: 'mw', dx: clamp(e.deltaX), dy: clamp(e.deltaY) });
  };

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    // The remote OS generates its own auto-repeat while a key is held, so
    // forwarding browser repeats would double-type.
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || !e.code) return;
    emit({ t: 'kb', code: e.code, down, mods: mods(e) });
  };

  // Leaving the viewer with keys/buttons held would leave them stuck remotely.
  const onBlur = () => emit({ t: 'cmd', name: 'release-all' });
  const noMenu = (e: Event) => e.preventDefault();

  const down = onPointerButton(true);
  const up = onPointerButton(false);
  const kd = onKey(true);
  const ku = onKey(false);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerdown', down);
  surface.addEventListener('pointerup', up);
  surface.addEventListener('wheel', onWheel, { passive: false });
  surface.addEventListener('keydown', kd);
  surface.addEventListener('keyup', ku);
  surface.addEventListener('blur', onBlur);
  surface.addEventListener('contextmenu', noMenu);

  return () => {
    if (moveTimer !== undefined) clearTimeout(moveTimer);
    surface.removeEventListener('pointermove', onPointerMove);
    surface.removeEventListener('pointerdown', down);
    surface.removeEventListener('pointerup', up);
    surface.removeEventListener('wheel', onWheel);
    surface.removeEventListener('keydown', kd);
    surface.removeEventListener('keyup', ku);
    surface.removeEventListener('blur', onBlur);
    surface.removeEventListener('contextmenu', noMenu);
  };
}

/**
 * Keyboard Lock API (Chromium, fullscreen only): lets the page receive keys the
 * browser would otherwise swallow (Esc, Alt+Tab, Meta…). Unsupported browsers
 * silently fall back; Ctrl-Alt-Del is always a `cmd` button instead.
 */
export async function enterFullscreenWithKeyboardLock(el: HTMLElement) {
  await el.requestFullscreen();
  const kb = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }).keyboard;
  try {
    await kb?.lock?.();
    return !!kb?.lock;
  } catch {
    return false;
  }
}

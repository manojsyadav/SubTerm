// Binary framing shared with the RDP helper (see src-tauri/rdp-helper/src/wire.rs).

/** Event kinds received from the helper (first byte of each message). */
export const EV_CONNECTED = 1;
export const EV_UPDATE = 2;
export const EV_ERROR = 3;
export const EV_CLOSED = 4;
/** The server's certificate is new or changed; answer with `rdp_answer_certificate`. */
export const EV_CERT = 5;

export type RdpEvent =
  | { kind: "cert"; sessionId: string; fingerprint: string; mismatch: boolean }
  | { kind: "connected"; width: number; height: number }
  | { kind: "update"; x: number; y: number; width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> }
  | { kind: "error"; message: string }
  | { kind: "closed"; reason: string }
  | { kind: "unknown" };

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);

export function parseEvent(bytes: Uint8Array): RdpEvent {
  if (bytes.length === 0) return { kind: "unknown" };
  const body = bytes.subarray(1);
  switch (bytes[0]) {
    case EV_CONNECTED:
      return body.length >= 4 ? { kind: "connected", width: u16(body, 0), height: u16(body, 2) } : { kind: "unknown" };
    case EV_UPDATE: {
      if (body.length < 8) return { kind: "unknown" };
      const width = u16(body, 4);
      const height = u16(body, 6);
      const need = width * height * 4;
      if (width === 0 || height === 0 || body.length < 8 + need) return { kind: "unknown" };
      // Copy: the incoming buffer is reused/short-lived and ImageData needs a 4-byte aligned view.
      const pixels = new Uint8ClampedArray(new ArrayBuffer(need));
      pixels.set(body.subarray(8, 8 + need));
      return { kind: "update", x: u16(body, 0), y: u16(body, 2), width, height, pixels };
    }
    case EV_ERROR:
      return { kind: "error", message: new TextDecoder().decode(body) };
    case EV_CLOSED:
      return { kind: "closed", reason: new TextDecoder().decode(body) };
    case EV_CERT:
      try {
        const q = JSON.parse(new TextDecoder().decode(body));
        return typeof q.sessionId === "string" && typeof q.fingerprint === "string"
          ? { kind: "cert", sessionId: q.sessionId, fingerprint: q.fingerprint, mismatch: !!q.mismatch }
          : { kind: "unknown" };
      } catch {
        return { kind: "unknown" };
      }
    default:
      return { kind: "unknown" };
  }
}

// ---- input encoding ---------------------------------------------------------

const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

export const encodeMouseMove = (x: number, y: number): number[] => [1, ...le16(x), ...le16(y)];

/** DOM `MouseEvent.button`: 0 left, 1 middle, 2 right, 3 back, 4 forward. */
export const encodeMouseButton = (button: number, pressed: boolean): number[] => [2, button, pressed ? 1 : 0];

export const encodeWheel = (vertical: boolean, units: number): number[] => [3, vertical ? 1 : 0, ...le16(units & 0xffff)];

export const encodeKey = (scancode: number, extended: boolean, pressed: boolean): number[] => [
  4, scancode, extended ? 1 : 0, pressed ? 1 : 0,
];

/** Clamp a pointer position (already scaled to remote pixels) into the remote screen. */
export function clampPoint(x: number, y: number, width: number, height: number): [number, number] {
  const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return [cx, cy];
}

/**
 * Browser wheel delta -> RDP rotation units (120 per notch, positive = away from the
 * user / scroll up). A DOM delta is positive when scrolling down, so the sign flips.
 */
export function wheelUnits(delta: number, deltaMode: number): number {
  if (delta === 0) return 0;
  const notches = deltaMode === 1 ? delta : deltaMode === 2 ? delta * 10 : delta / 100; // lines | pages | pixels
  let units = Math.round(-notches * 120);
  if (units === 0) units = delta > 0 ? -120 : 120; // small trackpad deltas still scroll one notch
  return Math.max(-32768, Math.min(32767, units));
}

// ---- keyboard ---------------------------------------------------------------

type Key = [scancode: number, extended: boolean];

const PLAIN: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
  Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e,
  Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16,
  KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c,
  ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50,
  Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
};

const EXTENDED: Record<string, number> = {
  NumpadEnter: 0x1c, ControlRight: 0x1d, NumpadDivide: 0x35, PrintScreen: 0x37, AltRight: 0x38,
  Home: 0x47, ArrowUp: 0x48, PageUp: 0x49, ArrowLeft: 0x4b, ArrowRight: 0x4d, End: 0x4f,
  ArrowDown: 0x50, PageDown: 0x51, Insert: 0x52, Delete: 0x53, MetaLeft: 0x5b, MetaRight: 0x5c,
  ContextMenu: 0x5d,
};

/** Physical key (`KeyboardEvent.code`) -> PC scancode, or null when there is no mapping. */
export function scancodeFor(code: string): Key | null {
  if (code in PLAIN) return [PLAIN[code], false];
  if (code in EXTENDED) return [EXTENDED[code], true];
  return null;
}

/** Key-down/up sequence for Ctrl+Alt+Delete (the browser can't send it as a real shortcut). */
export function ctrlAltDelete(): number[] {
  const seq: [number, boolean, boolean][] = [
    [0x1d, false, true], [0x38, false, true], [0x53, true, true],
    [0x53, true, false], [0x38, false, false], [0x1d, false, false],
  ];
  return seq.flatMap(([sc, ext, down]) => encodeKey(sc, ext, down));
}

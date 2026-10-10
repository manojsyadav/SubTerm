//! Framing between SubTerm and this helper, over the helper's stdin/stdout.
//!
//! helper -> app (stdout): `[kind u8][len u32 LE][payload]`
//!   1 CONNECTED  width u16, height u16 (LE)
//!   2 UPDATE     x u16, y u16, w u16, h u16 (LE), then w*h*4 RGBA bytes
//!   3 ERROR      UTF-8 text
//!   4 CLOSED     UTF-8 text (may be empty)
//!
//! app -> helper (stdin): first line is a JSON `Request`, then binary events:
//!   1 MOUSE_MOVE    x u16, y u16
//!   2 MOUSE_BUTTON  button u8 (0 left, 1 middle, 2 right, 3 back, 4 forward), pressed u8
//!   3 WHEEL         vertical u8 (1 = vertical), units i16
//!   4 KEY           scancode u8, extended u8, pressed u8
//!   5 DISCONNECT

use std::io::{self, Read, Write};

pub const OUT_CONNECTED: u8 = 1;
pub const OUT_UPDATE: u8 = 2;
pub const OUT_ERROR: u8 = 3;
pub const OUT_CLOSED: u8 = 4;

pub fn write_frame(out: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    out.write_all(&[kind])?;
    out.write_all(&(payload.len() as u32).to_le_bytes())?;
    out.write_all(payload)?;
    out.flush()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    MouseMove { x: u16, y: u16 },
    MouseButton { button: u8, pressed: bool },
    Wheel { vertical: bool, units: i16 },
    Key { scancode: u8, extended: bool, pressed: bool },
    Disconnect,
}

/// Read one input event. `Ok(None)` means the stream ended cleanly.
pub fn read_input(r: &mut impl Read) -> io::Result<Option<Input>> {
    let mut kind = [0u8; 1];
    match r.read_exact(&mut kind) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut b = |n: usize| -> io::Result<Vec<u8>> {
        let mut v = vec![0u8; n];
        r.read_exact(&mut v)?;
        Ok(v)
    };
    let ev = match kind[0] {
        1 => {
            let v = b(4)?;
            Input::MouseMove { x: u16::from_le_bytes([v[0], v[1]]), y: u16::from_le_bytes([v[2], v[3]]) }
        }
        2 => {
            let v = b(2)?;
            Input::MouseButton { button: v[0], pressed: v[1] != 0 }
        }
        3 => {
            let v = b(3)?;
            Input::Wheel { vertical: v[0] != 0, units: i16::from_le_bytes([v[1], v[2]]) }
        }
        4 => {
            let v = b(3)?;
            Input::Key { scancode: v[0], extended: v[1] != 0, pressed: v[2] != 0 }
        }
        5 => Input::Disconnect,
        other => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unknown input kind {other}"))),
    };
    Ok(Some(ev))
}

/// Pixels of the rectangle `[left..=right] x [top..=bottom]` from a `stride`-wide RGBA image.
pub fn crop_rgba(data: &[u8], stride_px: usize, left: usize, top: usize, right: usize, bottom: usize) -> Vec<u8> {
    let w = right + 1 - left;
    let mut out = Vec::with_capacity(w * (bottom + 1 - top) * 4);
    for row in top..=bottom {
        let start = (row * stride_px + left) * 4;
        out.extend_from_slice(&data[start..start + w * 4]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_have_kind_length_payload() {
        let mut v = Vec::new();
        write_frame(&mut v, OUT_ERROR, b"nope").unwrap();
        assert_eq!(v, [3, 4, 0, 0, 0, b'n', b'o', b'p', b'e']);
    }

    #[test]
    fn decodes_every_input_kind() {
        let bytes: Vec<u8> = vec![
            1, 0x34, 0x12, 0x78, 0x56, // move (0x1234, 0x5678)
            2, 2, 1, // right button down
            3, 1, 0xFE, 0xFF, // vertical wheel -2
            4, 0x1D, 1, 0, // extended key 0x1D released
            5,
        ];
        let mut r = &bytes[..];
        assert_eq!(read_input(&mut r).unwrap(), Some(Input::MouseMove { x: 0x1234, y: 0x5678 }));
        assert_eq!(read_input(&mut r).unwrap(), Some(Input::MouseButton { button: 2, pressed: true }));
        assert_eq!(read_input(&mut r).unwrap(), Some(Input::Wheel { vertical: true, units: -2 }));
        assert_eq!(read_input(&mut r).unwrap(), Some(Input::Key { scancode: 0x1D, extended: true, pressed: false }));
        assert_eq!(read_input(&mut r).unwrap(), Some(Input::Disconnect));
        assert_eq!(read_input(&mut r).unwrap(), None);
    }

    #[test]
    fn rejects_unknown_and_truncated_input() {
        assert!(read_input(&mut &[9u8][..]).is_err());
        assert!(read_input(&mut &[1u8, 0, 0][..]).is_err());
    }

    #[test]
    fn crop_copies_only_the_rectangle() {
        // 3x2 image, pixel value = its index in every channel
        let data: Vec<u8> = (0..6u8).flat_map(|p| [p, p, p, p]).collect();
        let c = crop_rgba(&data, 3, 1, 0, 2, 1); // columns 1..=2, rows 0..=1
        assert_eq!(c.chunks(4).map(|p| p[0]).collect::<Vec<_>>(), vec![1, 2, 4, 5]);
    }
}

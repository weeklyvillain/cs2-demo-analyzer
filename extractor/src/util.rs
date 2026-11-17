//! Small helpers: Go-compatible JSON encoding and entity property access.

use source2_demo::prelude::*;
use source2_demo::FieldValue;
use std::collections::BTreeMap;
use std::fmt::Write;

/// JSON value that serialises exactly like Go's `encoding/json` does for
/// `map[string]interface{}`: object keys sorted, floats in Go's shortest form,
/// HTML-sensitive characters escaped. Keeping the text identical to the old Go
/// parser means `meta_json` columns stay byte-for-byte comparable.
#[derive(Clone, Debug)]
pub enum J {
    Null,
    Bool(bool),
    Int(i64),
    F(f64),
    S(String),
    A(Vec<J>),
    O(BTreeMap<String, J>),
}

impl J {
    pub fn obj() -> BTreeMap<String, J> {
        BTreeMap::new()
    }

    pub fn encode(&self) -> String {
        let mut s = String::new();
        self.write(&mut s);
        s
    }

    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Int(i) => {
                let _ = write!(out, "{}", i);
            }
            J::F(f) => out.push_str(&go_float(*f)),
            J::S(s) => write_str(out, s),
            J::A(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            J::O(o) => {
                out.push('{');
                for (i, (k, v)) in o.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Formats a float the way Go's JSON encoder does.
pub fn go_float(f: f64) -> String {
    if !f.is_finite() {
        return "null".to_string();
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    let abs = f.abs();
    if abs < 1e-6 || abs >= 1e21 {
        let s = format!("{:e}", f);
        // Rust: 1e21 / 1e-7, Go: 1e+21 / 1e-07 -> cleaned to 1e-7
        if let Some(pos) = s.find('e') {
            let (m, e) = s.split_at(pos);
            let e = &e[1..];
            if e.starts_with('-') {
                return format!("{}e{}", m, e);
            }
            return format!("{}e+{}", m, e);
        }
        return s;
    }
    format!("{}", f)
}

/// Parses the small JSON subset we emit ourselves (used to rewrite disconnect
/// metadata on reconnect, like Go's unmarshal/marshal round trip).
pub fn parse_flat_object(s: &str) -> BTreeMap<String, J> {
    let mut out = BTreeMap::new();
    let v: Result<serde_json::Value, _> = serde_json::from_str(s);
    if let Ok(serde_json::Value::Object(m)) = v {
        for (k, v) in m {
            out.insert(k, from_serde(v));
        }
    }
    out
}

fn from_serde(v: serde_json::Value) -> J {
    match v {
        serde_json::Value::Null => J::Null,
        serde_json::Value::Bool(b) => J::Bool(b),
        serde_json::Value::Number(n) => J::F(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => J::S(s),
        serde_json::Value::Array(a) => J::A(a.into_iter().map(from_serde).collect()),
        serde_json::Value::Object(o) => {
            J::O(o.into_iter().map(|(k, v)| (k, from_serde(v))).collect())
        }
    }
}

// ---------------------------------------------------------------------------
// Entity property helpers
// ---------------------------------------------------------------------------

pub const INVALID_HANDLE: u64 = (1 << 24) - 1;
pub const INDEX_MASK: u64 = (1 << 14) - 1;

pub fn fv_i64(v: &FieldValue) -> Option<i64> {
    Some(match v {
        FieldValue::Boolean(b) => *b as i64,
        FieldValue::Signed8(x) => *x as i64,
        FieldValue::Signed16(x) => *x as i64,
        FieldValue::Signed32(x) => *x as i64,
        FieldValue::Signed64(x) => *x,
        FieldValue::Unsigned8(x) => *x as i64,
        FieldValue::Unsigned16(x) => *x as i64,
        FieldValue::Unsigned32(x) => *x as i64,
        FieldValue::Unsigned64(x) => *x as i64,
        FieldValue::Float(x) => *x as i64,
        _ => return None,
    })
}

pub fn fv_u64(v: &FieldValue) -> Option<u64> {
    Some(match v {
        FieldValue::Boolean(b) => *b as u64,
        FieldValue::Signed8(x) => *x as u64,
        FieldValue::Signed16(x) => *x as u64,
        FieldValue::Signed32(x) => *x as u32 as u64,
        FieldValue::Signed64(x) => *x as u64,
        FieldValue::Unsigned8(x) => *x as u64,
        FieldValue::Unsigned16(x) => *x as u64,
        FieldValue::Unsigned32(x) => *x as u64,
        FieldValue::Unsigned64(x) => *x,
        _ => return None,
    })
}

pub fn p_i64(e: &Entity, name: &str) -> Option<i64> {
    e.get_property(name).ok().and_then(fv_i64)
}

pub fn p_u64(e: &Entity, name: &str) -> Option<u64> {
    e.get_property(name).ok().and_then(fv_u64)
}

pub fn p_f32(e: &Entity, name: &str) -> Option<f32> {
    match e.get_property(name).ok()? {
        FieldValue::Float(x) => Some(*x),
        other => fv_i64(other).map(|x| x as f32),
    }
}

pub fn p_bool(e: &Entity, name: &str) -> Option<bool> {
    match e.get_property(name).ok()? {
        FieldValue::Boolean(b) => Some(*b),
        other => fv_i64(other).map(|x| x != 0),
    }
}

pub fn p_str(e: &Entity, name: &str) -> Option<String> {
    match e.get_property(name).ok()? {
        FieldValue::String(s) => Some(s.clone()),
        _ => None,
    }
}

pub fn p_vec3(e: &Entity, name: &str) -> Option<[f32; 3]> {
    match e.get_property(name).ok()? {
        FieldValue::Vector3D(v) => Some(*v),
        FieldValue::Vector2D(v) => Some([v[0], v[1], 0.0]),
        FieldValue::Vector4D(v) => Some([v[0], v[1], v[2]]),
        _ => None,
    }
}

/// World position from the cell/offset encoding, identical to demoinfocs'
/// `Entity.Position()` (zero vector when any component is missing).
pub fn position(e: &Entity) -> [f64; 3] {
    let cx = p_u64(e, "CBodyComponent.m_cellX");
    let cy = p_u64(e, "CBodyComponent.m_cellY");
    let cz = p_u64(e, "CBodyComponent.m_cellZ");
    let ox = p_f32(e, "CBodyComponent.m_vecX");
    let oy = p_f32(e, "CBodyComponent.m_vecY");
    let oz = p_f32(e, "CBodyComponent.m_vecZ");
    match (cx, cy, cz, ox, oy, oz) {
        (Some(cx), Some(cy), Some(cz), Some(ox), Some(oy), Some(oz)) => [
            cx as f64 * 512.0 - 16384.0 + ox as f64,
            cy as f64 * 512.0 - 16384.0 + oy as f64,
            cz as f64 * 512.0 - 16384.0 + oz as f64,
        ],
        _ => [0.0; 3],
    }
}

/// Looks an entity up by the index part of a handle (no serial check, like
/// demoinfocs).
pub fn ent_by_handle<'a>(ctx: &'a Context, handle: u64) -> Option<&'a Entity> {
    if handle == INVALID_HANDLE {
        return None;
    }
    ent_by_index(ctx, (handle & INDEX_MASK) as u32)
}

pub fn ent_by_index<'a>(ctx: &'a Context, index: u32) -> Option<&'a Entity> {
    ctx.entities().get_by_index(index as usize).ok()
}

/// Eye angles `[pitch, yaw, roll]` in degrees.
///
/// Relies on the vendored `source2-demo` decoding `qangle_precise` with its
/// -180 offset (see vendor/README.md); the published crate omits it, which
/// makes a yaw of exactly -180 indistinguishable from 0.
pub fn eye_angles(pawn: &Entity) -> [f32; 3] {
    p_vec3(pawn, "m_angEyeAngles").unwrap_or([0.0; 3])
}

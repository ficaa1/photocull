//! Sony SDIO datasets: ExtDeviceInfo, typed property values, descriptor snapshots, Sony value
//! semantics, control payloads and the Live View dataset.

use super::ptp::{malformed, Cursor, ProtocolError};
use std::collections::BTreeMap;

pub mod dtype {
    pub const INT8: u16 = 0x0001;
    pub const UINT8: u16 = 0x0002;
    pub const INT16: u16 = 0x0003;
    pub const UINT16: u16 = 0x0004;
    pub const INT32: u16 = 0x0005;
    pub const UINT32: u16 = 0x0006;
    pub const INT64: u16 = 0x0007;
    pub const UINT64: u16 = 0x0008;
    pub const INT128: u16 = 0x0009;
    pub const UINT128: u16 = 0x000A;
    pub const ARRAY: u16 = 0x4000;
    pub const STRING: u16 = 0xFFFF;

    /// Byte width of a scalar type.
    pub fn width(t: u16) -> Option<usize> {
        match t {
            INT8 | UINT8 => Some(1),
            INT16 | UINT16 => Some(2),
            INT32 | UINT32 => Some(4),
            INT64 | UINT64 => Some(8),
            INT128 | UINT128 => Some(16),
            _ => None,
        }
    }

    pub fn is_signed(t: u16) -> bool {
        matches!(t, INT8 | INT16 | INT32 | INT64 | INT128)
    }
}

/// Sony property codes.
pub mod prop {
    pub const COMPRESSION: u16 = 0x5004;
    pub const WHITE_BALANCE: u16 = 0x5005;
    pub const F_NUMBER: u16 = 0x5007;
    pub const FOCUS_MODE: u16 = 0x500A;
    pub const METERING: u16 = 0x500B;
    pub const FLASH_MODE: u16 = 0x500C;
    pub const EXPOSURE_PROGRAM: u16 = 0x500E;
    pub const EXPOSURE_BIAS: u16 = 0x5010;
    pub const DRIVE_MODE: u16 = 0x5013;
    pub const FLASH_COMPENSATION: u16 = 0xD200;
    pub const SHUTTER_SPEED: u16 = 0xD20D;
    pub const BATTERY_INDICATOR: u16 = 0xD20E;
    pub const COLOR_TEMPERATURE: u16 = 0xD20F;
    pub const WB_GREEN_MAGENTA: u16 = 0xD210;
    pub const ASPECT_RATIO: u16 = 0xD211;
    pub const FOCUS_INDICATION: u16 = 0xD213;
    pub const OBJECT_IN_MEMORY: u16 = 0xD215;
    pub const AEL_STATE: u16 = 0xD217;
    pub const BATTERY_REMAINING: u16 = 0xD218;
    pub const WB_AMBER_BLUE: u16 = 0xD21C;
    pub const ISO: u16 = 0xD21E;
    pub const FEL_STATE: u16 = 0xD21F;
    pub const LIVE_VIEW_STATUS: u16 = 0xD221;
    pub const SAVE_DESTINATION: u16 = 0xD222;
    pub const FOCUS_AREA: u16 = 0xD22C;
    pub const MAGNIFIER_STATUS: u16 = 0xD22D;
    pub const MAGNIFIER_RATIO: u16 = 0xD22F;
    pub const FOCUS_COORDINATE: u16 = 0xD232;
    pub const NEAR_FAR_ENABLE: u16 = 0xD235;
    pub const FOCAL_POSITION: u16 = 0xD24C;
    pub const JPEG_QUALITY: u16 = 0xD252;
    pub const FILE_FORMAT: u16 = 0xD253;
    pub const MAGNIFIER_V3: u16 = 0xD254;
    pub const POSITION_PRIORITY: u16 = 0xD25A;
    pub const PC_SAVE_SIZE: u16 = 0xD268;
    pub const PC_SAVE_FORMAT: u16 = 0xD269;
    pub const LIVE_VIEW_QUALITY: u16 = 0xD26A;
    pub const RAW_FILE_TYPE: u16 = 0xD288;
}

/// Sony control codes (9207).
pub mod control {
    pub const S1: u16 = 0xD2C1;
    pub const S2: u16 = 0xD2C2;
    pub const AEL: u16 = 0xD2C3;
    pub const MOVIE_REC: u16 = 0xD2C8;
    pub const FEL: u16 = 0xD2C9;
    pub const MAGNIFIER: u16 = 0xD2CB;
    pub const MAGNIFIER_CANCEL: u16 = 0xD2CC;
    pub const NEAR_FAR: u16 = 0xD2D1;
    pub const AF_MF_HOLD: u16 = 0xD2D2;
    pub const FOCUS_STEP_NEAR: u16 = 0xD2D7;
    pub const FOCUS_STEP_FAR: u16 = 0xD2D8;
    pub const AF_AREA_POSITION: u16 = 0xD2DC;

    pub const BUTTON_DOWN: [u8; 2] = [0x02, 0x00];
    pub const BUTTON_UP: [u8; 2] = [0x01, 0x00];
    /// Relative exposure detents observed for the α7 III profile.
    pub const M3_NOTCH_UP: [u8; 2] = [0x01, 0x00];
    pub const M3_NOTCH_DOWN: [u8; 2] = [0xFF, 0x00];
}

pub const SDI_200: u16 = 200;
pub const SDI_300: u16 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtDeviceInfo {
    pub version: u16,
    pub properties: Vec<u16>,
    pub controls: Vec<u16>,
}

impl ExtDeviceInfo {
    pub fn parse(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let mut c = Cursor::new(bytes);
        let version = c.u16()?;
        let properties = c.u16_array()?;
        let controls = c.u16_array()?;
        if !c.is_empty() {
            return Err(ProtocolError::Malformed(format!(
                "{} unexpected bytes after the capability lists",
                c.remaining()
            )));
        }
        Ok(ExtDeviceInfo {
            version,
            properties,
            controls,
        })
    }

    pub fn has_property(&self, code: u16) -> bool {
        self.properties.contains(&code)
    }

    pub fn has_control(&self, code: u16) -> bool {
        self.controls.contains(&code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropValue {
    I8(i8),
    U8(u8),
    I16(i16),
    U16(u16),
    I32(i32),
    U32(u32),
    I64(i64),
    U64(u64),
    I128(i128),
    U128(u128),
    Array(u16, Vec<PropValue>),
    Str(String),
}

impl PropValue {
    pub fn read(c: &mut Cursor<'_>, t: u16) -> Result<PropValue, ProtocolError> {
        Ok(match t {
            dtype::INT8 => PropValue::I8(c.i8()?),
            dtype::UINT8 => PropValue::U8(c.u8()?),
            dtype::INT16 => PropValue::I16(c.i16()?),
            dtype::UINT16 => PropValue::U16(c.u16()?),
            dtype::INT32 => PropValue::I32(c.i32()?),
            dtype::UINT32 => PropValue::U32(c.u32()?),
            dtype::INT64 => PropValue::I64(c.i64()?),
            dtype::UINT64 => PropValue::U64(c.u64()?),
            dtype::INT128 => PropValue::I128(c.i128()?),
            dtype::UINT128 => PropValue::U128(c.u128()?),
            dtype::STRING => PropValue::Str(c.ptp_string()?),
            t if t & dtype::ARRAY != 0 => {
                let elem = t & !dtype::ARRAY;
                let width = dtype::width(elem).ok_or_else(|| {
                    ProtocolError::Unsupported(format!("array element type {elem:#06x}"))
                })?;
                let n = c.u32()? as usize;
                if n > c.remaining() / width {
                    return malformed("array count exceeds the dataset");
                }
                let items = (0..n)
                    .map(|_| PropValue::read(c, elem))
                    .collect::<Result<_, _>>()?;
                PropValue::Array(elem, items)
            }
            t => return Err(ProtocolError::Unsupported(format!("data type {t:#06x}"))),
        })
    }

    pub fn data_type(&self) -> u16 {
        match self {
            PropValue::I8(_) => dtype::INT8,
            PropValue::U8(_) => dtype::UINT8,
            PropValue::I16(_) => dtype::INT16,
            PropValue::U16(_) => dtype::UINT16,
            PropValue::I32(_) => dtype::INT32,
            PropValue::U32(_) => dtype::UINT32,
            PropValue::I64(_) => dtype::INT64,
            PropValue::U64(_) => dtype::UINT64,
            PropValue::I128(_) => dtype::INT128,
            PropValue::U128(_) => dtype::UINT128,
            PropValue::Array(elem, _) => dtype::ARRAY | elem,
            PropValue::Str(_) => dtype::STRING,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.write(&mut out);
        out
    }

    pub fn write(&self, out: &mut Vec<u8>) {
        match self {
            PropValue::I8(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::U8(v) => out.push(*v),
            PropValue::I16(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::U16(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::I32(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::U32(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::I64(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::U64(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::I128(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::U128(v) => out.extend_from_slice(&v.to_le_bytes()),
            PropValue::Array(_, items) => {
                out.extend_from_slice(&(items.len() as u32).to_le_bytes());
                for item in items {
                    item.write(out);
                }
            }
            PropValue::Str(s) => {
                let mut w = super::ptp::Writer::new();
                w.ptp_string(s);
                out.extend_from_slice(&w.finish());
            }
        }
    }

    /// Numeric value of a scalar (u128 above i128::MAX has none).
    pub fn as_i128(&self) -> Option<i128> {
        Some(match self {
            PropValue::I8(v) => *v as i128,
            PropValue::U8(v) => *v as i128,
            PropValue::I16(v) => *v as i128,
            PropValue::U16(v) => *v as i128,
            PropValue::I32(v) => *v as i128,
            PropValue::U32(v) => *v as i128,
            PropValue::I64(v) => *v as i128,
            PropValue::U64(v) => *v as i128,
            PropValue::I128(v) => *v,
            PropValue::U128(v) => i128::try_from(*v).ok()?,
            _ => return None,
        })
    }

    /// The unsigned wire pattern of a scalar up to 64 bits.
    pub fn bits(&self) -> Option<u64> {
        Some(match self {
            PropValue::I8(v) => *v as u8 as u64,
            PropValue::U8(v) => *v as u64,
            PropValue::I16(v) => *v as u16 as u64,
            PropValue::U16(v) => *v as u64,
            PropValue::I32(v) => *v as u32 as u64,
            PropValue::U32(v) => *v as u64,
            PropValue::I64(v) => *v as u64,
            PropValue::U64(v) => *v,
            _ => return None,
        })
    }

    /// Opaque choice ID: the wire pattern in fixed-width hex, or the string itself.
    pub fn id(&self) -> String {
        match self {
            PropValue::Str(s) => format!("s:{s}"),
            PropValue::I128(v) => format!("{:032X}", *v as u128),
            PropValue::U128(v) => format!("{v:032X}"),
            PropValue::Array(_, items) => items
                .iter()
                .map(PropValue::id)
                .collect::<Vec<_>>()
                .join(","),
            v => {
                let digits = dtype::width(v.data_type()).unwrap_or(8) * 2;
                format!("{:0digits$X}", v.bits().unwrap_or(0))
            }
        }
    }

    /// Inverse of [`PropValue::id`] for scalars and strings of type `t`.
    pub fn from_id(t: u16, id: &str) -> Option<PropValue> {
        if t == dtype::STRING {
            return id.strip_prefix("s:").map(|s| PropValue::Str(s.into()));
        }
        let width = dtype::width(t)?;
        if id.len() != width * 2 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let v = u128::from_str_radix(id, 16).ok()?;
        Some(match t {
            dtype::INT8 => PropValue::I8(v as u8 as i8),
            dtype::UINT8 => PropValue::U8(v as u8),
            dtype::INT16 => PropValue::I16(v as u16 as i16),
            dtype::UINT16 => PropValue::U16(v as u16),
            dtype::INT32 => PropValue::I32(v as u32 as i32),
            dtype::UINT32 => PropValue::U32(v as u32),
            dtype::INT64 => PropValue::I64(v as u64 as i64),
            dtype::UINT64 => PropValue::U64(v as u64),
            dtype::INT128 => PropValue::I128(v as i128),
            dtype::UINT128 => PropValue::U128(v),
            _ => return None,
        })
    }

    /// A scalar of type `t` holding `v`, if it fits.
    pub fn from_i128(t: u16, v: i128) -> Option<PropValue> {
        Some(match t {
            dtype::INT8 => PropValue::I8(i8::try_from(v).ok()?),
            dtype::UINT8 => PropValue::U8(u8::try_from(v).ok()?),
            dtype::INT16 => PropValue::I16(i16::try_from(v).ok()?),
            dtype::UINT16 => PropValue::U16(u16::try_from(v).ok()?),
            dtype::INT32 => PropValue::I32(i32::try_from(v).ok()?),
            dtype::UINT32 => PropValue::U32(u32::try_from(v).ok()?),
            dtype::INT64 => PropValue::I64(i64::try_from(v).ok()?),
            dtype::UINT64 => PropValue::U64(u64::try_from(v).ok()?),
            dtype::INT128 => PropValue::I128(v),
            dtype::UINT128 => PropValue::U128(u128::try_from(v).ok()?),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Form {
    None,
    Range {
        min: PropValue,
        max: PropValue,
        step: PropValue,
    },
    /// `writable` is the Set list; `reportable` the Get/Set list. A single-list profile has both equal.
    Enum {
        writable: Vec<PropValue>,
        reportable: Vec<PropValue>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevicePropDesc {
    pub code: u16,
    pub data_type: u16,
    pub get_set: u8,
    pub is_enabled: u8,
    pub default: PropValue,
    pub current: PropValue,
    pub form: Form,
}

impl DevicePropDesc {
    pub fn current_bits(&self) -> Option<u64> {
        self.current.bits()
    }

    pub fn current_i128(&self) -> Option<i128> {
        self.current.as_i128()
    }

    /// Whether `value` is an advertised write choice.
    pub fn accepts(&self, value: &PropValue) -> bool {
        if value.data_type() != self.data_type {
            return false;
        }
        match &self.form {
            Form::Enum { writable, .. } => writable.contains(value),
            Form::Range { min, max, step } => {
                let (Some(v), Some(lo), Some(hi), Some(st)) = (
                    value.as_i128(),
                    min.as_i128(),
                    max.as_i128(),
                    step.as_i128(),
                ) else {
                    return false;
                };
                v >= lo && v <= hi && (st == 0 || (v - lo) % st == 0)
            }
            Form::None => false,
        }
    }

    pub fn encode(&self, grammar: Grammar) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.code.to_le_bytes());
        out.extend_from_slice(&self.data_type.to_le_bytes());
        out.push(self.get_set);
        out.push(self.is_enabled);
        self.default.write(&mut out);
        self.current.write(&mut out);
        match &self.form {
            Form::None => out.push(0),
            Form::Range { min, max, step } => {
                out.push(1);
                min.write(&mut out);
                max.write(&mut out);
                step.write(&mut out);
            }
            Form::Enum {
                writable,
                reportable,
            } => {
                out.push(2);
                let list = |out: &mut Vec<u8>, values: &[PropValue]| {
                    out.extend_from_slice(&(values.len() as u16).to_le_bytes());
                    for v in values {
                        v.write(out);
                    }
                };
                match grammar {
                    Grammar::SingleList => list(&mut out, reportable),
                    Grammar::TwoList => {
                        list(&mut out, writable);
                        list(&mut out, reportable);
                    }
                }
            }
        }
        out
    }
}

/// How a FormFlag=2 enumeration is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grammar {
    /// One u16 count and its values (α7 III firmware 4.0, SDI 200).
    SingleList,
    /// Set list then Get/Set list, each with its own u16 count (Sony PTP 2/3 references).
    TwoList,
}

fn read_list(c: &mut Cursor<'_>, t: u16) -> Result<Vec<PropValue>, ProtocolError> {
    let n = c.u16()? as usize;
    let min_width = dtype::width(t).unwrap_or(1);
    if n > c.remaining() / min_width {
        return malformed("enumeration count exceeds the dataset");
    }
    (0..n).map(|_| PropValue::read(c, t)).collect()
}

pub fn parse_descriptor(
    c: &mut Cursor<'_>,
    grammar: Grammar,
) -> Result<DevicePropDesc, ProtocolError> {
    let code = c.u16()?;
    let data_type = c.u16()?;
    let get_set = c.u8()?;
    let is_enabled = c.u8()?;
    let default = PropValue::read(c, data_type)?;
    let current = PropValue::read(c, data_type)?;
    let form = match c.u8()? {
        0 => Form::None,
        1 => Form::Range {
            min: PropValue::read(c, data_type)?,
            max: PropValue::read(c, data_type)?,
            step: PropValue::read(c, data_type)?,
        },
        2 => match grammar {
            Grammar::SingleList => {
                let list = read_list(c, data_type)?;
                Form::Enum {
                    writable: list.clone(),
                    reportable: list,
                }
            }
            Grammar::TwoList => Form::Enum {
                writable: read_list(c, data_type)?,
                reportable: read_list(c, data_type)?,
            },
        },
        f => return malformed(format!("form flag {f} on {code:#06x}")),
    };
    Ok(DevicePropDesc {
        code,
        data_type,
        get_set,
        is_enabled,
        default,
        current,
        form,
    })
}

/// Smallest possible record: code, type, two flags, two u8 values and the form flag.
const MIN_RECORD: usize = 9;

/// A 9209 payload under one grammar, consuming every byte.
pub fn parse_descriptor_array(
    payload: &[u8],
    grammar: Grammar,
) -> Result<Vec<DevicePropDesc>, ProtocolError> {
    let mut c = Cursor::new(payload);
    let count = c.u64()?;
    if count > (c.remaining() / MIN_RECORD) as u64 {
        return malformed("record count cannot fit the dataset");
    }
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        out.push(parse_descriptor(&mut c, grammar)?);
    }
    if !c.is_empty() {
        return malformed(format!("{} bytes follow the last record", c.remaining()));
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub descriptors: Vec<DevicePropDesc>,
    pub grammar: Grammar,
    /// Both grammars fit with different meanings and no qualified profile chose one.
    pub ambiguous: bool,
}

/// Decodes a full 9209 payload. Both grammars are tried over the entire payload; a unique
/// coherent reading wins, a qualified profile's `preferred` grammar settles a tie.
pub fn resolve_snapshot(
    payload: &[u8],
    preferred: Option<Grammar>,
) -> Result<Snapshot, ProtocolError> {
    let single = parse_descriptor_array(payload, Grammar::SingleList);
    let two = parse_descriptor_array(payload, Grammar::TwoList);
    match (single, two) {
        (Ok(a), Ok(b)) if a == b => Ok(Snapshot {
            descriptors: a,
            grammar: preferred.unwrap_or(Grammar::SingleList),
            ambiguous: false,
        }),
        (Ok(a), Ok(b)) => {
            let (descriptors, grammar) = match preferred {
                Some(Grammar::TwoList) => (b, Grammar::TwoList),
                _ => (a, Grammar::SingleList),
            };
            Ok(Snapshot {
                descriptors,
                grammar,
                ambiguous: preferred.is_none(),
            })
        }
        (Ok(a), Err(_)) => Ok(Snapshot {
            descriptors: a,
            grammar: Grammar::SingleList,
            ambiguous: false,
        }),
        (Err(_), Ok(b)) => Ok(Snapshot {
            descriptors: b,
            grammar: Grammar::TwoList,
            ambiguous: false,
        }),
        (Err(a), Err(b)) => Err(match preferred {
            Some(Grammar::TwoList) => b,
            _ => a,
        }),
    }
}

pub fn encode_snapshot(descriptors: &[DevicePropDesc], grammar: Grammar) -> Vec<u8> {
    let mut out = (descriptors.len() as u64).to_le_bytes().to_vec();
    for d in descriptors {
        out.extend_from_slice(&d.encode(grammar));
    }
    out
}

/// Applies a delta snapshot; unmentioned properties keep their values.
pub fn apply_delta(
    map: &mut BTreeMap<u16, DevicePropDesc>,
    delta: Vec<DevicePropDesc>,
) -> Vec<u16> {
    let mut changed = Vec::new();
    for d in delta {
        if map.get(&d.code) != Some(&d) {
            changed.push(d.code);
            map.insert(d.code, d);
        }
    }
    changed
}

fn trim_decimal(v: f64, places: usize) -> String {
    let s = format!("{v:.places$}");
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

pub fn white_balance_label(v: u16) -> Option<&'static str> {
    Some(match v {
        0x0002 => "Auto",
        0x0004 => "Daylight",
        0x8011 => "Shade",
        0x8010 => "Cloudy",
        0x0006 => "Incandescent",
        0x8001 => "Fluor.: Warm White",
        0x8002 => "Fluor.: Cool White",
        0x8003 => "Fluor.: Day White",
        0x8004 => "Fluor.: Daylight",
        0x0007 => "Flash",
        0x8030 => "Underwater Auto",
        0x8012 => "C.Temp./Filter",
        0x8020 => "Custom 1",
        0x8021 => "Custom 2",
        0x8022 => "Custom 3",
        _ => return None,
    })
}

/// `f*100`; `FFFF` has no numeric display.
pub fn f_number(v: u16) -> Option<f64> {
    (v != 0xFFFF && v != 0).then(|| v as f64 / 100.0)
}

pub fn f_number_label(v: u16) -> String {
    f_number(v)
        .map(|f| format!("f/{}", trim_decimal(f, 2)))
        .unwrap_or_else(|| "—".into())
}

/// Naming form, e.g. `f2.8`.
pub fn aperture_token(v: u16) -> Option<String> {
    f_number(v).map(|f| format!("f{}", trim_decimal(f, 2)))
}

pub fn focus_mode_label(v: u16) -> Option<&'static str> {
    Some(match v {
        0x0001 => "MF",
        0x0002 => "AF-S",
        0x8004 => "AF-C",
        0x8005 => "AF-A",
        0x8006 => "DMF",
        0x8009 => "Preset Focus",
        _ => return None,
    })
}

pub fn metering_label(v: u16) -> Option<&'static str> {
    Some(match v {
        0x8001 => "Multi",
        0x8002 => "Center",
        0x8003 => "Entire Screen Avg.",
        0x8004 => "Spot: Standard",
        0x8005 => "Spot: Large",
        0x8006 => "Highlight",
        _ => return None,
    })
}

/// Legacy u16 or v3 u32 exposure program; the whole advertised word must match.
pub fn exposure_program_label(raw: u64, wide: bool) -> Option<&'static str> {
    if wide {
        Some(match raw {
            0x0000_0001 => "M",
            0x0001_0002 => "P",
            0x0002_0003 => "A",
            0x0003_0004 => "S",
            0x0004_8000 => "Auto",
            0x0000_8020 => "MR",
            0x0007_8050 => "Movie P",
            0x0007_8051 => "Movie A",
            0x0007_8052 => "Movie S",
            0x0007_8053 => "Movie M",
            0x0009_8059 => "Movie S&Q P",
            0x0009_805A => "Movie S&Q A",
            0x0009_805B => "Movie S&Q S",
            0x0009_805C => "Movie S&Q M",
            0x0000_8084 | 0x0008_8084 => "S&Q P",
            0x0000_8085 | 0x0008_8085 => "S&Q A",
            0x0000_8086 | 0x0008_8086 => "S&Q S",
            0x0000_8087 | 0x0008_8087 => "S&Q M",
            _ => return None,
        })
    } else {
        Some(match raw {
            0x0001 => "M",
            0x0002 => "P",
            0x0003 => "A",
            0x0004 => "S",
            0x8000 => "Auto",
            0x8020 => "MR",
            0x8050 => "Movie P",
            0x8051 => "Movie A",
            0x8052 => "Movie S",
            0x8053 => "Movie M",
            0x8084 => "S&Q P",
            0x8085 => "S&Q A",
            0x8086 => "S&Q S",
            0x8087 => "S&Q M",
            _ => return None,
        })
    }
}

/// Signed milli-EV, e.g. −300 → `-0.3 EV`.
pub fn ev_label(milli: i16) -> String {
    if milli == 0 {
        return "±0.0 EV".into();
    }
    let sign = if milli < 0 { "-" } else { "+" };
    format!("{sign}{:.1} EV", (milli as f64).abs() / 1000.0)
}

fn bracket_step(b: u8) -> Option<(&'static str, bool)> {
    Some(match b {
        0x37 => ("0.3", true),
        0x57 => ("0.5", true),
        0x77 => ("0.7", true),
        0x11 => ("1.0", true),
        0x21 => ("2.0", true),
        0x31 => ("3.0", true),
        0x36 => ("0.3", false),
        0x56 => ("0.5", false),
        0x76 => ("0.7", false),
        0x10 => ("1.0", false),
        0x20 => ("2.0", false),
        0x30 => ("3.0", false),
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Drive {
    Single,
    Continuous(&'static str),
    Timer(&'static str),
    Exposure {
        frames: u8,
        step: &'static str,
        continuous: bool,
        direction: Option<char>,
    },
    WhiteBalance(&'static str),
    Dro(&'static str),
    Focus,
}

fn decode_drive_word(w: u16) -> Option<Drive> {
    Some(match w {
        0x0001 => Drive::Single,
        0x8012 => Drive::Continuous("Lo"),
        0x8015 => Drive::Continuous("Mid"),
        0x0002 => Drive::Continuous("Hi"),
        0x8010 => Drive::Continuous("Hi+"),
        0x8005 => Drive::Timer("2s"),
        0x8003 => Drive::Timer("5s"),
        0x8004 => Drive::Timer("10s"),
        0x8018 => Drive::WhiteBalance("Lo"),
        0x8028 => Drive::WhiteBalance("Hi"),
        0x8019 => Drive::Dro("Lo"),
        0x8029 => Drive::Dro("Hi"),
        0x8040 => Drive::Focus,
        w if w & 0xF000 == 0x8000 => {
            let frames = ((w >> 8) & 0x0F) as u8;
            let (step, continuous) = bracket_step(w as u8)?;
            if !(2..=9).contains(&frames) {
                return None;
            }
            Drive::Exposure {
                frames,
                step,
                continuous,
                direction: None,
            }
        }
        w if w & 0xFF00 == 0xC200 => {
            let b = w as u8;
            let (step, continuous, direction) = match bracket_step(b) {
                Some((s, c)) => (s, c, '+'),
                None => {
                    let (s, c) = bracket_step(b.wrapping_sub(8))?;
                    (s, c, '-')
                }
            };
            Drive::Exposure {
                frames: 2,
                step,
                continuous,
                direction: Some(direction),
            }
        }
        _ => return None,
    })
}

/// Legacy u16 or v3 u32 drive mode; v3 high words must match the decoded category.
pub fn drive_mode_label(raw: u64, wide: bool) -> Option<String> {
    let drive = decode_drive_word(raw as u16)?;
    if wide {
        let high = (raw >> 16) as u16;
        let expected = match &drive {
            Drive::Single => 0x0000,
            Drive::Continuous(_) => 0x0001,
            Drive::Timer(_) => 0x0003,
            Drive::Exposure { continuous, .. } => {
                if *continuous {
                    0x0004
                } else {
                    0x0005
                }
            }
            Drive::WhiteBalance(_) => 0x0006,
            Drive::Dro(_) => 0x0007,
            Drive::Focus => 0x000A,
        };
        if high != expected || raw >> 32 != 0 {
            return None;
        }
    } else if raw > 0xFFFF {
        return None;
    }
    Some(match drive {
        Drive::Single => "Single Shooting".into(),
        Drive::Continuous(s) => format!("Cont. Shooting: {s}"),
        Drive::Timer(s) => format!("Self-timer: {s}"),
        Drive::Exposure {
            frames,
            step,
            continuous,
            direction,
        } => {
            let kind = if continuous { "Cont." } else { "Single" };
            match direction {
                Some(d) => format!("{kind} Bracket: {step}EV 2 Img. {d}"),
                None => format!("{kind} Bracket: {step}EV {frames} Img."),
            }
        }
        Drive::WhiteBalance(s) => format!("WB Bracket: {s}"),
        Drive::Dro(s) => format!("DRO Bracket: {s}"),
        Drive::Focus => "Focus Bracket".into(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shutter {
    Bulb,
    Unavailable,
    Fraction { numerator: u16, denominator: u16 },
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

impl Shutter {
    /// `n<<16|d`; `0` BULB and `FFFFFFFF` nothing to display. Other zero denominators are invalid.
    pub fn decode(raw: u32) -> Option<Shutter> {
        match raw {
            0 => Some(Shutter::Bulb),
            0xFFFF_FFFF => Some(Shutter::Unavailable),
            raw => {
                let (n, d) = ((raw >> 16) as u16, raw as u16);
                (n != 0 && d != 0).then_some(Shutter::Fraction {
                    numerator: n,
                    denominator: d,
                })
            }
        }
    }

    fn reduced(n: u16, d: u16) -> (u32, u32) {
        let g = gcd(n as u32, d as u32).max(1);
        (n as u32 / g, d as u32 / g)
    }

    pub fn seconds(&self) -> Option<f64> {
        match *self {
            Shutter::Fraction {
                numerator,
                denominator,
            } => Some(numerator as f64 / denominator as f64),
            _ => None,
        }
    }

    pub fn label(&self) -> String {
        match *self {
            Shutter::Bulb => "BULB".into(),
            Shutter::Unavailable => "—".into(),
            Shutter::Fraction {
                numerator,
                denominator,
            } => {
                let (n, d) = Self::reduced(numerator, denominator);
                if n == 1 && d > 1 {
                    format!("1/{d}")
                } else {
                    format!("{}\"", trim_decimal(n as f64 / d as f64, 1))
                }
            }
        }
    }

    /// Naming form: `1-125`, `2s`, `1.3s`, `bulb`.
    pub fn token(&self) -> Option<String> {
        match *self {
            Shutter::Bulb => Some("bulb".into()),
            Shutter::Unavailable => None,
            Shutter::Fraction {
                numerator,
                denominator,
            } => {
                let (n, d) = Self::reduced(numerator, denominator);
                Some(if n == 1 && d > 1 {
                    format!("1-{d}")
                } else {
                    format!("{}s", trim_decimal(n as f64 / d as f64, 1))
                })
            }
        }
    }
}

pub fn color_temperature_label(v: u16) -> String {
    match v {
        0 | 0xFFFF => "—".into(),
        k => format!("{k} K"),
    }
}

/// D210/D21C display offset `(raw − 192) / 4`. Positive is G or A, negative M or B.
pub fn wb_fine_offset(raw: u8) -> f64 {
    (raw as f64 - 192.0) / 4.0
}

pub fn wb_fine_label(raw: u8, amber_blue: bool) -> String {
    let v = wb_fine_offset(raw);
    if v == 0.0 {
        return "0".into();
    }
    let (pos, neg) = if amber_blue { ("A", "B") } else { ("G", "M") };
    format!(
        "{}{}",
        if v > 0.0 { pos } else { neg },
        trim_decimal(v.abs(), 2)
    )
}

pub fn aspect_label(v: u8) -> Option<&'static str> {
    Some(match v {
        1 => "3:2",
        2 => "16:9",
        3 => "4:3",
        4 => "1:1",
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusIndication {
    Unlocked,
    AfsFocused,
    AfsUnfocused,
    AfcTracking,
    AfcFocused,
    AfcUnfocused,
    Unpaused,
    Paused,
    Other(u8),
}

impl FocusIndication {
    pub fn from_raw(v: u8) -> Self {
        match v {
            0x01 => FocusIndication::Unlocked,
            0x02 => FocusIndication::AfsFocused,
            0x03 => FocusIndication::AfsUnfocused,
            0x05 => FocusIndication::AfcTracking,
            0x06 => FocusIndication::AfcFocused,
            0x07 => FocusIndication::AfcUnfocused,
            0x08 => FocusIndication::Unpaused,
            0x09 => FocusIndication::Paused,
            v => FocusIndication::Other(v),
        }
    }

    /// Only 02 and 06 report focus. 03/07 end a wait but are not focus.
    pub fn is_focused(self) -> bool {
        matches!(
            self,
            FocusIndication::AfsFocused | FocusIndication::AfcFocused
        )
    }

    pub fn is_unfocused(self) -> bool {
        matches!(
            self,
            FocusIndication::AfsUnfocused | FocusIndication::AfcUnfocused
        )
    }

    pub fn label(self) -> &'static str {
        match self {
            FocusIndication::Unlocked => "Not locked",
            FocusIndication::AfsFocused => "Focused (AF-S)",
            FocusIndication::AfsUnfocused => "Low contrast (AF-S)",
            FocusIndication::AfcTracking => "Tracking (AF-C)",
            FocusIndication::AfcFocused => "Focused (AF-C)",
            FocusIndication::AfcUnfocused => "Low contrast (AF-C)",
            FocusIndication::Unpaused => "Tracking resumed",
            FocusIndication::Paused => "Tracking paused",
            FocusIndication::Other(_) => "Unknown",
        }
    }

    pub fn status(self) -> &'static str {
        if self.is_focused() {
            "focused"
        } else if self.is_unfocused() {
            "notFocused"
        } else if self == FocusIndication::AfcTracking {
            "tracking"
        } else {
            "idle"
        }
    }
}

/// D215 Shooting File Info.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueSignal {
    Empty,
    /// 0001–7FFF: a file exists but is not ready.
    Pending,
    /// 8000–FFFF: MSB set, object is ready at 0xFFFFC001.
    Ready,
}

pub fn queue_signal(v: u16) -> QueueSignal {
    match v {
        0 => QueueSignal::Empty,
        0x0001..=0x7FFF => QueueSignal::Pending,
        _ => QueueSignal::Ready,
    }
}

/// D218 percent, `-1` unavailable.
pub fn battery_percent(v: i8) -> Option<u8> {
    (0..=100).contains(&v).then_some(v as u8)
}

/// D21E ISO.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Iso {
    pub raw: u32,
}

impl Iso {
    pub fn base(self) -> u32 {
        self.raw & 0x00FF_FFFF
    }
    pub fn is_auto(self) -> bool {
        self.base() == 0x00FF_FFFF
    }
    pub fn mode(self) -> u8 {
        (self.raw >> 24) as u8
    }

    pub fn label(self) -> String {
        let value = if self.is_auto() {
            "ISO AUTO".to_string()
        } else {
            format!("ISO {}", self.base())
        };
        match self.mode() {
            0x00 => value,
            0x01 => format!("{value} (Multi Frame NR)"),
            0x02 => format!("{value} (Multi Frame NR High)"),
            0x10 => format!("{value} (Ext.)"),
            m => format!("{value} ({m:#04x})"),
        }
    }

    pub fn token(self) -> Option<String> {
        (!self.is_auto()).then(|| self.base().to_string())
    }
}

pub fn live_view_status_label(v: u8) -> &'static str {
    match v {
        0 => "Off",
        1 => "On",
        2 => "Unsupported",
        _ => "Unknown",
    }
}

pub fn save_destination_label(v: u16, current_menu: bool) -> Option<&'static str> {
    Some(match (v, current_menu) {
        (0x0001, false) => "PC Only",
        (0x0011, false) => "PC+Camera",
        (0x0010, false) => "Camera Only",
        (0x0001, true) => "Destination Only",
        (0x0011, true) => "Dest.+Camera",
        (0x0010, true) => "Camera Only",
        _ => return None,
    })
}

pub fn save_destination_reaches_host(v: u16) -> bool {
    v == 0x0001 || v == 0x0011
}

pub fn focus_area_label(v: u16) -> Option<&'static str> {
    Some(match v {
        0x0001 => "Wide",
        0x0002 => "Zone",
        0x0003 => "Center",
        0x0101 => "Flexible Spot: S",
        0x0102 => "Flexible Spot: M",
        0x0103 => "Flexible Spot: L",
        0x0104 => "Expand Flexible Spot",
        0x0201 => "Tracking: Wide",
        0x0202 => "Tracking: Zone",
        0x0203 => "Tracking: Center",
        0x0204 => "Tracking: Flexible Spot S",
        0x0205 => "Tracking: Flexible Spot M",
        0x0206 => "Tracking: Flexible Spot L",
        0x0207 => "Tracking: Expand Flexible Spot",
        _ => return None,
    })
}

pub fn compression_label(v: u8) -> Option<&'static str> {
    Some(match v {
        0x01 => "JPEG Light",
        0x02 => "JPEG Standard",
        0x03 => "JPEG Fine",
        0x04 => "JPEG Extra Fine",
        0x10 => "RAW",
        0x11 => "RAW+JPEG Light",
        0x12 => "RAW+JPEG Standard",
        0x13 => "RAW+JPEG Fine",
        0x14 => "RAW+JPEG Extra Fine",
        _ => return None,
    })
}

pub fn file_format_label(v: u8) -> Option<&'static str> {
    Some(match v {
        1 => "RAW",
        2 => "RAW+JPEG",
        3 => "JPEG",
        4 => "RAW+HEIF",
        5 => "HEIF",
        _ => return None,
    })
}

pub fn jpeg_quality_label(v: u8) -> Option<&'static str> {
    Some(match v {
        1 => "Extra Fine",
        2 => "Fine",
        3 => "Standard",
        4 => "Light",
        _ => return None,
    })
}

pub fn raw_type_label(v: u8) -> Option<&'static str> {
    Some(match v {
        1 => "Compressed",
        2 => "Lossless Comp. L",
        3 => "Lossless Comp. M",
        4 => "Lossless Comp. S",
        5 => "Uncompressed",
        6 => "Lossless Compressed",
        _ => return None,
    })
}

pub fn pc_save_size_label(v: u8) -> Option<&'static str> {
    Some(match v {
        1 => "Original",
        2 => "2M",
        _ => return None,
    })
}

pub fn pc_save_format_label(v: u8) -> Option<&'static str> {
    Some(match v {
        0 => "Follows File Format",
        1 => "RAW & JPEG",
        2 => "JPEG Only",
        3 => "RAW Only",
        4 => "RAW & HEIF",
        5 => "HEIF Only",
        _ => return None,
    })
}

/// Human label for any property value; unknown values stay readable as raw hex.
pub fn value_label(code: u16, value: &PropValue, current_menu: bool) -> String {
    let bits = value.bits();
    let wide = value.data_type() == dtype::UINT32;
    let known: Option<String> = bits.and_then(|b| {
        let u8v = b as u8;
        let u16v = b as u16;
        match code {
            prop::WHITE_BALANCE => white_balance_label(u16v).map(String::from),
            prop::F_NUMBER => Some(f_number_label(u16v)),
            prop::FOCUS_MODE => focus_mode_label(u16v).map(String::from),
            prop::METERING => metering_label(u16v).map(String::from),
            prop::FLASH_MODE => Some(
                match u16v {
                    0x0000 | 0x0002 => "Off",
                    0x0001 => "Auto",
                    0x0003 => "Fill-flash",
                    0x0004 => "Red-eye auto",
                    0x0005 => "Red-eye fill",
                    0x0006 => "External sync",
                    0x8003 => "Rear sync",
                    0x8001 => "Slow sync",
                    0x8004 => "Wireless",
                    0x8032 => "Slow sync (red-eye off)",
                    v => return Some(format!("0x{v:04X}")),
                }
                .into(),
            ),
            prop::EXPOSURE_PROGRAM => exposure_program_label(b, wide).map(String::from),
            prop::EXPOSURE_BIAS | prop::FLASH_COMPENSATION => Some(ev_label(u16v as i16)),
            prop::DRIVE_MODE => drive_mode_label(b, wide),
            prop::SHUTTER_SPEED => Shutter::decode(b as u32).map(|s| s.label()),
            prop::COLOR_TEMPERATURE => Some(color_temperature_label(u16v)),
            prop::WB_GREEN_MAGENTA => Some(wb_fine_label(u8v, false)),
            prop::WB_AMBER_BLUE => Some(wb_fine_label(u8v, true)),
            prop::ASPECT_RATIO => aspect_label(u8v).map(String::from),
            prop::FOCUS_INDICATION => Some(FocusIndication::from_raw(u8v).label().into()),
            prop::BATTERY_REMAINING => Some(
                battery_percent(u8v as i8)
                    .map(|p| format!("{p}%"))
                    .unwrap_or_else(|| "Unavailable".into()),
            ),
            prop::ISO => Some(Iso { raw: b as u32 }.label()),
            prop::FEL_STATE => match u8v {
                0x01 | 0x03 => Some("Unlocked".into()),
                0x02 => Some("Locked".into()),
                _ => None,
            },
            prop::LIVE_VIEW_STATUS => Some(live_view_status_label(u8v).into()),
            prop::SAVE_DESTINATION => save_destination_label(u16v, current_menu).map(String::from),
            prop::FOCUS_AREA => focus_area_label(u16v).map(String::from),
            prop::COMPRESSION => compression_label(u8v).map(String::from),
            prop::FILE_FORMAT => file_format_label(u8v).map(String::from),
            prop::JPEG_QUALITY => jpeg_quality_label(u8v).map(String::from),
            prop::RAW_FILE_TYPE => raw_type_label(u8v).map(String::from),
            prop::PC_SAVE_SIZE => pc_save_size_label(u8v).map(String::from),
            prop::PC_SAVE_FORMAT => pc_save_format_label(u8v).map(String::from),
            prop::NEAR_FAR_ENABLE => Some(if u8v == 1 { "Enabled" } else { "Disabled" }.into()),
            prop::FOCAL_POSITION => Some(format!("{u8v}")),
            _ => None,
        }
    });
    known.unwrap_or_else(|| match value {
        PropValue::Str(s) => s.clone(),
        v => format!("0x{}", v.id()),
    })
}

/// D2D1 near/far notch as i16 within the advertised range (−7…+7 on the α7 III).
pub fn near_far_payload(notch: i16, min: i16, max: i16) -> Result<[u8; 2], ProtocolError> {
    if notch == 0 || notch < min || notch > max {
        return malformed(format!("near/far step {notch} outside {min}…{max}"));
    }
    Ok(notch.to_le_bytes())
}

/// D2DC `(x << 16) | y` on Sony's 640×480 grid.
pub fn af_area_position_payload(x: u16, y: u16) -> Result<[u8; 4], ProtocolError> {
    if x >= 640 || y >= 480 {
        return malformed("AF position outside the 640×480 grid");
    }
    Ok((((x as u32) << 16) | y as u32).to_le_bytes())
}

/// D254 focus magnifier: ratio ×10 in the upper 32 bits, then u16 x and u16 y. Zero ratio is off.
pub fn magnifier_value(ratio_x10: u32, x: u16, y: u16) -> u64 {
    ((ratio_x10 as u64) << 32) | ((x as u64) << 16) | y as u64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteRoute {
    /// 9205 with the descriptor's absolute type.
    Absolute,
    /// 9207 relative detents, read back after each step.
    RelativeNotch,
    ReadOnly,
}

const EXPOSURE_NOTCH_CODES: [u16; 4] = [
    prop::F_NUMBER,
    prop::SHUTTER_SPEED,
    prop::ISO,
    prop::EXPOSURE_BIAS,
];

const ABSOLUTE_CODES: [u16; 17] = [
    prop::FLASH_COMPENSATION,
    prop::WHITE_BALANCE,
    prop::COLOR_TEMPERATURE,
    prop::WB_GREEN_MAGENTA,
    prop::WB_AMBER_BLUE,
    prop::FOCUS_AREA,
    prop::FOCUS_MODE,
    prop::METERING,
    prop::FLASH_MODE,
    prop::DRIVE_MODE,
    prop::ASPECT_RATIO,
    prop::COMPRESSION,
    prop::FILE_FORMAT,
    prop::JPEG_QUALITY,
    prop::RAW_FILE_TYPE,
    prop::PC_SAVE_SIZE,
    prop::PC_SAVE_FORMAT,
];

/// Write dispatch per property: SDI 200 exposure readouts move by notches; v3 exposure and the
/// ordinary settings are absolute. Program mode and save destination are camera-owned.
pub fn write_route(desc: &DevicePropDesc, sdi_version: u16) -> WriteRoute {
    let has_choices = matches!(&desc.form, Form::Enum { writable, .. } if !writable.is_empty())
        || matches!(desc.form, Form::Range { .. });
    if !has_choices || desc.is_enabled != 1 {
        return WriteRoute::ReadOnly;
    }
    if EXPOSURE_NOTCH_CODES.contains(&desc.code) {
        if sdi_version < SDI_300 {
            return WriteRoute::RelativeNotch;
        }
        return if desc.get_set == 1 {
            WriteRoute::Absolute
        } else {
            WriteRoute::ReadOnly
        };
    }
    if ABSOLUTE_CODES.contains(&desc.code) && desc.get_set == 1 {
        WriteRoute::Absolute
    } else {
        WriteRoute::ReadOnly
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveLayout {
    /// 8-byte header: JPEG offset and size.
    Sdi200,
    /// 16-byte header: JPEG offset/size, then focal-frame offset/size.
    Sdi300,
}

impl LiveLayout {
    pub fn for_version(sdi_version: u16) -> Self {
        if sdi_version >= SDI_300 {
            LiveLayout::Sdi300
        } else {
            LiveLayout::Sdi200
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveFrame<'a> {
    pub jpeg: &'a [u8],
    pub width: u16,
    pub height: u16,
    pub focal: Option<&'a [u8]>,
}

fn region(payload: &[u8], offset: u32, size: u32) -> Result<&[u8], ProtocolError> {
    let (offset, size) = (offset as usize, size as usize);
    if offset > payload.len() || size > payload.len() - offset {
        return malformed("live view region outside the payload");
    }
    Ok(&payload[offset..offset + size])
}

/// Extracts the verified JPEG from a Live View dataset. `Ok(None)` is a frame that is not ready yet.
pub fn extract_live_view(
    payload: &[u8],
    layout: LiveLayout,
) -> Result<Option<LiveFrame<'_>>, ProtocolError> {
    let mut c = Cursor::new(payload);
    let offset = c.u32()?;
    let size = c.u32()?;
    let (header, focal) = match layout {
        LiveLayout::Sdi200 => (8u32, None),
        LiveLayout::Sdi300 => {
            let f_offset = c.u32()?;
            let f_size = c.u32()?;
            let focal = if f_size == 0 {
                None
            } else {
                if f_offset < 16 {
                    return malformed("focal-frame data overlaps the header");
                }
                Some(region(payload, f_offset, f_size)?)
            };
            (16u32, focal)
        }
    };
    if size == 0 {
        return Ok(None);
    }
    if offset < header {
        return malformed("JPEG overlaps the live view header");
    }
    let span = region(payload, offset, size)?;
    let (width, height, end) = jpeg_scan(span)?;
    Ok(Some(LiveFrame {
        jpeg: &span[..end],
        width,
        height,
        focal,
    }))
}

/// Walks a JPEG from its SOI by segment lengths through the outer EOI. Returns the SOF dimensions
/// and the byte length up to and including EOI. Embedded thumbnails inside APP segments are skipped.
pub fn jpeg_scan(bytes: &[u8]) -> Result<(u16, u16, usize), ProtocolError> {
    let mut pos = 2;
    jpeg_scan_at(bytes, &mut pos)
}

pub fn jpeg_scan_bounded(
    bytes: &[u8],
    budget: &mut usize,
) -> Result<(u16, u16, usize), ProtocolError> {
    let bytes = &bytes[..bytes.len().min(*budget)];
    let mut pos = 2;
    let result = jpeg_scan_at(bytes, &mut pos);
    *budget = budget.saturating_sub((pos + 2).min(bytes.len()));
    result
}

fn jpeg_scan_at(bytes: &[u8], pos: &mut usize) -> Result<(u16, u16, usize), ProtocolError> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return malformed("JPEG does not begin with SOI");
    }
    let mut dims: Option<(u16, u16)> = None;
    let mut scanned = false;
    loop {
        if *pos >= bytes.len() || bytes[*pos] != 0xFF {
            return malformed("JPEG marker expected");
        }
        while *pos < bytes.len() && bytes[*pos] == 0xFF {
            *pos += 1;
        }
        let Some(&marker) = bytes.get(*pos) else {
            return malformed("JPEG ends inside a marker");
        };
        *pos += 1;
        match marker {
            0xD9 => {
                let (w, h) = dims
                    .ok_or_else(|| ProtocolError::Malformed("JPEG has no frame header".into()))?;
                if !scanned {
                    return malformed("JPEG has no image scan");
                }
                return Ok((w, h, *pos));
            }
            0xD0..=0xD7 | 0x01 => continue,
            0x00 | 0xD8 => return malformed("unexpected JPEG marker"),
            _ => {}
        }
        if *pos + 2 > bytes.len() {
            return malformed("JPEG segment length truncated");
        }
        let len = u16::from_be_bytes([bytes[*pos], bytes[*pos + 1]]) as usize;
        if len < 2 || *pos + len > bytes.len() {
            return malformed("JPEG segment exceeds the frame");
        }
        let segment = &bytes[*pos + 2..*pos + len];
        if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            if segment.len() < 5 {
                return malformed("JPEG frame header truncated");
            }
            let h = u16::from_be_bytes([segment[1], segment[2]]);
            let w = u16::from_be_bytes([segment[3], segment[4]]);
            if w == 0 || h == 0 {
                return malformed("JPEG frame has no size");
            }
            dims = Some((w, h));
        }
        *pos += len;
        if marker == 0xDA {
            if dims.is_none() {
                return malformed("JPEG scan before its frame header");
            }
            scanned = true;
            // Entropy-coded data: FF00 is a stuffed byte and FFD0–FFD7 restart markers.
            loop {
                if *pos + 1 >= bytes.len() {
                    return malformed("JPEG scan runs past the frame");
                }
                if bytes[*pos] == 0xFF {
                    let next = bytes[*pos + 1];
                    if next == 0x00 || (0xD0..=0xD7).contains(&next) || next == 0xFF {
                        *pos += if next == 0xFF { 1 } else { 2 };
                        continue;
                    }
                    break;
                }
                *pos += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::*;
    use super::*;

    #[test]
    fn ext_device_info_negotiates_versions() {
        // α7 III: c8 00 2c 00 00 00 then 44 property and 17 control codes, 132 bytes total.
        let m3 = m3_ext_device_info();
        assert_eq!(&m3[..6], &[0xc8, 0x00, 0x2c, 0x00, 0x00, 0x00]);
        assert_eq!(m3.len(), 132);
        let parsed = ExtDeviceInfo::parse(&m3).unwrap();
        assert_eq!(parsed.version, 200);
        assert_eq!((parsed.properties.len(), parsed.controls.len()), (44, 17));
        assert!(parsed.has_control(control::NEAR_FAR));
        // α7C II PTP/IP capability dataset shape: 2+4+421*2+4+59*2 bytes.
        let cm2 = cm2_ext_device_info();
        assert_eq!(&cm2[..6], &[0x2c, 0x01, 0xa5, 0x01, 0x00, 0x00]);
        assert_eq!(cm2.len(), 2 + 4 + 421 * 2 + 4 + 59 * 2);
        let parsed = ExtDeviceInfo::parse(&cm2).unwrap();
        assert_eq!(parsed.version, 300);
        assert_eq!((parsed.properties.len(), parsed.controls.len()), (421, 59));
        assert!(ExtDeviceInfo::parse(&cm2[..cm2.len() - 1]).is_err());
    }

    #[test]
    fn values_cover_every_ptp_type() {
        let mut bytes = Vec::new();
        let values = [
            PropValue::I8(-7),
            PropValue::U8(0xC0),
            PropValue::I16(-300),
            PropValue::U16(0x0118),
            PropValue::I32(-2),
            PropValue::U32(0x0001_00FA),
            PropValue::I64(-5),
            PropValue::U64(u64::MAX),
            PropValue::I128(-9),
            PropValue::U128(u128::MAX),
            PropValue::Array(dtype::UINT16, vec![PropValue::U16(1), PropValue::U16(2)]),
            PropValue::Str("ILCE-7M3".into()),
        ];
        for v in &values {
            v.write(&mut bytes);
        }
        assert_eq!(&bytes[2..4], &[0xd4, 0xfe]);
        let mut c = Cursor::new(&bytes);
        for v in &values {
            assert_eq!(&PropValue::read(&mut c, v.data_type()).unwrap(), v);
        }
        assert!(c.is_empty());
        // Array counts are bounded by the remaining bytes.
        assert!(PropValue::read(&mut Cursor::new(&[9, 0, 0, 0, 1, 0]), 0x4004).is_err());
        assert!(PropValue::read(&mut Cursor::new(&[0; 4]), 0x0042).is_err());
        // Choice IDs round-trip with fixed width and sign.
        let notch = PropValue::I16(-7);
        assert_eq!(notch.id(), "FFF9");
        assert_eq!(PropValue::from_id(dtype::INT16, "FFF9"), Some(notch));
        assert_eq!(PropValue::from_id(dtype::UINT16, "118"), None);
        assert_eq!(PropValue::from_id(dtype::UINT16, "zz18"), None);
        assert_eq!(
            PropValue::from_id(dtype::STRING, "s:x"),
            Some(PropValue::Str("x".into()))
        );
    }

    #[test]
    fn m3_single_list_snapshot_matches_trace_offsets() {
        let payload = m3_snapshot_payload();
        assert_eq!(&payload[..8], &[0x3c, 0, 0, 0, 0, 0, 0, 0]);
        let snap = resolve_snapshot(&payload, Some(Grammar::SingleList)).unwrap();
        assert!(!snap.ambiguous);
        assert_eq!(snap.grammar, Grammar::SingleList);
        assert_eq!(snap.descriptors.len(), 60);
        // 5004 at 0x08 and 5005 at 0x1A, D2D1 last at 0x0690, records end at 0x06A1.
        assert_eq!(u16::from_le_bytes([payload[0x08], payload[0x09]]), 0x5004);
        assert_eq!(u16::from_le_bytes([payload[0x1A], payload[0x1B]]), 0x5005);
        assert_eq!(u16::from_le_bytes([payload[0x690], payload[0x691]]), 0xD2D1);
        assert_eq!(payload.len(), 0x6A1);
        assert_eq!(payload.len() + 12, 1709);
        let by = |code| snap.descriptors.iter().find(|d| d.code == code).unwrap();
        let d215 = by(prop::OBJECT_IN_MEMORY);
        assert_eq!(d215.current, PropValue::U16(0x8001));
        assert_eq!(queue_signal(0x8001), QueueSignal::Ready);
        let d2d1 = by(control::NEAR_FAR);
        assert_eq!(d2d1.get_set, 0x82);
        assert_eq!(
            d2d1.form,
            Form::Range {
                min: PropValue::I16(-7),
                max: PropValue::I16(7),
                step: PropValue::I16(1)
            }
        );
        let comp = by(prop::COMPRESSION);
        let Form::Enum {
            writable,
            reportable,
        } = &comp.form
        else {
            panic!("5004 is an enumeration")
        };
        assert_eq!(writable, reportable);
        assert_eq!(writable.len(), 7);
        assert_eq!(by(prop::F_NUMBER).current, PropValue::U16(0x0320));
        assert_eq!(by(prop::BATTERY_REMAINING).current, PropValue::I8(0x33));
        let save = by(prop::SAVE_DESTINATION);
        assert!(matches!(&save.form, Form::Enum { reportable, .. }
            if reportable == &vec![PropValue::U16(1), PropValue::U16(0x11)]));
    }

    #[test]
    fn two_list_enumerations_include_zero_set_counts() {
        // The specification's synthetic v3 record: writable [MF], reportable [MF, AF-S].
        let record = [
            0x0a, 0x50, 0x04, 0x00, 0x01, 0x01, 0x01, 0x00, 0x01, 0x00, 0x02, 0x01, 0x00, 0x01,
            0x00, 0x02, 0x00, 0x01, 0x00, 0x02, 0x00,
        ];
        let d = parse_descriptor(&mut Cursor::new(&record), Grammar::TwoList).unwrap();
        assert_eq!(
            d.form,
            Form::Enum {
                writable: vec![PropValue::U16(1)],
                reportable: vec![PropValue::U16(1), PropValue::U16(2)]
            }
        );
        let payload = cm2_snapshot_payload();
        let snap = resolve_snapshot(&payload, Some(Grammar::TwoList)).unwrap();
        assert_eq!(snap.grammar, Grammar::TwoList);
        let by = |code| snap.descriptors.iter().find(|d| d.code == code).unwrap();
        // Lens without AF: zero Set entries, still followed by the next record.
        let focus = by(prop::FOCUS_MODE);
        assert!(matches!(&focus.form, Form::Enum { writable, reportable }
            if writable.is_empty() && reportable.len() == 5));
        assert_eq!(by(prop::METERING).current, PropValue::U16(0x8001));
        assert_eq!(by(prop::EXPOSURE_PROGRAM).data_type, dtype::UINT32);
        assert_eq!(
            exposure_program_label(by(prop::EXPOSURE_PROGRAM).current_bits().unwrap(), true),
            Some("A")
        );
        assert_eq!(
            drive_mode_label(by(prop::DRIVE_MODE).current_bits().unwrap(), true).as_deref(),
            Some("Cont. Bracket: 0.3EV 3 Img.")
        );
        assert_eq!(by(prop::FILE_FORMAT).current, PropValue::U8(2));
        assert_eq!(by(prop::JPEG_QUALITY).current, PropValue::U8(1));
        assert_eq!(by(prop::RAW_FILE_TYPE).current, PropValue::U8(2));
        assert_eq!(by(prop::SAVE_DESTINATION).current, PropValue::U16(0x0011));
        // The same bytes under a single-list reading do not consume the payload exactly.
        assert!(parse_descriptor_array(&payload, Grammar::SingleList).is_err());
    }

    #[test]
    fn ranges_none_forms_and_strings_parse() {
        let descs = vec![
            DevicePropDesc {
                code: prop::WB_GREEN_MAGENTA,
                data_type: dtype::UINT8,
                get_set: 1,
                is_enabled: 1,
                default: PropValue::U8(0x80),
                current: PropValue::U8(0xC0),
                form: Form::Range {
                    min: PropValue::U8(0xA4),
                    max: PropValue::U8(0xDC),
                    step: PropValue::U8(1),
                },
            },
            DevicePropDesc {
                code: 0xD2FE,
                data_type: dtype::STRING,
                get_set: 0,
                is_enabled: 2,
                default: PropValue::Str(String::new()),
                current: PropValue::Str("4.00".into()),
                form: Form::None,
            },
            DevicePropDesc {
                code: 0xE042,
                data_type: 0x4004,
                get_set: 0,
                is_enabled: 1,
                default: PropValue::Array(dtype::UINT16, vec![]),
                current: PropValue::Array(dtype::UINT16, vec![PropValue::U16(3)]),
                form: Form::None,
            },
        ];
        for grammar in [Grammar::SingleList, Grammar::TwoList] {
            let payload = encode_snapshot(&descs, grammar);
            let snap = resolve_snapshot(&payload, None).unwrap();
            // Without enumerations both readings agree.
            assert!(!snap.ambiguous);
            assert_eq!(snap.descriptors, descs);
        }
        assert!(descs[0].accepts(&PropValue::U8(0xA5)));
        assert!(!descs[0].accepts(&PropValue::U8(0xDD)));
        assert!(!descs[0].accepts(&PropValue::U16(0xA5)));
    }

    #[test]
    fn malformed_snapshots_are_rejected_whole() {
        let good = m3_snapshot_payload();
        // Truncated by one byte.
        assert!(resolve_snapshot(&good[..good.len() - 1], None).is_err());
        // Trailing garbage.
        let mut long = good.clone();
        long.push(0);
        assert!(resolve_snapshot(&long, Some(Grammar::SingleList)).is_err());
        // A count that cannot fit.
        let mut huge = good.clone();
        huge[..8].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(resolve_snapshot(&huge, None).is_err());
        // Unknown data type on the first record.
        let mut bad_type = good.clone();
        bad_type[0x0A] = 0x77;
        assert!(resolve_snapshot(&bad_type, None).is_err());
        // Unknown form flag.
        let mut bad_form = (1u64).to_le_bytes().to_vec();
        bad_form.extend_from_slice(&[0x07, 0x50, 0x04, 0x00, 0, 1, 0, 0, 0, 0, 3]);
        assert!(resolve_snapshot(&bad_form, None).is_err());
        assert!(resolve_snapshot(&[1, 2, 3], None).is_err());
    }

    #[test]
    fn grammar_is_chosen_by_exact_consumption() {
        // Set [01] + empty Get/Set list fits two lists; one list leaves two bytes over.
        let mut payload = 1u64.to_le_bytes().to_vec();
        payload.extend_from_slice(&[0x11, 0xD2, 0x02, 0x00, 1, 1, 0, 1, 2]);
        payload.extend_from_slice(&[0x01, 0x00, 0x01, 0x00, 0x00]);
        assert!(parse_descriptor_array(&payload, Grammar::SingleList).is_err());
        let snap = resolve_snapshot(&payload, Some(Grammar::SingleList)).unwrap();
        assert_eq!((snap.grammar, snap.ambiguous), (Grammar::TwoList, false));

        // Both readings consume every byte with different meanings.
        let ambiguous = ambiguous_snapshot_payload();
        let single = parse_descriptor_array(&ambiguous, Grammar::SingleList).unwrap();
        let two = parse_descriptor_array(&ambiguous, Grammar::TwoList).unwrap();
        assert_ne!(single, two);
        let snap = resolve_snapshot(&ambiguous, None).unwrap();
        assert!(snap.ambiguous);
        let snap = resolve_snapshot(&ambiguous, Some(Grammar::TwoList)).unwrap();
        assert!(!snap.ambiguous);
        assert_eq!(snap.grammar, Grammar::TwoList);
    }

    #[test]
    fn deltas_keep_unmentioned_values() {
        let snap = resolve_snapshot(&m3_snapshot_payload(), Some(Grammar::SingleList)).unwrap();
        let mut map: BTreeMap<u16, DevicePropDesc> =
            snap.descriptors.into_iter().map(|d| (d.code, d)).collect();
        let before = map.len();
        let mut iso = map[&prop::ISO].clone();
        iso.current = PropValue::U32(800);
        let unchanged = map[&prop::F_NUMBER].clone();
        let changed = apply_delta(&mut map, vec![iso.clone(), unchanged]);
        assert_eq!(changed, vec![prop::ISO]);
        assert_eq!(map.len(), before);
        assert_eq!(map[&prop::ISO].current, PropValue::U32(800));
    }

    #[test]
    fn sony_values_decode_and_format() {
        assert_eq!(white_balance_label(0x8012), Some("C.Temp./Filter"));
        for wb in [
            0x0002, 0x0004, 0x8011, 0x8010, 0x0006, 0x8001, 0x8002, 0x8003, 0x8004, 0x0007, 0x8030,
            0x8012, 0x8020, 0x8021, 0x8022,
        ] {
            assert!(white_balance_label(wb).is_some(), "{wb:#06x}");
        }
        assert_eq!(f_number_label(280), "f/2.8");
        assert_eq!(f_number_label(0x0320), "f/8");
        assert_eq!(f_number_label(0xFFFF), "—");
        assert_eq!(aperture_token(1100).as_deref(), Some("f11"));
        assert_eq!(aperture_token(710).as_deref(), Some("f7.1"));
        assert_eq!(focus_mode_label(0x8006), Some("DMF"));
        assert_eq!(metering_label(0x8006), Some("Highlight"));
        assert_eq!(exposure_program_label(0x8000, false), Some("Auto"));
        assert_eq!(exposure_program_label(0x0004_8000, true), Some("Auto"));
        assert_eq!(exposure_program_label(0x0001_0002, true), Some("P"));
        assert_eq!(exposure_program_label(0x0002, true), None);
        assert_eq!(exposure_program_label(0x0008_8087, true), Some("S&Q M"));
        assert_eq!(ev_label(i16::from_le_bytes([0xd4, 0xfe])), "-0.3 EV");
        assert_eq!(ev_label(i16::from_le_bytes([0xe8, 0x03])), "+1.0 EV");
        assert_eq!(ev_label(0), "±0.0 EV");
        assert_eq!(
            drive_mode_label(0x8337, false).as_deref(),
            Some("Cont. Bracket: 0.3EV 3 Img.")
        );
        assert_eq!(
            drive_mode_label(0x8510, false).as_deref(),
            Some("Single Bracket: 1.0EV 5 Img.")
        );
        assert_eq!(
            drive_mode_label(0x0004_8337, true).as_deref(),
            Some("Cont. Bracket: 0.3EV 3 Img.")
        );
        assert_eq!(
            drive_mode_label(0x0005_8536, true).as_deref(),
            Some("Single Bracket: 0.3EV 5 Img.")
        );
        assert_eq!(
            drive_mode_label(0x0004_C237, true).as_deref(),
            Some("Cont. Bracket: 0.3EV 2 Img. +")
        );
        assert_eq!(
            drive_mode_label(0x0004_C23F, true).as_deref(),
            Some("Cont. Bracket: 0.3EV 2 Img. -")
        );
        assert_eq!(
            drive_mode_label(0x8010, false).as_deref(),
            Some("Cont. Shooting: Hi+")
        );
        assert_eq!(
            drive_mode_label(0x0001_8010, true).as_deref(),
            Some("Cont. Shooting: Hi+")
        );
        assert_eq!(
            drive_mode_label(0x0003_8004, true).as_deref(),
            Some("Self-timer: 10s")
        );
        assert_eq!(
            drive_mode_label(0x0006_8028, true).as_deref(),
            Some("WB Bracket: Hi")
        );
        assert_eq!(
            drive_mode_label(0x0007_8019, true).as_deref(),
            Some("DRO Bracket: Lo")
        );
        assert_eq!(
            drive_mode_label(0x000A_8040, true).as_deref(),
            Some("Focus Bracket")
        );
        // A v3 word whose category disagrees with its high word.
        assert_eq!(drive_mode_label(0x0001_0001, true), None);

        assert_eq!(Shutter::decode(0x0001_00FA).unwrap().label(), "1/250");
        assert_eq!(Shutter::decode(0x001E_000A).unwrap().label(), "3\"");
        assert_eq!(
            Shutter::decode(0x001E_000A).unwrap().token().as_deref(),
            Some("3s")
        );
        assert_eq!(
            Shutter::decode(0x000D_000A).unwrap().token().as_deref(),
            Some("1.3s")
        );
        assert_eq!(
            Shutter::decode(0x0002_00FA).unwrap().token().as_deref(),
            Some("1-125")
        );
        assert_eq!(Shutter::decode(0), Some(Shutter::Bulb));
        assert_eq!(Shutter::decode(0xFFFF_FFFF), Some(Shutter::Unavailable));
        assert_eq!(Shutter::decode(0x0001_0000), None);
        assert_eq!(Shutter::decode(0x0000_00FA), None);

        assert_eq!(color_temperature_label(0x09C4), "2500 K");
        assert_eq!(color_temperature_label(0x26AC), "9900 K");
        assert_eq!(wb_fine_label(0xC0, false), "0");
        assert_eq!(wb_fine_label(0xE4, false), "G9");
        assert_eq!(wb_fine_label(0x9C, true), "B9");
        assert_eq!(wb_fine_label(0xC1, true), "A0.25");
        assert_eq!(aspect_label(4), Some("1:1"));

        assert!(FocusIndication::from_raw(2).is_focused());
        assert!(FocusIndication::from_raw(6).is_focused());
        assert!(!FocusIndication::from_raw(3).is_focused());
        assert!(!FocusIndication::from_raw(7).is_focused());
        assert!(FocusIndication::from_raw(3).is_unfocused());
        assert!(!FocusIndication::from_raw(5).is_focused());

        assert_eq!(queue_signal(0), QueueSignal::Empty);
        assert_eq!(queue_signal(1), QueueSignal::Pending);
        assert_eq!(queue_signal(0x7FFF), QueueSignal::Pending);
        assert_eq!(queue_signal(0x8000), QueueSignal::Ready);
        assert_eq!(queue_signal(0xFFFF), QueueSignal::Ready);

        assert_eq!(battery_percent(0x33), Some(51));
        assert_eq!(battery_percent(-1), None);

        assert_eq!(Iso { raw: 0x00FF_FFFF }.label(), "ISO AUTO");
        assert_eq!(Iso { raw: 0x0100_0320 }.label(), "ISO 800 (Multi Frame NR)");
        assert_eq!(
            Iso { raw: 0x0200_0320 }.label(),
            "ISO 800 (Multi Frame NR High)"
        );
        assert_eq!(Iso { raw: 0x1000_0032 }.label(), "ISO 50 (Ext.)");
        assert_eq!(Iso { raw: 0x0500_0064 }.label(), "ISO 100 (0x05)");
        assert_eq!(Iso { raw: 0x0100_0320 }.token().as_deref(), Some("800"));
        assert_eq!(Iso { raw: 0x00FF_FFFF }.token(), None);

        assert_eq!(save_destination_label(0x0011, false), Some("PC+Camera"));
        assert_eq!(save_destination_label(0x0011, true), Some("Dest.+Camera"));
        assert!(save_destination_reaches_host(0x0001));
        assert!(!save_destination_reaches_host(0x0010));
        assert_eq!(focus_area_label(0x0104), Some("Expand Flexible Spot"));
        assert_eq!(compression_label(0x14), Some("RAW+JPEG Extra Fine"));
        assert_eq!(file_format_label(4), Some("RAW+HEIF"));
        assert_eq!(jpeg_quality_label(4), Some("Light"));
        assert_eq!(raw_type_label(2), Some("Lossless Comp. L"));
        assert_eq!(pc_save_format_label(3), Some("RAW Only"));
        assert_eq!(
            value_label(0xD2FE, &PropValue::U16(0x1234), false),
            "0x1234"
        );
    }

    #[test]
    fn control_payloads_are_bounded() {
        assert_eq!(control::BUTTON_DOWN, [0x02, 0x00]);
        assert_eq!(control::BUTTON_UP, [0x01, 0x00]);
        assert_eq!(near_far_payload(-1, -7, 7).unwrap(), [0xFF, 0xFF]);
        assert_eq!(near_far_payload(-2, -7, 7).unwrap(), [0xFE, 0xFF]);
        assert_eq!(near_far_payload(-3, -7, 7).unwrap(), [0xFD, 0xFF]);
        assert_eq!(near_far_payload(3, -7, 7).unwrap(), [0x03, 0x00]);
        assert!(near_far_payload(8, -7, 7).is_err());
        assert!(near_far_payload(0, -7, 7).is_err());
        assert_eq!(
            af_area_position_payload(320, 240).unwrap(),
            ((320u32 << 16) | 240).to_le_bytes()
        );
        assert!(af_area_position_payload(640, 0).is_err());
        assert_eq!(
            magnifier_value(20, 100, 50),
            (20u64 << 32) | (100 << 16) | 50
        );
    }

    #[test]
    fn sony_flash_values_keep_unknown_choices_and_signed_compensation() {
        for (mode, label) in [
            (0, "Off"),
            (1, "Auto"),
            (2, "Off"),
            (3, "Fill-flash"),
            (4, "Red-eye auto"),
            (5, "Red-eye fill"),
            (6, "External sync"),
            (0x8003, "Rear sync"),
            (0x8001, "Slow sync"),
            (0x8004, "Wireless"),
            (0x8032, "Slow sync (red-eye off)"),
            (0x8033, "0x8033"),
            (0x8ABC, "0x8ABC"),
        ] {
            assert_eq!(
                value_label(prop::FLASH_MODE, &PropValue::U16(mode), false),
                label
            );
        }
        for (state, label) in [
            (1, "Unlocked"),
            (2, "Locked"),
            (3, "Unlocked"),
            (0xAB, "0xAB"),
        ] {
            assert_eq!(
                value_label(prop::FEL_STATE, &PropValue::U8(state), false),
                label
            );
        }
        assert_eq!(
            value_label(prop::FLASH_COMPENSATION, &PropValue::I16(-700), false),
            "-0.7 EV"
        );
    }

    #[test]
    fn write_routes_follow_the_profile() {
        let snap = resolve_snapshot(&m3_snapshot_payload(), Some(Grammar::SingleList)).unwrap();
        let by = |code| snap.descriptors.iter().find(|d| d.code == code).unwrap();
        assert_eq!(
            write_route(by(prop::ISO), SDI_200),
            WriteRoute::RelativeNotch
        );
        assert_eq!(
            write_route(by(prop::F_NUMBER), SDI_200),
            WriteRoute::RelativeNotch
        );
        assert_eq!(
            write_route(by(prop::WHITE_BALANCE), SDI_200),
            WriteRoute::Absolute
        );
        assert_eq!(
            write_route(by(prop::FLASH_MODE), SDI_200),
            WriteRoute::Absolute
        );
        assert_eq!(
            write_route(by(prop::FLASH_MODE), SDI_300),
            WriteRoute::Absolute
        );
        assert_eq!(
            write_route(by(prop::FLASH_COMPENSATION), SDI_200),
            WriteRoute::Absolute
        );
        let mut comp = by(prop::FLASH_COMPENSATION).clone();
        comp.get_set = 1;
        assert_eq!(write_route(&comp, SDI_300), WriteRoute::Absolute);
        assert_eq!(
            write_route(by(prop::FEL_STATE), SDI_200),
            WriteRoute::ReadOnly
        );
        assert_eq!(
            write_route(by(prop::SAVE_DESTINATION), SDI_200),
            WriteRoute::ReadOnly
        );
        assert_eq!(
            write_route(by(prop::EXPOSURE_PROGRAM), SDI_200),
            WriteRoute::ReadOnly
        );
        let snap = resolve_snapshot(&cm2_snapshot_payload(), Some(Grammar::TwoList)).unwrap();
        let by = |code| snap.descriptors.iter().find(|d| d.code == code).unwrap();
        assert_eq!(write_route(by(prop::ISO), SDI_300), WriteRoute::Absolute);
        // Zero writable choices: nothing to set.
        assert_eq!(
            write_route(by(prop::FOCUS_MODE), SDI_300),
            WriteRoute::ReadOnly
        );
    }

    #[test]
    fn live_view_frames_are_verified() {
        let jpeg = synthetic_jpeg(1024, 680, true);
        for layout in [LiveLayout::Sdi200, LiveLayout::Sdi300] {
            let payload = live_view_payload(&jpeg, layout, b"FOCAL");
            let frame = extract_live_view(&payload, layout).unwrap().unwrap();
            assert_eq!(frame.jpeg, &jpeg[..]);
            assert_eq!((frame.width, frame.height), (1024, 680));
            assert_eq!(frame.focal.is_some(), layout == LiveLayout::Sdi300);
        }
        // The embedded EXIF thumbnail's EOI does not end the outer frame.
        let first_eoi = jpeg.windows(2).position(|w| w == [0xFF, 0xD9]).unwrap() + 2;
        assert!(first_eoi < jpeg.len());
        // Sony's prefix may contain FF D8; the declared offset governs.
        let mut payload = live_view_payload(&jpeg, LiveLayout::Sdi200, b"");
        payload[4..8].copy_from_slice(&(jpeg.len() as u32).to_le_bytes());
        let frame = extract_live_view(&payload, LiveLayout::Sdi200)
            .unwrap()
            .unwrap();
        assert_eq!(frame.jpeg.len(), jpeg.len());

        // Not ready: zero JPEG size.
        let mut empty = vec![0u8; 16];
        empty[0] = 16;
        assert_eq!(extract_live_view(&empty, LiveLayout::Sdi300).unwrap(), None);
        // Size past the payload.
        let mut over = live_view_payload(&jpeg, LiveLayout::Sdi200, b"");
        over[4..8].copy_from_slice(&(jpeg.len() as u32 + 1000).to_le_bytes());
        assert!(extract_live_view(&over, LiveLayout::Sdi200).is_err());
        // Offset inside the v3 header.
        let mut inside = live_view_payload(&jpeg, LiveLayout::Sdi300, b"");
        inside[0..4].copy_from_slice(&8u32.to_le_bytes());
        assert!(extract_live_view(&inside, LiveLayout::Sdi300).is_err());
        // Missing SOI.
        let mut no_soi = live_view_payload(&jpeg, LiveLayout::Sdi200, b"");
        let off = u32::from_le_bytes(no_soi[0..4].try_into().unwrap()) as usize;
        no_soi[off + 1] = 0x00;
        assert!(extract_live_view(&no_soi, LiveLayout::Sdi200).is_err());
        // Truncated before the outer EOI.
        let mut cut = live_view_payload(&jpeg, LiveLayout::Sdi200, b"");
        let size = jpeg.len() as u32 - 2;
        cut[4..8].copy_from_slice(&size.to_le_bytes());
        assert!(extract_live_view(&cut, LiveLayout::Sdi200).is_err());
        // Progressive SOF2 dimensions.
        let progressive = synthetic_jpeg_with_sof(0xC2, 640, 424);
        assert_eq!(jpeg_scan(&progressive).unwrap().0, 640);
        assert_eq!(jpeg_scan(&progressive).unwrap().1, 424);
        // A frame header followed straight by EOI carries no image.
        let sos = progressive
            .windows(2)
            .position(|w| w == [0xFF, 0xDA])
            .unwrap();
        let mut headers_only = progressive[..sos].to_vec();
        headers_only.extend_from_slice(&[0xFF, 0xD9]);
        assert!(matches!(
            jpeg_scan(&headers_only),
            Err(ProtocolError::Malformed(m)) if m.contains("no image scan")
        ));
    }
}

//! PTP containers, checked little-endian cursors and the DeviceInfo/ObjectInfo datasets.

use std::fmt;

pub mod op {
    pub const GET_DEVICE_INFO: u16 = 0x1001;
    pub const OPEN_SESSION: u16 = 0x1002;
    pub const CLOSE_SESSION: u16 = 0x1003;
    pub const GET_STORAGE_IDS: u16 = 0x1004;
    pub const GET_OBJECT_HANDLES: u16 = 0x1007;
    pub const GET_OBJECT_INFO: u16 = 0x1008;
    pub const GET_OBJECT: u16 = 0x1009;
    pub const GET_PARTIAL_OBJECT: u16 = 0x101B;
    pub const SDIO_CONNECT: u16 = 0x9201;
    pub const SDIO_GET_EXT_DEVICE_INFO: u16 = 0x9202;
    pub const SONY_GET_DEVICE_PROP_DESC: u16 = 0x9203;
    pub const SONY_GET_DEVICE_PROP_VALUE: u16 = 0x9204;
    pub const SDIO_SET_EXT_DEVICE_PROP_VALUE: u16 = 0x9205;
    pub const SDIO_GET_CONTROL_DESC: u16 = 0x9206;
    pub const SDIO_CONTROL_DEVICE: u16 = 0x9207;
    pub const SDIO_GET_ALL_EXT_DEVICE_INFO: u16 = 0x9208;
    pub const SDIO_GET_ALL_EXT_DEVICE_PROP_INFO: u16 = 0x9209;
    pub const SDIO_GET_VENDOR_CODE_VERSION: u16 = 0x9216;
}

pub mod resp {
    pub const OK: u16 = 0x2001;
    pub const GENERAL_ERROR: u16 = 0x2002;
    pub const SESSION_NOT_OPEN: u16 = 0x2003;
    pub const OPERATION_NOT_SUPPORTED: u16 = 0x2005;
    pub const PARAMETER_NOT_SUPPORTED: u16 = 0x2006;
    pub const INVALID_STORAGE_ID: u16 = 0x2008;
    pub const INVALID_OBJECT_HANDLE: u16 = 0x2009;
    pub const ACCESS_DENIED: u16 = 0x200F;
    pub const STORE_NOT_AVAILABLE: u16 = 0x2013;
    pub const DEVICE_BUSY: u16 = 0x2019;
    pub const INVALID_PARAMETER: u16 = 0x201D;
    pub const SESSION_ALREADY_OPEN: u16 = 0x201E;
    pub const AUTHENTICATION_FAILED: u16 = 0xA101;

    pub fn name(code: u16) -> &'static str {
        match code {
            OK => "OK",
            GENERAL_ERROR => "GeneralError",
            SESSION_NOT_OPEN => "SessionNotOpen",
            OPERATION_NOT_SUPPORTED => "OperationNotSupported",
            PARAMETER_NOT_SUPPORTED => "ParameterNotSupported",
            INVALID_STORAGE_ID => "InvalidStorageID",
            INVALID_OBJECT_HANDLE => "InvalidObjectHandle",
            ACCESS_DENIED => "AccessDenied",
            STORE_NOT_AVAILABLE => "StoreNotAvailable",
            DEVICE_BUSY => "DeviceBusy",
            INVALID_PARAMETER => "InvalidParameter",
            SESSION_ALREADY_OPEN => "SessionAlreadyOpen",
            AUTHENTICATION_FAILED => "AuthenticationFailed",
            _ => "Unknown",
        }
    }
}

pub mod event {
    pub const OBJECT_ADDED: u16 = 0x4002;
    pub const OBJECT_REMOVED: u16 = 0x4003;
    pub const DEVICE_PROP_CHANGED: u16 = 0x4006;
    pub const SONY_OBJECT_ADDED: u16 = 0xC201;
    pub const SONY_OBJECT_REMOVED: u16 = 0xC202;
    pub const SONY_PROPERTY_CHANGED: u16 = 0xC203;
}

pub mod format {
    pub const UNDEFINED: u16 = 0x3000;
    pub const ASSOCIATION: u16 = 0x3001;
    pub const DEFINED_IMAGE: u16 = 0x3800;
    pub const EXIF_JPEG: u16 = 0x3801;
    pub const JFIF: u16 = 0x3808;
    pub const SONY_ARW: u16 = 0xB101;
    pub const SONY_HEIF: u16 = 0xB110;
}

pub mod handle {
    pub const CAPTURE: u32 = 0xFFFF_C001;
    pub const LIVE_VIEW: u32 = 0xFFFF_C002;
}

pub const SONY_VENDOR_EXTENSION: u32 = 0x0000_0011;
pub const HEADER_LEN: usize = 12;
pub const MAX_PARAMS: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    Truncated { at: usize, need: usize },
    Malformed(String),
    Unsupported(String),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolError::Truncated { at, need } => {
                write!(f, "dataset ends at byte {at}, {need} more needed")
            }
            ProtocolError::Malformed(m) => write!(f, "malformed dataset: {m}"),
            ProtocolError::Unsupported(m) => write!(f, "unsupported dataset: {m}"),
        }
    }
}

pub fn malformed<T>(message: impl Into<String>) -> Result<T, ProtocolError> {
    Err(ProtocolError::Malformed(message.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerKind {
    Command = 1,
    Data = 2,
    Response = 3,
    Event = 4,
}

impl ContainerKind {
    fn from_u16(v: u16) -> Option<Self> {
        match v {
            1 => Some(ContainerKind::Command),
            2 => Some(ContainerKind::Data),
            3 => Some(ContainerKind::Response),
            4 => Some(ContainerKind::Event),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Container<'a> {
    pub kind: ContainerKind,
    pub code: u16,
    pub tid: u32,
    pub payload: &'a [u8],
}

impl Container<'_> {
    /// Command, response and event payloads are u32 parameters.
    pub fn params(&self) -> Result<Vec<u32>, ProtocolError> {
        if self.payload.len() % 4 != 0 {
            return malformed("parameter block is not a whole number of u32 values");
        }
        let max = if self.kind == ContainerKind::Event {
            3
        } else {
            MAX_PARAMS
        };
        if self.payload.len() / 4 > max {
            return malformed("too many container parameters");
        }
        Ok(self
            .payload
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect())
    }
}

fn container(kind: ContainerKind, code: u16, tid: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(&((HEADER_LEN + payload.len()) as u32).to_le_bytes());
    out.extend_from_slice(&(kind as u16).to_le_bytes());
    out.extend_from_slice(&code.to_le_bytes());
    out.extend_from_slice(&tid.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

fn param_bytes(params: &[u32], max: usize) -> Result<Vec<u8>, ProtocolError> {
    if params.len() > max {
        return malformed(format!("at most {max} parameters"));
    }
    Ok(params.iter().flat_map(|p| p.to_le_bytes()).collect())
}

/// A type 1 command container, 12–32 bytes.
pub fn build_command(opcode: u16, tid: u32, params: &[u32]) -> Result<Vec<u8>, ProtocolError> {
    Ok(container(
        ContainerKind::Command,
        opcode,
        tid,
        &param_bytes(params, MAX_PARAMS)?,
    ))
}

pub fn build_data(opcode: u16, tid: u32, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    if payload.len() > (u32::MAX as usize) - HEADER_LEN {
        return malformed("data phase exceeds the u32 container length");
    }
    Ok(container(ContainerKind::Data, opcode, tid, payload))
}

pub fn build_response(code: u16, tid: u32, params: &[u32]) -> Result<Vec<u8>, ProtocolError> {
    Ok(container(
        ContainerKind::Response,
        code,
        tid,
        &param_bytes(params, MAX_PARAMS)?,
    ))
}

pub fn build_event(code: u16, tid: u32, params: &[u32]) -> Result<Vec<u8>, ProtocolError> {
    Ok(container(
        ContainerKind::Event,
        code,
        tid,
        &param_bytes(params, 3)?,
    ))
}

/// Parses exactly one container occupying the whole buffer.
pub fn parse_container(bytes: &[u8]) -> Result<Container<'_>, ProtocolError> {
    if bytes.len() < HEADER_LEN {
        return Err(ProtocolError::Truncated {
            at: bytes.len(),
            need: HEADER_LEN - bytes.len(),
        });
    }
    let declared = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if declared < HEADER_LEN {
        return malformed("container length is shorter than its header");
    }
    if declared != bytes.len() {
        return malformed(format!(
            "container declares {declared} bytes, {} received",
            bytes.len()
        ));
    }
    let kind = ContainerKind::from_u16(u16::from_le_bytes([bytes[4], bytes[5]]))
        .ok_or_else(|| ProtocolError::Malformed("unknown container type".into()))?;
    Ok(Container {
        kind,
        code: u16::from_le_bytes([bytes[6], bytes[7]]),
        tid: u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
        payload: &bytes[HEADER_LEN..],
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub code: u16,
    pub tid: u32,
    pub params: Vec<u32>,
}

pub fn parse_response(bytes: &[u8]) -> Result<Response, ProtocolError> {
    let c = parse_container(bytes)?;
    if c.kind != ContainerKind::Response {
        return malformed("expected a response container");
    }
    Ok(Response {
        code: c.code,
        tid: c.tid,
        params: c.params()?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub code: u16,
    pub tid: u32,
    pub params: Vec<u32>,
}

pub fn parse_event(bytes: &[u8]) -> Result<Event, ProtocolError> {
    let c = parse_container(bytes)?;
    if c.kind != ContainerKind::Event {
        return malformed("expected an event container");
    }
    Ok(Event {
        code: c.code,
        tid: c.tid,
        params: c.params()?,
    })
}

/// Whether a direct bulk transfer of `total` bytes must end with a zero-length packet.
pub fn needs_zero_length_packet(total: u64, max_packet: u16) -> bool {
    max_packet != 0 && total != 0 && total % max_packet as u64 == 0
}

/// Checked little-endian reader over a dataset.
#[derive(Debug, Clone)]
pub struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Cursor { bytes, pos: 0 }
    }

    pub fn at(bytes: &'a [u8], pos: usize) -> Self {
        Cursor { bytes, pos }
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8], ProtocolError> {
        if n > self.remaining() {
            return Err(ProtocolError::Truncated {
                at: self.pos,
                need: n - self.remaining(),
            });
        }
        let out = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], ProtocolError> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    pub fn u8(&mut self) -> Result<u8, ProtocolError> {
        Ok(self.take(1)?[0])
    }
    pub fn i8(&mut self) -> Result<i8, ProtocolError> {
        Ok(self.u8()? as i8)
    }
    pub fn u16(&mut self) -> Result<u16, ProtocolError> {
        Ok(u16::from_le_bytes(self.array()?))
    }
    pub fn i16(&mut self) -> Result<i16, ProtocolError> {
        Ok(i16::from_le_bytes(self.array()?))
    }
    pub fn u32(&mut self) -> Result<u32, ProtocolError> {
        Ok(u32::from_le_bytes(self.array()?))
    }
    pub fn i32(&mut self) -> Result<i32, ProtocolError> {
        Ok(i32::from_le_bytes(self.array()?))
    }
    pub fn u64(&mut self) -> Result<u64, ProtocolError> {
        Ok(u64::from_le_bytes(self.array()?))
    }
    pub fn i64(&mut self) -> Result<i64, ProtocolError> {
        Ok(i64::from_le_bytes(self.array()?))
    }
    pub fn u128(&mut self) -> Result<u128, ProtocolError> {
        Ok(u128::from_le_bytes(self.array()?))
    }
    pub fn i128(&mut self) -> Result<i128, ProtocolError> {
        Ok(i128::from_le_bytes(self.array()?))
    }

    /// u8 count of UTF-16LE units including the terminating NUL; zero is an empty string.
    pub fn ptp_string(&mut self) -> Result<String, ProtocolError> {
        let units = self.u8()? as usize;
        if units == 0 {
            return Ok(String::new());
        }
        let raw = self.take(units * 2)?;
        let mut code: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        if code.last() == Some(&0) {
            code.pop();
        }
        if code.contains(&0) {
            return malformed("PTP string contains an interior NUL");
        }
        String::from_utf16(&code).or_else(|_| malformed("PTP string is not valid UTF-16"))
    }

    pub fn u16_array(&mut self) -> Result<Vec<u16>, ProtocolError> {
        let n = self.u32()? as usize;
        if n > self.remaining() / 2 {
            return malformed("array count exceeds the dataset");
        }
        (0..n).map(|_| self.u16()).collect()
    }

    pub fn u32_array(&mut self) -> Result<Vec<u32>, ProtocolError> {
        let n = self.u32()? as usize;
        if n > self.remaining() / 4 {
            return malformed("array count exceeds the dataset");
        }
        (0..n).map(|_| self.u32()).collect()
    }
}

/// Little-endian writer for datasets and outbound values.
#[derive(Debug, Default, Clone)]
pub struct Writer(pub Vec<u8>);

impl Writer {
    pub fn new() -> Self {
        Writer(Vec::new())
    }
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn i16(&mut self, v: i16) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.0.extend_from_slice(v);
        self
    }
    pub fn ptp_string(&mut self, s: &str) -> &mut Self {
        if s.is_empty() {
            return self.u8(0);
        }
        let units: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
        self.u8(units.len().min(255) as u8);
        for u in units.into_iter().take(255) {
            self.u16(u);
        }
        self
    }
    pub fn u16_array(&mut self, v: &[u16]) -> &mut Self {
        self.u32(v.len() as u32);
        for x in v {
            self.u16(*x);
        }
        self
    }
    pub fn u32_array(&mut self, v: &[u32]) -> &mut Self {
        self.u32(v.len() as u32);
        for x in v {
            self.u32(*x);
        }
        self
    }
    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeviceInfo {
    pub standard_version: u16,
    pub vendor_extension_id: u32,
    pub vendor_extension_version: u16,
    pub vendor_extension_desc: String,
    pub functional_mode: u16,
    pub operations: Vec<u16>,
    pub events: Vec<u16>,
    pub properties: Vec<u16>,
    pub capture_formats: Vec<u16>,
    pub image_formats: Vec<u16>,
    pub manufacturer: String,
    pub model: String,
    pub device_version: String,
    pub serial_number: String,
}

impl DeviceInfo {
    pub fn parse(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let mut c = Cursor::new(bytes);
        Ok(DeviceInfo {
            standard_version: c.u16()?,
            vendor_extension_id: c.u32()?,
            vendor_extension_version: c.u16()?,
            vendor_extension_desc: c.ptp_string()?,
            functional_mode: c.u16()?,
            operations: c.u16_array()?,
            events: c.u16_array()?,
            properties: c.u16_array()?,
            capture_formats: c.u16_array()?,
            image_formats: c.u16_array()?,
            manufacturer: c.ptp_string()?,
            model: c.ptp_string()?,
            device_version: c.ptp_string()?,
            serial_number: c.ptp_string()?,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        w.u16(self.standard_version)
            .u32(self.vendor_extension_id)
            .u16(self.vendor_extension_version)
            .ptp_string(&self.vendor_extension_desc)
            .u16(self.functional_mode)
            .u16_array(&self.operations)
            .u16_array(&self.events)
            .u16_array(&self.properties)
            .u16_array(&self.capture_formats)
            .u16_array(&self.image_formats)
            .ptp_string(&self.manufacturer)
            .ptp_string(&self.model)
            .ptp_string(&self.device_version)
            .ptp_string(&self.serial_number);
        w.finish()
    }

    pub fn supports(&self, opcode: u16) -> bool {
        self.operations.contains(&opcode)
    }

    pub fn is_sony_remote(&self) -> bool {
        self.vendor_extension_id == SONY_VENDOR_EXTENSION
            && self.supports(op::SDIO_CONNECT)
            && self.supports(op::SDIO_GET_EXT_DEVICE_INFO)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ObjectInfo {
    pub storage_id: u32,
    pub object_format: u16,
    pub protection_status: u16,
    pub compressed_size: u32,
    pub thumb_format: u16,
    pub thumb_compressed_size: u32,
    pub thumb_width: u32,
    pub thumb_height: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub image_bit_depth: u32,
    pub parent_object: u32,
    pub association_type: u16,
    pub association_desc: u32,
    pub sequence_number: u32,
    pub filename: String,
    pub capture_date: String,
    pub modification_date: String,
    pub keywords: String,
}

impl ObjectInfo {
    pub fn parse(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let mut c = Cursor::new(bytes);
        let mut info = ObjectInfo {
            storage_id: c.u32()?,
            object_format: c.u16()?,
            protection_status: c.u16()?,
            compressed_size: c.u32()?,
            thumb_format: c.u16()?,
            thumb_compressed_size: c.u32()?,
            thumb_width: c.u32()?,
            thumb_height: c.u32()?,
            image_width: c.u32()?,
            image_height: c.u32()?,
            image_bit_depth: c.u32()?,
            parent_object: c.u32()?,
            association_type: c.u16()?,
            association_desc: c.u32()?,
            sequence_number: c.u32()?,
            ..Default::default()
        };
        info.filename = c.ptp_string()?;
        // Some bodies end the dataset after the filename.
        if !c.is_empty() {
            info.capture_date = c.ptp_string()?;
        }
        if !c.is_empty() {
            info.modification_date = c.ptp_string()?;
        }
        if !c.is_empty() {
            info.keywords = c.ptp_string()?;
        }
        Ok(info)
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        w.u32(self.storage_id)
            .u16(self.object_format)
            .u16(self.protection_status)
            .u32(self.compressed_size)
            .u16(self.thumb_format)
            .u32(self.thumb_compressed_size)
            .u32(self.thumb_width)
            .u32(self.thumb_height)
            .u32(self.image_width)
            .u32(self.image_height)
            .u32(self.image_bit_depth)
            .u32(self.parent_object)
            .u16(self.association_type)
            .u32(self.association_desc)
            .u32(self.sequence_number)
            .ptp_string(&self.filename)
            .ptp_string(&self.capture_date)
            .ptp_string(&self.modification_date)
            .ptp_string(&self.keywords);
        w.finish()
    }

    /// `YYYYMMDDThhmmss[.s][Z|±hhmm]` as `(YYYYMMDD, hhmmss)`.
    pub fn capture_date_parts(&self) -> Option<(String, String)> {
        let d = self.capture_date.as_bytes();
        if d.len() < 15 || d[8] != b'T' {
            return None;
        }
        let digits = |r: std::ops::Range<usize>| d[r.clone()].iter().all(u8::is_ascii_digit);
        if !digits(0..8) || !digits(9..15) {
            return None;
        }
        Some((
            self.capture_date[0..8].to_string(),
            self.capture_date[9..15].to_string(),
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Raw,
    Jpeg,
    Heif,
    Unknown,
}

impl FileKind {
    pub fn extension(self) -> &'static str {
        match self {
            FileKind::Raw => "ARW",
            FileKind::Jpeg => "JPG",
            FileKind::Heif => "HIF",
            FileKind::Unknown => "BIN",
        }
    }

    pub fn role(self) -> &'static str {
        match self {
            FileKind::Raw => "raw",
            FileKind::Jpeg => "jpeg",
            FileKind::Heif => "heif",
            FileKind::Unknown => "unknown",
        }
    }
}

fn suffix(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, s)| s.to_ascii_uppercase())
        .unwrap_or_default()
}

/// Expected kind before any bytes arrive.
pub fn kind_from_info(format_code: u16, filename: &str) -> FileKind {
    match format_code {
        format::SONY_ARW => FileKind::Raw,
        format::EXIF_JPEG | format::JFIF => FileKind::Jpeg,
        format::SONY_HEIF => FileKind::Heif,
        _ => match suffix(filename).as_str() {
            "ARW" => FileKind::Raw,
            "JPG" | "JPEG" => FileKind::Jpeg,
            "HIF" | "HEIF" | "HEIC" => FileKind::Heif,
            _ => FileKind::Unknown,
        },
    }
}

/// Whether leading file bytes are consistent with a kind. A TIFF header alone does not prove ARW,
/// so a RAW also needs the ObjectFormat or suffix to agree (checked by the caller).
pub fn magic_matches(kind: FileKind, head: &[u8]) -> bool {
    match kind {
        FileKind::Jpeg => head.starts_with(&[0xFF, 0xD8, 0xFF]),
        FileKind::Raw => head.starts_with(b"II*\0") || head.starts_with(b"MM\0*"),
        FileKind::Heif => {
            head.len() >= 12
                && &head[4..8] == b"ftyp"
                && matches!(
                    &head[8..12],
                    b"heic" | b"heix" | b"mif1" | b"msf1" | b"heif" | b"hevc"
                )
        }
        FileKind::Unknown => false,
    }
}

/// Final kind from the ObjectFormat, suffix and magic bytes together.
pub fn classify(format_code: u16, filename: &str, head: &[u8]) -> FileKind {
    let expected = kind_from_info(format_code, filename);
    if expected != FileKind::Unknown {
        return if magic_matches(expected, head) {
            expected
        } else {
            FileKind::Unknown
        };
    }
    if magic_matches(FileKind::Jpeg, head) {
        FileKind::Jpeg
    } else if magic_matches(FileKind::Heif, head) {
        FileKind::Heif
    } else {
        FileKind::Unknown
    }
}

/// Whether a transaction's data is a photo the camera has handed over and may not send again:
/// an acknowledged GetObject of the captured-object handle. Live View frames never are.
pub fn holds_captured_photo(opcode: u16, params: &[u32], response: u16) -> bool {
    opcode == op::GET_OBJECT && params.first() == Some(&handle::CAPTURE) && response == resp::OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_acknowledged_capture_download_is_kept_for_recovery() {
        assert!(holds_captured_photo(0x1009, &[0xFFFF_C001], 0x2001));
        assert!(!holds_captured_photo(0x1009, &[0xFFFF_C002], 0x2001));
        assert!(!holds_captured_photo(0x1009, &[], 0x2001));
        assert!(!holds_captured_photo(0x1009, &[0xFFFF_C001], 0x2019));
        assert!(!holds_captured_photo(0x1008, &[0xFFFF_C001], 0x2001));
    }

    #[test]
    fn command_container_matches_wire_bytes() {
        // α7 III firmware 4.0, TID 4: 9202(0xC8).
        let cmd = build_command(op::SDIO_GET_EXT_DEVICE_INFO, 4, &[0xC8]).unwrap();
        assert_eq!(
            cmd,
            [0x10, 0, 0, 0, 0x01, 0, 0x02, 0x92, 0x04, 0, 0, 0, 0xc8, 0, 0, 0]
        );
        // Synthetic S2 down at TID 7.
        let cmd = build_command(op::SDIO_CONTROL_DEVICE, 7, &[0xD2C2]).unwrap();
        assert_eq!(
            cmd,
            [0x10, 0, 0, 0, 1, 0, 0x07, 0x92, 7, 0, 0, 0, 0xc2, 0xd2, 0, 0]
        );
        let data = build_data(op::SDIO_CONTROL_DEVICE, 7, &[2, 0]).unwrap();
        assert_eq!(data, [0x0e, 0, 0, 0, 2, 0, 0x07, 0x92, 7, 0, 0, 0, 2, 0]);
        let ok = build_response(resp::OK, 7, &[]).unwrap();
        assert_eq!(ok, [0x0c, 0, 0, 0, 3, 0, 0x01, 0x20, 7, 0, 0, 0]);
        assert_eq!(
            parse_response(&ok).unwrap(),
            Response {
                code: resp::OK,
                tid: 7,
                params: vec![]
            }
        );
        // The 9209 data header from the same trace at TID 10.
        let mut v = vec![0xad, 0x06, 0, 0, 0x02, 0, 0x09, 0x92, 0x0a, 0, 0, 0];
        v.resize(0x6ad, 0);
        let c = parse_container(&v).unwrap();
        assert_eq!(c.kind, ContainerKind::Data);
        assert_eq!(c.code, op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO);
        assert_eq!((c.tid, c.payload.len()), (10, 1709 - 12));
    }

    #[test]
    fn containers_reject_bad_framing() {
        assert!(build_command(0x1001, 0, &[1, 2, 3, 4, 5, 6]).is_err());
        assert!(matches!(
            parse_container(&[0x0c, 0, 0]),
            Err(ProtocolError::Truncated { .. })
        ));
        // Declared length disagrees with the received bytes.
        assert!(parse_container(&[0x10, 0, 0, 0, 3, 0, 1, 0x20, 1, 0, 0, 0]).is_err());
        // Unknown container type.
        assert!(parse_container(&[0x0c, 0, 0, 0, 9, 0, 1, 0x20, 1, 0, 0, 0]).is_err());
        // Parameter block not divisible by four.
        let odd = [0x0e, 0, 0, 0, 3, 0, 1, 0x20, 1, 0, 0, 0, 1, 0];
        assert!(parse_response(&odd).is_err());
        // A data container is not a response.
        let data = build_data(0x1009, 1, &[1, 2, 3, 4]).unwrap();
        assert!(parse_response(&data).is_err());
        // Event with four parameters.
        let ev = container(ContainerKind::Event, 0xC201, 0, &[0; 16]);
        assert!(parse_event(&ev).is_err());
        let ev = build_event(event::SONY_PROPERTY_CHANGED, 0xFFFF_FFFF, &[0x5004]).unwrap();
        let parsed = parse_event(&ev).unwrap();
        assert_eq!(
            (parsed.code, parsed.tid, parsed.params),
            (0xC203, 0xFFFF_FFFF, vec![0x5004])
        );
    }

    #[test]
    fn zero_length_packets_follow_the_endpoint_size() {
        // 500 data bytes + 12 header on a 512-byte high-speed endpoint.
        assert!(needs_zero_length_packet(512, 512));
        assert!(!needs_zero_length_packet(511, 512));
        assert!(!needs_zero_length_packet(513, 512));
        assert!(needs_zero_length_packet(2048, 1024));
        assert!(!needs_zero_length_packet(1536, 1024));
        assert!(needs_zero_length_packet(1536, 512));
        assert!(needs_zero_length_packet(64, 64));
        assert!(!needs_zero_length_packet(0, 512));
    }

    fn device_info(model: &str) -> DeviceInfo {
        DeviceInfo {
            standard_version: 100,
            vendor_extension_id: SONY_VENDOR_EXTENSION,
            vendor_extension_version: 100,
            vendor_extension_desc: "Sony PTP Extensions".into(),
            functional_mode: 0,
            operations: vec![
                0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x9201, 0x9202, 0x9209,
            ],
            events: vec![0xC201, 0xC202, 0xC203],
            properties: vec![],
            capture_formats: vec![0xB101, 0x3801],
            image_formats: vec![0xB101, 0x3801],
            manufacturer: "Sony Corporation".into(),
            model: model.into(),
            device_version: "4.00".into(),
            serial_number: "00000000000000000000000000000000".into(),
        }
    }

    #[test]
    fn device_info_round_trips_and_identifies_sony_remote() {
        for model in ["ILCE-7M3", "ILCE-7CM2"] {
            let info = device_info(model);
            let bytes = info.encode();
            let parsed = DeviceInfo::parse(&bytes).unwrap();
            assert_eq!(parsed, info);
            assert!(parsed.is_sony_remote());
        }
        let mut mtp = device_info("ILCE-7CM2");
        mtp.vendor_extension_id = 6;
        assert!(!DeviceInfo::parse(&mtp.encode()).unwrap().is_sony_remote());
        let bytes = device_info("ILCE-7M3").encode();
        assert!(DeviceInfo::parse(&bytes[..bytes.len() - 3]).is_err());
        // An operation count that cannot fit the dataset.
        let mut w = Writer::new();
        w.u16(100).u32(0x11).u16(100).u8(0).u16(0).u32(0x4000_0000);
        assert!(DeviceInfo::parse(&w.finish()).is_err());
    }

    #[test]
    fn ptp_strings_are_counted_utf16() {
        let mut w = Writer::new();
        w.ptp_string("DSC01234.ARW").ptp_string("").ptp_string("α7");
        let bytes = w.finish();
        assert_eq!(bytes[0], 13);
        let mut c = Cursor::new(&bytes);
        assert_eq!(c.ptp_string().unwrap(), "DSC01234.ARW");
        assert_eq!(c.ptp_string().unwrap(), "");
        assert_eq!(c.ptp_string().unwrap(), "α7");
        assert!(c.is_empty());
        assert!(Cursor::new(&[3, b'a', 0]).ptp_string().is_err());
        assert!(Cursor::new(&[3, b'a', 0, 0, 0, b'b', 0])
            .ptp_string()
            .is_err());
    }

    #[test]
    fn object_info_has_classic_offsets() {
        let info = ObjectInfo {
            storage_id: 0x0001_0001,
            object_format: format::SONY_ARW,
            compressed_size: 24_510_976,
            image_width: 6000,
            image_height: 4000,
            sequence_number: 7,
            filename: "DSC00042.ARW".into(),
            capture_date: "20261125T143015".into(),
            modification_date: "20261125T143015".into(),
            ..Default::default()
        };
        let bytes = info.encode();
        assert_eq!(&bytes[4..6], &[0x01, 0xB1]);
        assert_eq!(&bytes[8..12], &24_510_976u32.to_le_bytes());
        assert_eq!(&bytes[26..30], &6000u32.to_le_bytes());
        assert_eq!(&bytes[48..52], &7u32.to_le_bytes());
        assert_eq!(bytes[52], 13);
        let parsed = ObjectInfo::parse(&bytes).unwrap();
        assert_eq!(parsed, info);
        assert_eq!(
            parsed.capture_date_parts(),
            Some(("20261125".into(), "143015".into()))
        );
        // Filename only.
        let short = &bytes[..52 + 1 + 26];
        assert_eq!(ObjectInfo::parse(short).unwrap().filename, "DSC00042.ARW");
        assert!(ObjectInfo::parse(&bytes[..51]).is_err());
    }

    #[test]
    fn files_are_classified_by_format_suffix_and_magic() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE1, 0, 0];
        let tiff = *b"II*\0\x08\0\0\0";
        let mut heif = vec![0, 0, 0, 0x18];
        heif.extend_from_slice(b"ftypheic");
        assert_eq!(classify(format::SONY_ARW, "DSC1.ARW", &tiff), FileKind::Raw);
        assert_eq!(
            classify(format::EXIF_JPEG, "DSC1.JPG", &jpeg),
            FileKind::Jpeg
        );
        assert_eq!(classify(format::JFIF, "x", &jpeg), FileKind::Jpeg);
        assert_eq!(
            classify(format::SONY_HEIF, "DSC1.HIF", &heif),
            FileKind::Heif
        );
        assert_eq!(
            classify(format::DEFINED_IMAGE, "dsc1.arw", &tiff),
            FileKind::Raw
        );
        assert_eq!(
            classify(format::DEFINED_IMAGE, "DSC1", &jpeg),
            FileKind::Jpeg
        );
        // A TIFF header without an ARW format or suffix is not enough.
        assert_eq!(
            classify(format::UNDEFINED, "DSC1", &tiff),
            FileKind::Unknown
        );
        // Format and content disagree.
        assert_eq!(
            classify(format::SONY_ARW, "DSC1.ARW", &jpeg),
            FileKind::Unknown
        );
    }
}

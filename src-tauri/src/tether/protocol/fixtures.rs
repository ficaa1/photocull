//! Synthetic datasets shaped like the α7 III firmware 4.0 trace and the α7C II SDI 300 profile.

use super::codec::{
    control, dtype, encode_snapshot, prop, DevicePropDesc, Form, Grammar, LiveLayout, PropValue,
};
use super::ptp::{op, DeviceInfo, ObjectInfo, Writer, SONY_VENDOR_EXTENSION};

pub fn device_info(model: &str) -> DeviceInfo {
    DeviceInfo {
        standard_version: 100,
        vendor_extension_id: SONY_VENDOR_EXTENSION,
        vendor_extension_version: 100,
        vendor_extension_desc: "Sony PTP Extensions".into(),
        functional_mode: 0,
        operations: vec![
            op::GET_DEVICE_INFO,
            op::OPEN_SESSION,
            op::CLOSE_SESSION,
            op::GET_OBJECT_INFO,
            op::GET_OBJECT,
            op::SDIO_CONNECT,
            op::SDIO_GET_EXT_DEVICE_INFO,
            op::SDIO_SET_EXT_DEVICE_PROP_VALUE,
            op::SDIO_CONTROL_DEVICE,
            op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO,
        ],
        events: vec![0xC201, 0xC202, 0xC203],
        properties: vec![],
        capture_formats: vec![0xB101, 0x3801],
        image_formats: vec![0xB101, 0x3801],
        manufacturer: "Sony Corporation".into(),
        model: model.into(),
        device_version: if model == "ILCE-7M3" { "4.00" } else { "2.01" }.into(),
        serial_number: "0123456789ABCDEF0123456789ABCDEF".into(),
    }
}

fn ext_info(version: u16, props: usize, controls: usize, base: &[u16], ctl: &[u16]) -> Vec<u8> {
    let mut p: Vec<u16> = base.to_vec();
    let mut next = 0xD100u16;
    while p.len() < props {
        if !p.contains(&next) {
            p.push(next);
        }
        next += 1;
    }
    let mut c: Vec<u16> = ctl.to_vec();
    let mut next = 0xD2E0u16;
    while c.len() < controls {
        if !c.contains(&next) {
            c.push(next);
        }
        next += 1;
    }
    let mut w = Writer::new();
    w.u16(version).u16_array(&p).u16_array(&c);
    w.finish()
}

pub fn m3_ext_device_info() -> Vec<u8> {
    ext_info(
        200,
        44,
        17,
        &[
            prop::COMPRESSION,
            prop::WHITE_BALANCE,
            prop::F_NUMBER,
            prop::FOCUS_MODE,
            prop::METERING,
            prop::FLASH_MODE,
            prop::EXPOSURE_PROGRAM,
            prop::EXPOSURE_BIAS,
            prop::FLASH_COMPENSATION,
            prop::FEL_STATE,
            prop::DRIVE_MODE,
            prop::SHUTTER_SPEED,
            prop::ISO,
            prop::OBJECT_IN_MEMORY,
            prop::FOCUS_INDICATION,
            prop::LIVE_VIEW_STATUS,
            prop::SAVE_DESTINATION,
            prop::NEAR_FAR_ENABLE,
        ],
        &[
            control::S1,
            control::S2,
            control::AEL,
            control::FEL,
            control::NEAR_FAR,
            control::AF_MF_HOLD,
            control::MAGNIFIER,
            control::MAGNIFIER_CANCEL,
        ],
    )
}

pub fn cm2_ext_device_info() -> Vec<u8> {
    ext_info(
        300,
        421,
        59,
        &[
            prop::WHITE_BALANCE,
            prop::F_NUMBER,
            prop::FOCUS_MODE,
            prop::EXPOSURE_PROGRAM,
            prop::DRIVE_MODE,
            prop::ISO,
            prop::FILE_FORMAT,
            prop::JPEG_QUALITY,
            prop::RAW_FILE_TYPE,
            prop::OBJECT_IN_MEMORY,
            prop::NEAR_FAR_ENABLE,
            prop::FOCAL_POSITION,
        ],
        &[
            control::S1,
            control::S2,
            control::NEAR_FAR,
            control::AF_MF_HOLD,
            control::FOCUS_STEP_NEAR,
            control::FOCUS_STEP_FAR,
            control::AF_AREA_POSITION,
        ],
    )
}

fn d(
    code: u16,
    t: u16,
    gs: u8,
    en: u8,
    def: PropValue,
    cur: PropValue,
    form: Form,
) -> DevicePropDesc {
    DevicePropDesc {
        code,
        data_type: t,
        get_set: gs,
        is_enabled: en,
        default: def,
        current: cur,
        form,
    }
}

fn one_list(values: Vec<PropValue>) -> Form {
    Form::Enum {
        writable: values.clone(),
        reportable: values,
    }
}

fn u16s(v: &[u16]) -> Vec<PropValue> {
    v.iter().map(|x| PropValue::U16(*x)).collect()
}
fn u8s(v: &[u8]) -> Vec<PropValue> {
    v.iter().map(|x| PropValue::U8(*x)).collect()
}
fn u32s(v: &[u32]) -> Vec<PropValue> {
    v.iter().map(|x| PropValue::U32(*x)).collect()
}
fn i16s(v: &[i16]) -> Vec<PropValue> {
    v.iter().map(|x| PropValue::I16(*x)).collect()
}

pub const M3_SHUTTERS: [u32; 12] = [
    0x001E_000A,
    0x000A_000A,
    0x0001_0002,
    0x0001_0004,
    0x0001_0008,
    0x0001_000F,
    0x0001_001E,
    0x0001_003C,
    0x0001_007D,
    0x0001_00FA,
    0x0001_01F4,
    0x0001_03E8,
];

pub const M3_ISOS: [u32; 9] = [
    0x00FF_FFFF,
    100,
    200,
    400,
    800,
    1600,
    3200,
    0x0100_0320,
    0x0200_0320,
];

const EV_THIRDS: [i16; 19] = [
    -3000, -2700, -2300, -2000, -1700, -1300, -1000, -700, -300, 0, 300, 700, 1000, 1300, 1700,
    2000, 2300, 2700, 3000,
];

/// Sixty single-list records laid out like the 1,709-byte firmware 4.0 data container.
pub fn m3_descriptors() -> Vec<DevicePropDesc> {
    use dtype::*;
    let mut v = vec![
        d(
            prop::COMPRESSION,
            UINT8,
            1,
            1,
            PropValue::U8(2),
            PropValue::U8(0x13),
            one_list(u8s(&[2, 3, 4, 0x10, 0x12, 0x13, 0x14])),
        ),
        d(
            prop::WHITE_BALANCE,
            UINT16,
            1,
            1,
            PropValue::U16(2),
            PropValue::U16(2),
            one_list(u16s(&[
                2, 4, 0x8011, 0x8010, 6, 0x8001, 0x8002, 0x8003, 0x8004, 7, 0x8030, 0x8012, 0x8020,
                0x8021, 0x8022,
            ])),
        ),
        d(
            prop::F_NUMBER,
            UINT16,
            0,
            1,
            PropValue::U16(0),
            PropValue::U16(0x0320),
            Form::Range {
                min: PropValue::U16(0),
                max: PropValue::U16(0xFFFF),
                step: PropValue::U16(1),
            },
        ),
        d(
            prop::FOCUS_MODE,
            UINT16,
            1,
            1,
            PropValue::U16(2),
            PropValue::U16(2),
            one_list(u16s(&[2, 0x8004, 0x8005, 0x8006, 1, 0x8009])),
        ),
        d(
            prop::METERING,
            UINT16,
            1,
            1,
            PropValue::U16(0x8001),
            PropValue::U16(0x8001),
            one_list(u16s(&[0x8001, 0x8002, 0x8003, 0x8004, 0x8005, 0x8006])),
        ),
        d(
            prop::EXPOSURE_PROGRAM,
            UINT16,
            0,
            2,
            PropValue::U16(2),
            PropValue::U16(1),
            one_list(u16s(&[1, 2, 3, 4, 0x8000])),
        ),
        d(
            prop::EXPOSURE_BIAS,
            INT16,
            0,
            1,
            PropValue::I16(0),
            PropValue::I16(0),
            one_list(i16s(&EV_THIRDS)),
        ),
        d(
            prop::DRIVE_MODE,
            UINT16,
            1,
            1,
            PropValue::U16(1),
            PropValue::U16(1),
            one_list(u16s(&[
                1, 0x8012, 0x8015, 2, 0x8010, 0x8005, 0x8003, 0x8004, 0x8337, 0x8537, 0x8937,
                0x8336,
            ])),
        ),
        d(
            prop::SHUTTER_SPEED,
            UINT32,
            0,
            1,
            PropValue::U32(0),
            PropValue::U32(0x0001_00FA),
            one_list(u32s(&M3_SHUTTERS)),
        ),
        d(
            prop::COLOR_TEMPERATURE,
            UINT16,
            1,
            0,
            PropValue::U16(0),
            PropValue::U16(0),
            Form::Range {
                min: PropValue::U16(2500),
                max: PropValue::U16(9900),
                step: PropValue::U16(100),
            },
        ),
        d(
            prop::WB_GREEN_MAGENTA,
            UINT8,
            1,
            1,
            PropValue::U8(0x80),
            PropValue::U8(0xC0),
            Form::Range {
                min: PropValue::U8(0xA4),
                max: PropValue::U8(0xDC),
                step: PropValue::U8(1),
            },
        ),
        d(
            prop::WB_AMBER_BLUE,
            UINT8,
            1,
            1,
            PropValue::U8(0x80),
            PropValue::U8(0xC0),
            Form::Range {
                min: PropValue::U8(0xA4),
                max: PropValue::U8(0xDC),
                step: PropValue::U8(2),
            },
        ),
        d(
            prop::ASPECT_RATIO,
            UINT8,
            1,
            1,
            PropValue::U8(1),
            PropValue::U8(1),
            one_list(u8s(&[1, 2])),
        ),
        d(
            prop::FOCUS_INDICATION,
            UINT8,
            0,
            2,
            PropValue::U8(1),
            PropValue::U8(1),
            one_list(u8s(&[1, 2, 3, 5, 6, 7])),
        ),
        d(
            prop::OBJECT_IN_MEMORY,
            UINT16,
            0,
            2,
            PropValue::U16(0),
            PropValue::U16(0x8001),
            Form::None,
        ),
        d(
            prop::BATTERY_REMAINING,
            INT8,
            0,
            2,
            PropValue::I8(-1),
            PropValue::I8(0x33),
            Form::Range {
                min: PropValue::I8(-1),
                max: PropValue::I8(100),
                step: PropValue::I8(1),
            },
        ),
        d(
            prop::ISO,
            UINT32,
            0,
            1,
            PropValue::U32(0x00FF_FFFF),
            PropValue::U32(0x00FF_FFFF),
            one_list(u32s(&M3_ISOS)),
        ),
        d(
            prop::LIVE_VIEW_STATUS,
            UINT8,
            0,
            2,
            PropValue::U8(0),
            PropValue::U8(1),
            Form::None,
        ),
        d(
            prop::SAVE_DESTINATION,
            UINT16,
            0,
            2,
            PropValue::U16(1),
            PropValue::U16(1),
            one_list(u16s(&[1, 0x11])),
        ),
        d(
            prop::FOCUS_AREA,
            UINT16,
            1,
            1,
            PropValue::U16(1),
            PropValue::U16(1),
            one_list(u16s(&[1, 2, 3, 0x101, 0x102, 0x103, 0x104])),
        ),
        d(
            prop::FLASH_MODE,
            UINT16,
            1,
            1,
            PropValue::U16(2),
            PropValue::U16(2),
            one_list(u16s(&[
                0, 1, 2, 3, 4, 5, 6, 0x8001, 0x8003, 0x8004, 0x8032, 0x8ABC,
            ])),
        ),
        d(
            prop::FLASH_COMPENSATION,
            INT16,
            1,
            1,
            PropValue::I16(0),
            PropValue::I16(0),
            one_list(i16s(&EV_THIRDS)),
        ),
        d(
            prop::FEL_STATE,
            UINT8,
            0,
            2,
            PropValue::U8(1),
            PropValue::U8(1),
            Form::None,
        ),
        d(
            prop::NEAR_FAR_ENABLE,
            UINT8,
            0,
            2,
            PropValue::U8(0),
            PropValue::U8(1),
            one_list(u8s(&[0, 1])),
        ),
        d(
            control::S1,
            UINT16,
            0x81,
            1,
            PropValue::U16(1),
            PropValue::U16(1),
            one_list(u16s(&[1, 2])),
        ),
        d(
            control::S2,
            UINT16,
            0x81,
            1,
            PropValue::U16(1),
            PropValue::U16(1),
            one_list(u16s(&[1, 2])),
        ),
    ];
    let near_far = d(
        control::NEAR_FAR,
        INT16,
        0x82,
        1,
        PropValue::I16(0),
        PropValue::I16(0),
        Form::Range {
            min: PropValue::I16(-7),
            max: PropValue::I16(7),
            step: PropValue::I16(1),
        },
    );
    // Pad with opaque u8 enumerations so D2D1 starts at 0x690 as record 60.
    let used: usize = 8 + v
        .iter()
        .map(|r| r.encode(Grammar::SingleList).len())
        .sum::<usize>();
    let fillers = 60 - 1 - v.len();
    let room = 0x690 - used;
    assert!(room >= fillers * 11, "fixture layout does not fit");
    let extra = room - fillers * 11;
    for i in 0..fillers {
        let n = extra / fillers + usize::from(i < extra % fillers);
        let values: Vec<u8> = (0..n as u8).collect();
        v.push(d(
            0xD100 + i as u16,
            UINT8,
            1,
            1,
            PropValue::U8(0),
            PropValue::U8(0),
            one_list(u8s(&values)),
        ));
    }
    v.push(near_far);
    v
}

pub fn m3_snapshot_payload() -> Vec<u8> {
    encode_snapshot(&m3_descriptors(), Grammar::SingleList)
}

fn two(writable: Vec<PropValue>, reportable: Vec<PropValue>) -> Form {
    Form::Enum {
        writable,
        reportable,
    }
}

pub fn cm2_descriptors() -> Vec<DevicePropDesc> {
    use dtype::*;
    vec![
        // Lens without AF: an empty Set list followed by the next record.
        d(
            prop::FOCUS_MODE,
            UINT16,
            1,
            1,
            PropValue::U16(1),
            PropValue::U16(1),
            two(vec![], u16s(&[1, 2, 0x8004, 0x8005, 0x8006])),
        ),
        d(
            prop::METERING,
            UINT16,
            1,
            1,
            PropValue::U16(0x8001),
            PropValue::U16(0x8001),
            two(
                u16s(&[0x8001, 0x8002, 0x8004]),
                u16s(&[0x8001, 0x8002, 0x8003, 0x8004, 0x8005, 0x8006]),
            ),
        ),
        d(
            prop::WHITE_BALANCE,
            UINT16,
            1,
            1,
            PropValue::U16(2),
            PropValue::U16(2),
            two(
                u16s(&[2, 4, 0x8011, 0x8010, 0x8012]),
                u16s(&[2, 4, 0x8011, 0x8010, 0x8012]),
            ),
        ),
        d(
            prop::EXPOSURE_PROGRAM,
            UINT32,
            0,
            2,
            PropValue::U32(0x0001_0002),
            PropValue::U32(0x0002_0003),
            two(
                vec![],
                u32s(&[1, 0x0001_0002, 0x0002_0003, 0x0003_0004, 0x0004_8000]),
            ),
        ),
        d(
            prop::DRIVE_MODE,
            UINT32,
            1,
            1,
            PropValue::U32(1),
            PropValue::U32(0x0004_8337),
            two(
                u32s(&[1, 0x0001_8012, 0x0004_8337, 0x0005_8536]),
                u32s(&[1, 0x0001_8012, 0x0004_8337, 0x0005_8536]),
            ),
        ),
        d(
            prop::F_NUMBER,
            UINT16,
            1,
            1,
            PropValue::U16(0x0118),
            PropValue::U16(0x0118),
            two(
                u16s(&[0x0118, 0x015E, 0x0190, 0x0230, 0x0320]),
                u16s(&[0x0118, 0x015E, 0x0190, 0x0230, 0x0320]),
            ),
        ),
        d(
            prop::SHUTTER_SPEED,
            UINT32,
            1,
            1,
            PropValue::U32(0x0001_007D),
            PropValue::U32(0x0001_007D),
            two(
                u32s(&[0x0001_003C, 0x0001_007D, 0x0001_00FA]),
                u32s(&[0x0001_003C, 0x0001_007D, 0x0001_00FA]),
            ),
        ),
        d(
            prop::ISO,
            UINT32,
            1,
            1,
            PropValue::U32(0x00FF_FFFF),
            PropValue::U32(800),
            two(
                u32s(&[0x00FF_FFFF, 100, 400, 800, 1600]),
                u32s(&[0x00FF_FFFF, 100, 400, 800, 1600]),
            ),
        ),
        d(
            prop::EXPOSURE_BIAS,
            INT16,
            1,
            1,
            PropValue::I16(0),
            PropValue::I16(0),
            two(i16s(&EV_THIRDS), i16s(&EV_THIRDS)),
        ),
        d(
            prop::FILE_FORMAT,
            UINT8,
            1,
            1,
            PropValue::U8(3),
            PropValue::U8(2),
            two(u8s(&[1, 2, 3, 4, 5]), u8s(&[1, 2, 3, 4, 5])),
        ),
        d(
            prop::JPEG_QUALITY,
            UINT8,
            1,
            1,
            PropValue::U8(2),
            PropValue::U8(1),
            two(u8s(&[1, 2, 3, 4]), u8s(&[1, 2, 3, 4])),
        ),
        d(
            prop::RAW_FILE_TYPE,
            UINT8,
            1,
            1,
            PropValue::U8(1),
            PropValue::U8(2),
            two(u8s(&[1, 2, 3, 4]), u8s(&[1, 2, 3, 4])),
        ),
        d(
            prop::SAVE_DESTINATION,
            UINT16,
            0,
            2,
            PropValue::U16(1),
            PropValue::U16(0x0011),
            two(vec![], u16s(&[1, 0x11, 0x10])),
        ),
        d(
            prop::OBJECT_IN_MEMORY,
            UINT16,
            0,
            2,
            PropValue::U16(0),
            PropValue::U16(0),
            Form::None,
        ),
        d(
            prop::FOCUS_INDICATION,
            UINT8,
            0,
            2,
            PropValue::U8(1),
            PropValue::U8(1),
            two(vec![], u8s(&[1, 2, 3, 5, 6, 7])),
        ),
        d(
            prop::LIVE_VIEW_STATUS,
            UINT8,
            0,
            2,
            PropValue::U8(0),
            PropValue::U8(1),
            Form::None,
        ),
        d(
            prop::BATTERY_REMAINING,
            INT8,
            0,
            2,
            PropValue::I8(-1),
            PropValue::I8(78),
            Form::None,
        ),
        d(
            prop::NEAR_FAR_ENABLE,
            UINT8,
            0,
            2,
            PropValue::U8(0),
            PropValue::U8(1),
            Form::None,
        ),
        d(
            prop::FOCAL_POSITION,
            UINT8,
            0,
            2,
            PropValue::U8(0),
            PropValue::U8(42),
            Form::None,
        ),
        d(
            control::NEAR_FAR,
            INT16,
            0x82,
            1,
            PropValue::I16(0),
            PropValue::I16(0),
            Form::Range {
                min: PropValue::I16(-7),
                max: PropValue::I16(7),
                step: PropValue::I16(1),
            },
        ),
    ]
}

pub fn cm2_snapshot_payload() -> Vec<u8> {
    encode_snapshot(&cm2_descriptors(), Grammar::TwoList)
}

/// Replaces the current value of `code`.
pub fn with_current(
    mut descs: Vec<DevicePropDesc>,
    code: u16,
    value: PropValue,
) -> Vec<DevicePropDesc> {
    let record = descs
        .iter_mut()
        .find(|r| r.code == code)
        .expect("fixture property");
    record.current = value;
    descs
}

/// Two records that consume the same bytes under either grammar with different meanings.
pub fn ambiguous_snapshot_payload() -> Vec<u8> {
    let mut p = 2u64.to_le_bytes().to_vec();
    p.extend_from_slice(&[0x11, 0xD2, 0x02, 0x00, 1, 1, 0, 0, 2, 0x01, 0x00, 0x05]);
    p.extend_from_slice(&[
        0x00, 0x00, 0x04, 0x00, 0x02, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ]);
    p
}

pub fn object_info(format: u16, name: &str, size: u32, sequence: u32) -> Vec<u8> {
    ObjectInfo {
        storage_id: 0x0001_0001,
        object_format: format,
        compressed_size: size,
        image_width: 6000,
        image_height: 4000,
        sequence_number: sequence,
        filename: name.into(),
        capture_date: "20261125T143015".into(),
        modification_date: "20261125T143015".into(),
        ..Default::default()
    }
    .encode()
}

pub fn jpeg_file(len: usize) -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8, 0xFF, 0xE1];
    v.resize(len.max(6) - 2, 0x11);
    v.extend_from_slice(&[0xFF, 0xD9]);
    v
}

pub fn arw_file(len: usize) -> Vec<u8> {
    let mut v = b"II*\0\x08\0\0\0".to_vec();
    v.resize(len.max(8), 0x22);
    v
}

fn segment(out: &mut Vec<u8>, marker: u8, body: &[u8]) {
    out.extend_from_slice(&[0xFF, marker]);
    out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(body);
}

pub fn synthetic_jpeg_with_sof(sof: u8, width: u16, height: u16) -> Vec<u8> {
    let mut j = vec![0xFF, 0xD8];
    segment(&mut j, 0xDB, &[0; 65]);
    let mut frame = vec![8];
    frame.extend_from_slice(&height.to_be_bytes());
    frame.extend_from_slice(&width.to_be_bytes());
    frame.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    segment(&mut j, sof, &frame);
    segment(&mut j, 0xC4, &[0; 20]);
    segment(&mut j, 0xDA, &[3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
    // Entropy data with a stuffed FF00 and a restart marker.
    j.extend_from_slice(&[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0x78]);
    j.extend_from_slice(&[0xFF, 0xD9]);
    j
}

/// A frame whose APP1 carries an EXIF thumbnail with its own SOI/EOI.
pub fn synthetic_jpeg(width: u16, height: u16, thumbnail: bool) -> Vec<u8> {
    let body = synthetic_jpeg_with_sof(0xC0, width, height);
    if !thumbnail {
        return body;
    }
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&synthetic_jpeg_with_sof(0xC0, 160, 120));
    let mut j = vec![0xFF, 0xD8];
    segment(&mut j, 0xE1, &app1);
    j.extend_from_slice(&body[2..]);
    j
}

/// Header, a reserved prefix containing FF D8, the JPEG and optional focal-frame data.
pub fn live_view_payload(jpeg: &[u8], layout: LiveLayout, focal: &[u8]) -> Vec<u8> {
    let header = match layout {
        LiveLayout::Sdi200 => 8,
        LiveLayout::Sdi300 => 16,
    };
    let offset = header + 8;
    let mut p = vec![0u8; offset];
    p[header..header + 4].copy_from_slice(&[0xFF, 0xD8, 0xFF, 0xD9]);
    p[0..4].copy_from_slice(&(offset as u32).to_le_bytes());
    p[4..8].copy_from_slice(&(jpeg.len() as u32).to_le_bytes());
    p.extend_from_slice(jpeg);
    if layout == LiveLayout::Sdi300 && !focal.is_empty() {
        let focal_offset = p.len() as u32;
        p[8..12].copy_from_slice(&focal_offset.to_le_bytes());
        p[12..16].copy_from_slice(&(focal.len() as u32).to_le_bytes());
        p.extend_from_slice(focal);
    }
    p
}

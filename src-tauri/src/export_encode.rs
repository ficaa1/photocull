//! Export codec options missing from the pinned Lightcraft export layer.
use lightcraft_engine::export::{ExportFormat, ExportOptions, OutputDepth};
use lightcraft_pipeline::{DeepSamples, Rendered};
use lightcraft_raster::Rgba8;
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AvifSpeed {
    Faster,
    Balanced,
    Smaller,
}
#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtraOptions {
    pub webp_lossless: bool,
    pub avif_speed: AvifSpeed,
    #[serde(skip)]
    pub watermark: Option<crate::watermark::Watermark>,
}
impl Default for ExtraOptions {
    fn default() -> Self {
        Self {
            webp_lossless: false,
            avif_speed: AvifSpeed::Faster,
            watermark: None,
        }
    }
}
impl AvifSpeed {
    fn value(self) -> u8 {
        match self {
            Self::Faster => 10,
            Self::Balanced => 8,
            Self::Smaller => 6,
        }
    }
}

pub fn encode_rendered(
    r: &Rendered,
    o: &ExportOptions,
    extra: &ExtraOptions,
    meta: Option<&lightcraft_meta::Metadata>,
) -> Result<Vec<u8>, String> {
    if o.effective_depth() != OutputDepth::U8 {
        if let Some(deep) = &r.deep {
            return encode_deep(deep, o, extra, meta);
        }
    }
    encode_pixels(&r.image, o, extra, meta)
}

pub fn encode_deep(
    deep: &lightcraft_pipeline::DeepImage,
    o: &ExportOptions,
    extra: &ExtraOptions,
    meta: Option<&lightcraft_meta::Metadata>,
) -> Result<Vec<u8>, String> {
    let mut deep = std::borrow::Cow::Borrowed(deep);
    if let Some(mark) = &extra.watermark {
        mark.deep(deep.to_mut());
    }
    if o.format != ExportFormat::Avif {
        return lightcraft_engine::export::encode_deep(&deep, o, meta);
    }
    if o.sharpen != lightcraft_engine::export::SharpenFor::None {
        lightcraft_engine::export::output_sharpen_deep(deep.to_mut(), o.sharpen, o.sharpen_amount);
    }
    let DeepSamples::U16(samples) = &deep.samples else {
        return Err("AVIF needs integer samples.".into());
    };
    let exif = meta.map(lightcraft_meta::write_exif);
    let em = lightcraft_codecs::EncodeMeta {
        exif: exif.as_deref(),
        ..Default::default()
    };
    lightcraft_codecs::encode_avif(
        &lightcraft_codecs::EncodeImage::new(
            deep.width as u32,
            deep.height as u32,
            3,
            lightcraft_codecs::Samples::U16(samples),
        ),
        o.quality,
        extra.avif_speed.value(),
        &em,
    )
    .map_err(|e| e.to_string())
}

pub fn encode_pixels(
    img: &Rgba8,
    o: &ExportOptions,
    extra: &ExtraOptions,
    meta: Option<&lightcraft_meta::Metadata>,
) -> Result<Vec<u8>, String> {
    let mut img = std::borrow::Cow::Borrowed(img);
    if let Some(mark) = &extra.watermark {
        mark.rgba(img.to_mut());
    }
    if !matches!(o.format, ExportFormat::Webp | ExportFormat::Avif)
        || o.format == ExportFormat::Webp && extra.webp_lossless
    {
        return lightcraft_engine::export::encode_with_metadata(&img, o, meta);
    }
    if o.sharpen != lightcraft_engine::export::SharpenFor::None {
        lightcraft_engine::export::output_sharpen(img.to_mut(), o.sharpen, o.sharpen_amount);
    }
    let profile = lightcraft_codecs::icc::write_named(lightcraft_engine::export::named_space(
        o.effective_space(),
    ));
    let exif = meta.map(lightcraft_meta::write_exif);
    let xmp = meta.map(|m| lightcraft_meta::write_xmp(m, None));
    let em = lightcraft_codecs::EncodeMeta {
        icc: Some(&profile),
        exif: exif.as_deref(),
        xmp: xmp.as_deref(),
        ppi: Some(o.ppi),
    };
    if o.format == ExportFormat::Avif {
        return lightcraft_codecs::encode_avif(
            &lightcraft_codecs::EncodeImage::rgba8(&img),
            o.quality,
            extra.avif_speed.value(),
            &em,
        )
        .map_err(|e| e.to_string());
    }
    if img.width > 16383 || img.height > 16383 {
        return Err("WebP supports dimensions up to 16383 pixels.".into());
    }
    let rgba = img.data.as_flattened();
    let encoded = webp::Encoder::from_rgba(rgba, img.width as u32, img.height as u32)
        .encode_simple(false, o.quality as f32)
        .map_err(|e| format!("WebP encoding failed: {e:?}"))?;
    let alpha = img.data.iter().any(|p| p[3] != 255);
    // Add standard extended RIFF chunks while retaining the encoder's image/alpha bitstream.
    let mut body = b"WEBP".to_vec();
    let mut vp8x = vec![
        0x20 | if alpha { 0x10 } else { 0 }
            | if exif.is_some() { 0x08 } else { 0 }
            | if xmp.is_some() { 0x04 } else { 0 },
        0,
        0,
        0,
    ];
    vp8x.extend_from_slice(&((img.width - 1) as u32).to_le_bytes()[..3]);
    vp8x.extend_from_slice(&((img.height - 1) as u32).to_le_bytes()[..3]);
    chunk(&mut body, b"VP8X", &vp8x);
    chunk(&mut body, b"ICCP", &profile);
    let mut pos = 12;
    while pos + 8 <= encoded.len() {
        let size = u32::from_le_bytes(encoded[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let end = pos + 8 + size + (size & 1);
        if end > encoded.len() {
            return Err("Invalid WebP encoder output.".into());
        }
        if &encoded[pos..pos + 4] != b"VP8X" {
            body.extend_from_slice(&encoded[pos..end]);
        }
        pos = end;
    }
    if let Some(exif) = exif {
        chunk(&mut body, b"EXIF", &exif);
    }
    if let Some(xmp) = xmp {
        chunk(&mut body, b"XMP ", xmp.as_bytes());
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend(body);
    Ok(out)
}
fn chunk(out: &mut Vec<u8>, name: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(name);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() & 1 != 0 {
        out.push(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png_mark(
        anchor: &str,
        pixel: [u8; 4],
        options: &ExportOptions,
    ) -> crate::watermark::Watermark {
        let mut src = Rgba8::new(2, 1);
        src.data.fill(pixel);
        let bytes = lightcraft_codecs::encode_png(
            &lightcraft_codecs::EncodeImage::rgba8(&src),
            &Default::default(),
        )
        .unwrap();
        let settings: crate::watermark::Settings = serde_json::from_value(serde_json::json!({
            "enabled": true, "text": "©", "textPng": bytes, "scale": 40, "padding": 10,
            "opacity": 50, "anchor": anchor,
        }))
        .unwrap();
        settings
            .prepare(std::path::Path::new(""), options)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn resized_watermark_respects_every_anchor_and_png_alpha() {
        for (anchor, left, top) in [
            ("topLeft", 1, 1),
            ("topCenter", 8, 1),
            ("topRight", 15, 1),
            ("centerLeft", 1, 4),
            ("center", 8, 4),
            ("centerRight", 15, 4),
            ("bottomLeft", 1, 7),
            ("bottomCenter", 8, 7),
            ("bottomRight", 15, 7),
        ] {
            let mark = png_mark(anchor, [255, 255, 255, 128], &ExportOptions::default());
            let mut image = Rgba8::new(20, 10);
            image.data.fill([0, 0, 0, 255]);
            mark.rgba(&mut image);
            for (i, pixel) in image.data.iter().enumerate() {
                let within =
                    (left..left + 4).contains(&(i % 20)) && (top..top + 2).contains(&(i / 20));
                assert_eq!(
                    *pixel,
                    if within {
                        [64, 64, 64, 255]
                    } else {
                        [0, 0, 0, 255]
                    },
                    "{anchor} at {i}"
                );
            }
        }
    }

    #[test]
    fn translucent_red_png_over_black_keeps_green_and_blue_zero() {
        for (format, depth, red) in [
            (ExportFormat::Png, 8, 64),
            (ExportFormat::Png, 16, 64),
            (ExportFormat::Tiff, 32, 137),
        ] {
            let options = ExportOptions {
                format,
                bit_depth: Some(depth),
                ..Default::default()
            };
            let mark = png_mark("topLeft", [255, 0, 0, 128], &options);
            let mut image = Rgba8::new(20, 10);
            image.data.fill([0, 0, 0, 255]);
            let rendered = Rendered {
                histogram: lightcraft_raster::Histogram::of_srgb8(&image),
                image,
                deep: (depth != 8).then(|| lightcraft_pipeline::DeepImage {
                    width: 20,
                    height: 10,
                    space: options.effective_space(),
                    samples: if depth == 32 {
                        DeepSamples::F32(vec![0.; 600])
                    } else {
                        DeepSamples::U16(vec![0; 600])
                    },
                }),
            };
            let extra = ExtraOptions {
                watermark: Some(mark),
                ..Default::default()
            };
            let bytes = encode_rendered(&rendered, &options, &extra, None).unwrap();
            let pixels = lightcraft_codecs::decode(&bytes, Default::default())
                .unwrap()
                .to_srgb8();
            assert_eq!(pixels.data[21], [red, 0, 0, 255], "{depth}-bit {format:?}");
        }
    }

    #[test]
    fn watermark_blends_at_native_precision_and_preserves_float_headroom() {
        use lightcraft_engine::export::{DeepImage, OutputSpace};
        for float in [false, true] {
            let depth = if float { 32 } else { 16 };
            let options = ExportOptions {
                format: ExportFormat::Tiff,
                bit_depth: Some(depth),
                ..Default::default()
            };
            let mark = png_mark("topLeft", [255; 4], &options);
            let mut image = DeepImage {
                width: 20,
                height: 10,
                space: OutputSpace::Srgb,
                samples: if float {
                    DeepSamples::F32(vec![2.0; 600])
                } else {
                    DeepSamples::U16(vec![1000; 600])
                },
            };
            mark.deep(&mut image);
            let pixel = 3 * 21;
            match image.samples {
                DeepSamples::U16(s) => {
                    assert_eq!(s[0], 1000);
                    assert!((i32::from(s[pixel]) - 33268).abs() <= 1);
                }
                DeepSamples::F32(s) => {
                    assert_eq!(s[0], 2.0);
                    assert!((s[pixel] - 1.5).abs() < 0.0001);
                }
            }
        }
    }

    #[test]
    fn every_export_format_encodes_the_watermark_at_its_supported_depths() {
        use lightcraft_pipeline::DeepImage;
        use ExportFormat::*;
        for format in [Jpeg, Png, Tiff, Jxl, Webp, Avif] {
            for &(depth, _) in ExportOptions::bit_depths(format) {
                let o = ExportOptions {
                    format,
                    bit_depth: Some(depth),
                    quality: 95,
                    ..Default::default()
                };
                let extra = ExtraOptions {
                    watermark: Some(png_mark("topLeft", [255; 4], &o)),
                    ..Default::default()
                };
                let mut image = Rgba8::new(64, 64);
                image.data.fill([0, 0, 0, 255]);
                let deep = (depth != 8).then(|| DeepImage {
                    width: 64,
                    height: 64,
                    space: o.effective_space(),
                    samples: if depth == 32 {
                        DeepSamples::F32(vec![0.; 64 * 64 * 3])
                    } else {
                        DeepSamples::U16(vec![0; 64 * 64 * 3])
                    },
                });
                let r = Rendered {
                    histogram: lightcraft_raster::Histogram::of_srgb8(&image),
                    image,
                    deep,
                };
                let bytes = encode_rendered(&r, &o, &extra, None).unwrap();
                if format == Avif {
                    // AVIF is encode-only in Lightcraft.
                    assert_eq!(&bytes[4..12], b"ftypavif");
                    assert_ne!(
                        bytes,
                        encode_rendered(&r, &o, &ExtraOptions::default(), None).unwrap()
                    );
                    continue;
                }
                let decoded = lightcraft_codecs::decode(&bytes, Default::default())
                    .unwrap()
                    .to_srgb8();
                assert!(
                    decoded.data[12 * 64 + 15][0] > 100,
                    "{format:?} {depth}-bit watermark"
                );
                assert!(
                    decoded.data[40 * 64 + 40][0] < 25,
                    "{format:?} {depth}-bit background"
                );
            }
        }
    }

    #[test]
    fn image_presets_require_a_picked_png_before_preview_and_export() {
        use std::{
            fs,
            time::{SystemTime, UNIX_EPOCH},
        };
        let dir = std::env::temp_dir().join(format!(
            "photocull-mark-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let file = dir.join("logo.png");
        let mut image = Rgba8::new(2, 1);
        image.data.fill([255; 4]);
        let bytes = lightcraft_codecs::encode_png(
            &lightcraft_codecs::EncodeImage::rgba8(&image),
            &Default::default(),
        )
        .unwrap();
        fs::write(&file, bytes).unwrap();
        let file = dunce::canonicalize(file).unwrap();
        let settings = || {
            serde_json::from_value::<crate::watermark::Settings>(serde_json::json!({
                "enabled": true, "type":"image", "imagePath":file
            }))
            .unwrap()
        };
        assert!(settings().prepare(&dir, &Default::default()).is_err());
        assert!(crate::watermark::preview(&dir, file.to_str().unwrap()).is_err());
        let path = crate::watermark::approve(&dir, &file).unwrap();
        assert!(settings()
            .prepare(&dir, &Default::default())
            .unwrap()
            .is_some());
        assert!(crate::watermark::preview(&dir, &path)
            .unwrap()
            .starts_with(b"\x89PNG"));
        fs::write(&file, b"invalid").unwrap();
        assert!(settings().prepare(&dir, &Default::default()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn watermark_rejects_malformed_rasters_and_renders_headless_text() {
        let options = ExportOptions::default();
        for png in [vec![1, 2, 3], {
            let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
            header.extend_from_slice(&[255; 17]);
            header
        }] {
            let settings: crate::watermark::Settings = serde_json::from_value(serde_json::json!({
                "enabled":true, "text":"test", "textPng":png
            }))
            .unwrap();
            assert!(settings
                .prepare(std::path::Path::new(""), &options)
                .is_err());
        }
        let settings: crate::watermark::Settings = serde_json::from_value(serde_json::json!({
            "enabled":true, "text":"© Studio", "scale":50
        }))
        .unwrap();
        let mut image = Rgba8::new(200, 100);
        settings
            .prepare(std::path::Path::new(""), &options)
            .unwrap()
            .unwrap()
            .rgba(&mut image);
        assert!(image.data.iter().any(|p| p[3] > 0 && p[0] == 255));
    }

    #[test]
    fn lossy_webp_quality_profile_metadata_and_readback() {
        let mut img = Rgba8::new(128, 96);
        for (i, p) in img.data.iter_mut().enumerate() {
            *p = [
                ((i % 128) * 255 / 127) as u8,
                ((i / 128) * 255 / 95) as u8,
                (((i % 128) + (i / 128)) * 255 / 222) as u8,
                255,
            ];
        }
        let o = ExportOptions {
            format: ExportFormat::Webp,
            quality: 80,
            ..Default::default()
        };
        let meta = lightcraft_meta::Metadata {
            artist: Some("PhotoCull test".into()),
            ..Default::default()
        };
        let bytes = encode_pixels(&img, &o, &ExtraOptions::default(), Some(&meta)).unwrap();
        assert!(bytes.windows(4).any(|s| s == b"VP8 "));
        let d = lightcraft_codecs::decode(&bytes, Default::default()).unwrap();
        assert_eq!((d.width, d.height), (128, 96));
        assert!(d.icc.is_some());
        assert_eq!(
            lightcraft_meta::extract(&bytes).artist.as_deref(),
            Some("PhotoCull test")
        );
        let back = d.to_srgb8();
        let error: f64 = img
            .data
            .iter()
            .zip(back.data.iter())
            .flat_map(|(a, b)| (0..3).map(move |i| (a[i] as f64 - b[i] as f64).abs()))
            .sum::<f64>()
            / (128.0 * 96.0 * 3.0);
        assert!(error < 5.0, "mean channel error {error}");
        let low = encode_pixels(
            &img,
            &ExportOptions {
                quality: 10,
                ..o.clone()
            },
            &ExtraOptions::default(),
            None,
        )
        .unwrap();
        assert!(low.len() < bytes.len());
        let lossless = encode_pixels(
            &img,
            &o,
            &ExtraOptions {
                webp_lossless: true,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(
            lightcraft_codecs::decode(&lossless, Default::default())
                .unwrap()
                .to_srgb8()
                .data,
            img.data
        );
    }
}

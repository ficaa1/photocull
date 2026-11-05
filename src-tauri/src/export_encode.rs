//! Export codec options missing from the pinned Lightcraft export layer.
use lightcraft_engine::export::{ExportFormat, ExportOptions, OutputDepth};
use lightcraft_pipeline::{DeepSamples, Rendered};
use lightcraft_raster::Rgba8;
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AvifSpeed { Faster, Balanced, Smaller }
#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtraOptions { pub webp_lossless: bool, pub avif_speed: AvifSpeed }
impl Default for ExtraOptions {
    fn default() -> Self { Self { webp_lossless: false, avif_speed: AvifSpeed::Faster } }
}
impl AvifSpeed {
    fn value(self) -> u8 { match self { Self::Faster => 10, Self::Balanced => 8, Self::Smaller => 6 } }
}

pub fn encode_rendered(r: &Rendered, o: &ExportOptions, extra: &ExtraOptions, meta: Option<&lightcraft_meta::Metadata>) -> Result<Vec<u8>, String> {
    if o.format == ExportFormat::Avif && o.effective_depth() != OutputDepth::U8 {
        if let Some(deep) = &r.deep { return encode_deep_avif(deep, o, extra, meta); }
    }
    if matches!(o.format, ExportFormat::Webp | ExportFormat::Avif) { return encode_pixels(&r.image, o, extra, meta); }
    lightcraft_engine::export::encode_rendered(r, o, meta)
}

pub fn encode_deep_avif(deep: &lightcraft_pipeline::DeepImage, o: &ExportOptions, extra: &ExtraOptions, meta: Option<&lightcraft_meta::Metadata>) -> Result<Vec<u8>, String> {
    let mut deep = deep.clone();
    lightcraft_engine::export::output_sharpen_deep(&mut deep, o.sharpen, o.sharpen_amount);
    let DeepSamples::U16(samples) = &deep.samples else { return Err("AVIF needs integer samples.".into()); };
    let exif = meta.map(lightcraft_meta::write_exif);
    let em = lightcraft_codecs::EncodeMeta { exif: exif.as_deref(), ..Default::default() };
    lightcraft_codecs::encode_avif(&lightcraft_codecs::EncodeImage::new(deep.width as u32, deep.height as u32, 3, lightcraft_codecs::Samples::U16(samples)), o.quality, extra.avif_speed.value(), &em).map_err(|e| e.to_string())
}

pub fn encode_pixels(img: &Rgba8, o: &ExportOptions, extra: &ExtraOptions, meta: Option<&lightcraft_meta::Metadata>) -> Result<Vec<u8>, String> {
    if !matches!(o.format, ExportFormat::Webp | ExportFormat::Avif) || o.format == ExportFormat::Webp && extra.webp_lossless {
        return lightcraft_engine::export::encode_with_metadata(img, o, meta);
    }
    let mut img = img.clone();
    lightcraft_engine::export::output_sharpen(&mut img, o.sharpen, o.sharpen_amount);
    let profile = lightcraft_codecs::icc::write_named(lightcraft_engine::export::named_space(o.effective_space()));
    let exif = meta.map(lightcraft_meta::write_exif);
    let xmp = meta.map(|m| lightcraft_meta::write_xmp(m, None));
    let em = lightcraft_codecs::EncodeMeta { icc: Some(&profile), exif: exif.as_deref(), xmp: xmp.as_deref(), ppi: Some(o.ppi) };
    if o.format == ExportFormat::Avif {
        return lightcraft_codecs::encode_avif(&lightcraft_codecs::EncodeImage::rgba8(&img), o.quality, extra.avif_speed.value(), &em).map_err(|e| e.to_string());
    }
    if img.width > 16383 || img.height > 16383 { return Err("WebP supports dimensions up to 16383 pixels.".into()); }
    let rgba: Vec<u8> = img.data.iter().flatten().copied().collect();
    let encoded = webp::Encoder::from_rgba(&rgba, img.width as u32, img.height as u32).encode(o.quality as f32);
    let alpha = img.data.iter().any(|p| p[3] != 255);
    // Add standard extended RIFF chunks while retaining the encoder's image/alpha bitstream.
    let mut body = b"WEBP".to_vec();
    let mut vp8x = vec![0x20 | if alpha { 0x10 } else { 0 } | if exif.is_some() { 0x08 } else { 0 } | if xmp.is_some() { 0x04 } else { 0 }, 0, 0, 0];
    vp8x.extend_from_slice(&((img.width - 1) as u32).to_le_bytes()[..3]);
    vp8x.extend_from_slice(&((img.height - 1) as u32).to_le_bytes()[..3]);
    chunk(&mut body, b"VP8X", &vp8x); chunk(&mut body, b"ICCP", &profile);
    let mut pos = 12;
    while pos + 8 <= encoded.len() {
        let size = u32::from_le_bytes(encoded[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let end = pos + 8 + size + (size & 1);
        if end > encoded.len() { return Err("Invalid WebP encoder output.".into()); }
        if &encoded[pos..pos + 4] != b"VP8X" { body.extend_from_slice(&encoded[pos..end]); }
        pos = end;
    }
    if let Some(exif) = exif { chunk(&mut body, b"EXIF", &exif); }
    if let Some(xmp) = xmp { chunk(&mut body, b"XMP ", xmp.as_bytes()); }
    let mut out = b"RIFF".to_vec(); out.extend_from_slice(&(body.len() as u32).to_le_bytes()); out.extend(body); Ok(out)
}
fn chunk(out: &mut Vec<u8>, name: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(name); out.extend_from_slice(&(data.len() as u32).to_le_bytes()); out.extend_from_slice(data);
    if data.len() & 1 != 0 { out.push(0); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lossy_webp_quality_profile_metadata_and_readback() {
        let mut img = Rgba8::new(128, 96);
        for (i, p) in img.data.iter_mut().enumerate() { *p = [(i % 251) as u8, (i / 17 % 251) as u8, (i / 37 % 251) as u8, 255]; }
        let o = ExportOptions { format: ExportFormat::Webp, quality: 80, ..Default::default() };
        let meta = lightcraft_meta::Metadata { artist: Some("PhotoCull test".into()), ..Default::default() };
        let bytes = encode_pixels(&img, &o, &ExtraOptions::default(), Some(&meta)).unwrap();
        assert!(bytes.windows(4).any(|s| s == b"VP8 "));
        let d = lightcraft_codecs::decode(&bytes, Default::default()).unwrap();
        assert_eq!((d.width, d.height), (128, 96)); assert!(d.icc.is_some());
        assert_eq!(lightcraft_meta::extract(&bytes).artist.as_deref(), Some("PhotoCull test"));
        let back = d.to_srgb8();
        let error: f64 = img.data.iter().zip(back.data.iter()).flat_map(|(a,b)| (0..3).map(move |i| (a[i] as f64 - b[i] as f64).abs())).sum::<f64>() / (128.0 * 96.0 * 3.0);
        assert!(error < 20.0, "mean channel error {error}");
        let low = encode_pixels(&img, &ExportOptions {quality: 10, ..o.clone()}, &ExtraOptions::default(), None).unwrap();
        assert!(low.len() < bytes.len());
        let lossless = encode_pixels(&img, &o, &ExtraOptions {webp_lossless: true, ..Default::default()}, None).unwrap();
        assert_eq!(lightcraft_codecs::decode(&lossless, Default::default()).unwrap().to_srgb8().data, img.data);
    }
}

use lightcraft_engine::export::{ExportOptions, OutputDepth};
use lightcraft_pipeline::{DeepImage, DeepSamples};
use lightcraft_raster::{Image, Rgba8};
use serde::Deserialize;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_PIXELS: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Anchor {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    #[default]
    BottomRight,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    #[default]
    Text,
    Image,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    enabled: bool,
    #[serde(rename = "type")]
    kind: Kind,
    text: String,
    image_path: String,
    text_png: Option<Vec<u8>>,
    anchor: Anchor,
    opacity: u8,
    scale: u8,
    padding: u8,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            kind: Kind::Text,
            text: String::new(),
            image_path: String::new(),
            text_png: None,
            anchor: Anchor::BottomRight,
            opacity: 65,
            scale: 12,
            padding: 4,
        }
    }
}

fn decode(
    bytes: &[u8],
    max_size: Option<(u32, u32)>,
) -> Result<lightcraft_codecs::Decoded, String> {
    if bytes.len() > MAX_BYTES
        || bytes.len() < 33
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
    {
        return Err("Choose a PNG watermark up to 8 MiB.".into());
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if w == 0 || h == 0 || w.max(h) > 8192 || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("Watermark exceeds the 4 megapixel or 8192 pixel edge limit.".into());
    }
    lightcraft_codecs::decode(
        bytes,
        lightcraft_codecs::DecodeOptions {
            max_size,
            max_pixels: MAX_PIXELS,
        },
    )
    .map_err(|e| e.to_string())
}

fn grant_path(dir: &Path, path: &str) -> PathBuf {
    let mut hash = DefaultHasher::new();
    path.hash(&mut hash);
    dir.join("watermark-grants")
        .join(format!("{:016x}", hash.finish()))
}

fn png_file(path: &Path) -> Result<Vec<u8>, String> {
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("png"))
        || !fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES as u64)
    {
        return Err("Choose a regular PNG file up to 8 MiB.".into());
    }
    let mut data = Vec::new();
    fs::File::open(path)
        .and_then(|f| f.take(MAX_BYTES as u64 + 1).read_to_end(&mut data))
        .map_err(|e| e.to_string())?;
    Ok(data)
}

pub fn approve(dir: &Path, file: &Path) -> Result<String, String> {
    let file = dunce::canonicalize(file).map_err(|e| e.to_string())?;
    let path = file.to_str().ok_or("Unsupported PNG path.")?;
    decode(&png_file(&file)?, Some((256, 256)))?;
    let grant = grant_path(dir, path);
    fs::create_dir_all(grant.parent().unwrap()).map_err(|e| e.to_string())?;
    match fs::File::create_new(&grant) {
        Ok(mut file) => file.write_all(path.as_bytes()).map_err(|e| e.to_string())?,
        Err(e)
            if e.kind() == std::io::ErrorKind::AlreadyExists
                && fs::read_to_string(&grant).ok().as_deref() == Some(path) =>
        {
            ()
        }
        Err(e) => return Err(format!("Could not save watermark selection: {e}")),
    }
    Ok(path.into())
}

fn approved_bytes(dir: &Path, path: &str) -> Result<Vec<u8>, String> {
    if fs::read_to_string(grant_path(dir, path)).ok().as_deref() != Some(path) {
        return Err("Choose the watermark PNG with the file picker.".into());
    }
    let resolved = dunce::canonicalize(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            "The selected watermark PNG is missing. Choose it again.".to_owned()
        }
        _ => format!("Could not open the selected watermark PNG: {error}"),
    })?;
    if resolved != Path::new(path) {
        return Err("Choose the watermark PNG with the file picker.".into());
    }
    png_file(Path::new(path))
}

pub fn preview(dir: &Path, path: &str) -> Result<Vec<u8>, String> {
    let image = decode(&approved_bytes(dir, path)?, Some((512, 512)))?.to_srgb8();
    lightcraft_codecs::encode_png(
        &lightcraft_codecs::EncodeImage::rgba8(&image),
        &Default::default(),
    )
    .map_err(|e| e.to_string())
}

#[derive(Clone)]
pub struct Watermark {
    pixels: Image<[f32; 4]>,
    anchor: Anchor,
    opacity: f32,
    scale: f32,
    padding: f32,
}

impl Settings {
    pub fn image_source(&self) -> Option<&Path> {
        (self.enabled && matches!(self.kind, Kind::Image)).then(|| Path::new(&self.image_path))
    }

    pub fn prepare(self, dir: &Path, options: &ExportOptions) -> Result<Option<Watermark>, String> {
        if !self.enabled {
            return Ok(None);
        }
        if !(5..=100).contains(&self.opacity)
            || !(2..=50).contains(&self.scale)
            || self.padding > 20
            || self.text.chars().count() > 200
        {
            return Err("Invalid watermark settings.".into());
        }
        let bytes = match self.kind {
            Kind::Image => Some(approved_bytes(dir, &self.image_path)?),
            Kind::Text if self.text.trim().is_empty() => return Err("Enter watermark text.".into()),
            Kind::Text => self.text_png,
        };
        let pixels = if let Some(bytes) = bytes {
            let decoded = decode(&bytes, None)?;
            let space = options.effective_space();
            let matrix = decoded.space.to_space(&space.rgb_space()).to_f32();
            let linear = matches!(
                options.effective_depth(),
                OutputDepth::F32Linear | OutputDepth::F32Hdr
            );
            let rgb = decoded.image;
            let mut pixels = Image::<[f32; 4]>::new(rgb.width, rgb.height);
            for (i, (out, p)) in pixels.data.iter_mut().zip(rgb.data).enumerate() {
                let alpha = decoded
                    .alpha
                    .as_ref()
                    .map_or(1.0, |a| a.data[i].clamp(0.0, 1.0));
                for c in 0..3 {
                    let v = matrix[c][0] * p[0] + matrix[c][1] * p[1] + matrix[c][2] * p[2];
                    out[c] = alpha
                        * if linear {
                            v.max(0.0)
                        } else {
                            space.trc().encode(v)
                        };
                }
                out[3] = alpha;
            }
            pixels
        } else {
            bitmap_text(&self.text)
        };
        Ok(Some(Watermark {
            pixels,
            anchor: self.anchor,
            opacity: self.opacity as f32 / 100.0,
            scale: self.scale as f32 / 100.0,
            padding: self.padding as f32 / 100.0,
        }))
    }
}

// The renderer supplies Unicode glyphs. Headless callers can use this compact lettering.
fn bitmap_text(text: &str) -> Image<[f32; 4]> {
    let mut image = Image::new(text.chars().count() * 6 - 1, 7);
    for (i, c) in text.chars().enumerate() {
        let rows = match c.to_ascii_uppercase() {
            'A' => [14, 17, 17, 31, 17, 17, 17],
            'B' => [30, 17, 17, 30, 17, 17, 30],
            'C' => [14, 17, 16, 16, 16, 17, 14],
            'D' => [30, 17, 17, 17, 17, 17, 30],
            'E' => [31, 16, 16, 30, 16, 16, 31],
            'F' => [31, 16, 16, 30, 16, 16, 16],
            'G' => [14, 17, 16, 23, 17, 17, 14],
            'H' => [17, 17, 17, 31, 17, 17, 17],
            'I' => [14, 4, 4, 4, 4, 4, 14],
            'J' => [7, 2, 2, 2, 2, 18, 12],
            'K' => [17, 18, 20, 24, 20, 18, 17],
            'L' => [16, 16, 16, 16, 16, 16, 31],
            'M' => [17, 27, 21, 21, 17, 17, 17],
            'N' => [17, 25, 25, 21, 19, 19, 17],
            'O' => [14, 17, 17, 17, 17, 17, 14],
            'P' => [30, 17, 17, 30, 16, 16, 16],
            'Q' => [14, 17, 17, 17, 21, 18, 13],
            'R' => [30, 17, 17, 30, 20, 18, 17],
            'S' => [15, 16, 16, 14, 1, 1, 30],
            'T' => [31, 4, 4, 4, 4, 4, 4],
            'U' => [17, 17, 17, 17, 17, 17, 14],
            'V' => [17, 17, 17, 17, 17, 10, 4],
            'W' => [17, 17, 17, 21, 21, 27, 17],
            'X' => [17, 17, 10, 4, 10, 17, 17],
            'Y' => [17, 17, 10, 4, 4, 4, 4],
            'Z' => [31, 1, 2, 4, 8, 16, 31],
            '0' => [14, 17, 19, 21, 25, 17, 14],
            '1' => [4, 12, 4, 4, 4, 4, 14],
            '2' => [14, 17, 1, 2, 4, 8, 31],
            '3' => [30, 1, 1, 14, 1, 1, 30],
            '4' => [2, 6, 10, 18, 31, 2, 2],
            '5' => [31, 16, 16, 30, 1, 1, 30],
            '6' => [14, 16, 16, 30, 17, 17, 14],
            '7' => [31, 1, 2, 4, 8, 8, 8],
            '8' => [14, 17, 17, 14, 17, 17, 14],
            '9' => [14, 17, 17, 15, 1, 1, 14],
            '©' => [14, 17, 23, 21, 23, 17, 14],
            ' ' => [0; 7],
            '.' => [0, 0, 0, 0, 0, 0, 4],
            '-' => [0, 0, 0, 14, 0, 0, 0],
            _ => [14, 17, 1, 2, 4, 0, 4],
        };
        for (y, row) in rows.iter().enumerate() {
            for x in 0..5 {
                if row & (16 >> x) != 0 {
                    image.data[y * image.width + i * 6 + x] = [1.0; 4];
                }
            }
        }
    }
    image
}

impl Watermark {
    fn blend(&self, width: usize, height: usize, mut apply: impl FnMut(usize, [f32; 4])) {
        if width == 0 || height == 0 {
            return;
        }
        let edge = width.min(height) as f32;
        let pad = (self.padding * edge).round() as usize;
        let src = &self.pixels;
        let factor = (self.scale * edge / src.width as f32)
            .min((height - 2 * pad) as f32 / src.height as f32);
        let w = (factor * src.width as f32).round().max(1.) as usize;
        let h = (factor * src.height as f32).round().max(1.) as usize;
        use Anchor::*;
        let left = match self.anchor {
            TopLeft | CenterLeft | BottomLeft => pad,
            TopRight | CenterRight | BottomRight => width - w - pad,
            _ => (width - w) / 2,
        };
        let top = match self.anchor {
            TopLeft | TopCenter | TopRight => pad,
            BottomLeft | BottomCenter | BottomRight => height - h - pad,
            _ => (height - h) / 2,
        };
        let scaled = lightcraft_raster::resample::resize(
            src,
            w,
            h,
            lightcraft_raster::resample::Filter::Bilinear,
        );
        for (y, row) in scaled.data.chunks_exact(w).enumerate() {
            for (x, pixel) in row.iter().enumerate() {
                if pixel[3] > 0.0 {
                    apply(
                        (top + y) * width + left + x,
                        pixel.map(|v| v * self.opacity),
                    );
                }
            }
        }
    }

    pub fn rgba(&self, image: &mut Rgba8) {
        self.blend(image.width, image.height, |i, p| {
            let dst = &mut image.data[i];
            let keep = (1. - p[3]) * (dst[3] as f32 / 255.);
            let alpha = p[3] + keep;
            for c in 0..3 {
                dst[c] = ((255. * p[c] + dst[c] as f32 * keep) / alpha).round() as u8;
            }
            dst[3] = (255. * alpha).round() as u8;
        });
    }

    pub fn deep(&self, image: &mut DeepImage) {
        self.blend(image.width, image.height, |i, p| match &mut image.samples {
            DeepSamples::U16(data) => {
                for (d, v) in data[3 * i..3 * i + 3].iter_mut().zip(p) {
                    *d = (65535. * v + *d as f32 * (1. - p[3])).round() as u16;
                }
            }
            DeepSamples::F32(data) => {
                for (d, v) in data[3 * i..3 * i + 3].iter_mut().zip(p) {
                    *d = v + *d * (1. - p[3]);
                }
            }
        });
    }
}

//! Experimental pixel worker, never packaged or used by the app.
//! One JSON line in/out: {file, output, edge, quality, orientation?}.
use lightcraft_codecs::{DecodeOptions, EncodeImage, EncodeMeta};
use serde::Deserialize;
use serde_json::json;
use std::io::{BufRead, Write};

#[derive(Deserialize)]
struct Request {
    file: String,
    output: String,
    edge: u32,
    quality: u8,
    orientation: Option<u16>,
}

fn process(r: Request, icc: &[u8]) -> Result<serde_json::Value, String> {
    let start = std::time::Instant::now();
    let bytes = std::fs::read(&r.file).map_err(|e| e.to_string())?;
    let header = lightcraft_codecs::read_header(&bytes).map_err(|e| e.to_string())?;
    if u64::from(header.width) * u64::from(header.height) > 160_000_000 {
        return Err("Image exceeds the 160 megapixel limit.".into());
    }
    let (image, orientation) =
        match lightcraft_codecs::decode_jpeg_srgb8_fit(&bytes, r.edge, r.edge)
            .map_err(|e| e.to_string())?
        {
            Some(image) => image,
            None => {
                let d = lightcraft_codecs::decode(
                    &bytes,
                    DecodeOptions {
                        max_size: Some((r.edge, r.edge)),
                        max_pixels: 160_000_000,
                    },
                )
                .map_err(|e| e.to_string())?;
                (d.to_srgb8(), d.orientation)
            }
        };
    let image = image.into_oriented(lightcraft_geom::Orientation::from_exif(
        r.orientation.unwrap_or(orientation),
    ));
    let bytes = lightcraft_codecs::encode_jpeg(
        &EncodeImage::rgba8(&image),
        r.quality,
        lightcraft_codecs::ChromaSubsampling::S420,
        &EncodeMeta {
            icc: Some(icc),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(r.output, &bytes).map_err(|e| e.to_string())?;
    Ok(
        json!({"width":image.width,"height":image.height,"bytes":bytes.len(),"ms":start.elapsed().as_secs_f64()*1000.0}),
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let icc = lightcraft_codecs::icc::write_named(lightcraft_codecs::NamedSpace::Srgb);
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let result = serde_json::from_str::<Request>(&line?)
            .map_err(|e| e.to_string())
            .and_then(|r| process(r, &icc));
        let value = match result {
            Ok(value) => value,
            Err(error) => json!({"error":error}),
        };
        writeln!(stdout, "{value}")?;
        stdout.flush()?;
    }
    Ok(())
}

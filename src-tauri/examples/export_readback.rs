//! Read exported files with the same native codecs and write small sRGB JPEGs for visual inspection.
//! cargo run --example export_readback -- <export-folder> <preview-folder>
use std::path::PathBuf;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().expect("export folder"));
    let previews = PathBuf::from(args.next().expect("preview folder"));
    std::fs::create_dir_all(&previews)?;
    let mut files: Vec<_> = std::fs::read_dir(input)?.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_file()).collect();
    files.sort();
    for file in files {
        let bytes = std::fs::read(&file)?;
        let mut d = match lightcraft_codecs::decode(&bytes, Default::default()) {
            Ok(d) => d,
            Err(error) => {
                // AVIF encoding is supported, but Lightcraft has no permissively licensed AV1 decoder.
                // The Windows verifier uses sharp/libheif to read these outputs separately.
                println!("{}", serde_json::json!({ "file": file.file_name().unwrap().to_string_lossy(), "decoderError": error.to_string() }));
                continue;
            }
        };
        let meta = lightcraft_meta::extract(&bytes);
        println!("{}", serde_json::json!({
            "file": file.file_name().unwrap().to_string_lossy(), "width": d.width, "height": d.height,
            "bitDepth": d.bit_depth, "float": d.float, "iccBytes": d.icc.as_ref().map_or(0, Vec::len),
            "orientation": d.orientation, "space": format!("{:?}", d.space),
            "camera": meta.model, "lens": meta.lens_model, "artist": meta.artist, "copyright": meta.copyright,
            "title": meta.title, "caption": meta.caption, "keywords": meta.keywords,
        }));
        d.image = lightcraft_raster::resample::fit(&d.image, 400, 300, lightcraft_raster::resample::Filter::Lanczos3);
        // DecodeOptions do not apply EXIF orientation; apply it after sampling for the contact sheet.
        let img = d.to_srgb8().into_oriented(lightcraft_geom::Orientation::from_exif(d.orientation));
        let encoded = lightcraft_codecs::encode_jpeg(&lightcraft_codecs::EncodeImage::rgba8(&img), 90,
            lightcraft_codecs::ChromaSubsampling::S444, &Default::default())?;
        std::fs::write(previews.join(format!("{}.jpg", file.file_name().unwrap().to_string_lossy())), encoded)?;
    }
    Ok(())
}

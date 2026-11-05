//! Full-resolution export timings and recipe luminance using copied RAWs only.
//! cargo run --example recipes_export_bench -- <temporary-fixture-directory> <report-directory>
use lightcraft_engine::export::{ExportFormat, ExportOptions};
use lightcraft_pipeline::{OutputSpace, RenderRequest};
use photocull_lib::export_encode::{self, ExtraOptions};
use serde_json::json;
use std::{path::PathBuf, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().expect("copied RAW directory"));
    let out = PathBuf::from(args.next().expect("report directory")); std::fs::create_dir_all(&out)?;
    let mut files: Vec<_> = std::fs::read_dir(input)?.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|s| s.eq_ignore_ascii_case("arw"))).collect(); files.sort(); files.truncate(3);
    assert_eq!(files.len(), 3);
    let mut measurements = Vec::new();
    for file in &files {
        let bytes = std::fs::read(file)?;
        let (src, mut info) = lightcraft_engine::files::load_bytes(&bytes, usize::MAX)?;
        let raw = lightcraft_raw::probe_info(&bytes)?;
        info.lens = lightcraft_engine::files::embedded_lens(&raw);
        let native = raw.developed_size(); info.native_long = Some(native.0.max(native.1));
        let mut base = lightcraft_develop::DevelopSettings::for_raw(info.as_shot_temp, info.as_shot_tint);
        base.detail.sharpen_amount = 0.0; base.detail.nr_color = 0.0; base.detail.nr_luminance = 0.0; base.detail.nr_outliers = false; base.optics.lens_profile = true;
        // The same full-size source, settings and render request as the shell export path.
        for (label, profile, exposure, contrast, highlights, blacks) in [
            ("neutral", "lc.neutral", 0.0, 0.0, 0.0, 0.0),
            ("old-flat", "lc.color", -1.0, -40.0, 0.0, 60.0),
            ("flat", "lc.color", 0.0, -25.0, -30.0, 25.0),
        ] {
            let mut s = base.clone(); s.profile.id = profile.into(); s.light.exposure = exposure; s.light.contrast = contrast; s.light.highlights = highlights; s.light.blacks = blacks;
            let size = lightcraft_pipeline::native_output_size(src.width, src.height, &s);
            let r = lightcraft_pipeline::render(&src, &info, &s, &RenderRequest::fit(size.0.round() as usize, size.1.round() as usize));
            let mut luma: Vec<_> = r.image.data.iter().map(|p| (0.2126*p[0] as f64 + 0.7152*p[1] as f64 + 0.0722*p[2] as f64) / 255.0).collect();
            luma.sort_by(f64::total_cmp);
            let clip = r.image.data.iter().filter(|p| p[..3].iter().any(|v| *v == 255)).count() as f64 / luma.len() as f64 * 100.0;
            let row = json!({"file":file.file_name().unwrap().to_string_lossy(),"recipe":label,"median":luma[luma.len()/2],"p05":luma[luma.len()/20],"p95":luma[luma.len()*19/20],"clippedPercent":clip});
            println!("{row}"); measurements.push(row);
        }
    }
    std::fs::write(out.join("recipes.json"), serde_json::to_vec_pretty(&measurements)?)?;
    let mut timings = Vec::new();
    for format in [ExportFormat::Jpeg, ExportFormat::Jxl, ExportFormat::Avif, ExportFormat::Webp] {
        for after in [false, true] {
            let start = Instant::now();
            let encode = |file: &PathBuf| -> Result<u128, String> {
                let start = Instant::now();
                let bytes = std::fs::read(file).map_err(|e|e.to_string())?;
                let (src, mut info) = lightcraft_engine::files::load_bytes(&bytes, usize::MAX)?;
                let raw = lightcraft_raw::probe_info(&bytes).map_err(|e|e.to_string())?;
                info.lens = lightcraft_engine::files::embedded_lens(&raw);
                let native = raw.developed_size(); info.native_long = Some(native.0.max(native.1));
                let mut s = lightcraft_develop::DevelopSettings::for_raw(info.as_shot_temp,info.as_shot_tint);
                s.profile.id = "lc.neutral".into(); s.detail.sharpen_amount=0.0; s.detail.nr_color=0.0; s.detail.nr_luminance=0.0; s.detail.nr_outliers=false; s.optics.lens_profile=true;
                let o = ExportOptions {format,quality:90,color_space:OutputSpace::Srgb,..Default::default()};
                let size = lightcraft_pipeline::native_output_size(src.width,src.height,&s);
                let r = lightcraft_pipeline::render(&src,&info,&s,&RenderRequest::fit(size.0.round() as usize,size.1.round() as usize));
                // Lossless WebP in both batches isolates concurrency; also time the new lossy encoder below.
                let extra = ExtraOptions {webp_lossless:true,..Default::default()};
                let bytes = if after {export_encode::encode_rendered(&r,&o,&extra,None)?} else {lightcraft_engine::export::encode_rendered(&r,&o,None)?};
                std::fs::write(out.join(format!("{}-{}-{}.{}",file.file_stem().unwrap().to_string_lossy(), if after {"after"} else {"before"},"full",format.extension())),bytes).map_err(|e|e.to_string())?;
                if after && format == ExportFormat::Webp {
                    let t=Instant::now(); let b=export_encode::encode_rendered(&r,&o,&ExtraOptions::default(),None)?;
                    println!("{}",json!({"file":file.file_name().unwrap().to_string_lossy(),"lossyWebpEncodeMs":t.elapsed().as_millis(),"bytes":b.len()}));
                    std::fs::write(out.join(format!("{}-lossy.webp",file.file_stem().unwrap().to_string_lossy())),b).map_err(|e|e.to_string())?;
                }
                Ok(start.elapsed().as_millis())
            };
            let per_file: Vec<_> = if after {
                // Same half-core, maximum-three policy as export_photos.
                let workers=(std::thread::available_parallelism().map_or(2,usize::from)/2).clamp(1,3);
                let mut rows=Vec::new();
                for chunk in files.chunks(workers) {
                    let mut batch=std::thread::scope(|scope| chunk.iter().map(|f|scope.spawn(||encode(f))).collect::<Vec<_>>().into_iter().map(|h|h.join().unwrap()).collect::<Vec<_>>());
                    rows.append(&mut batch);
                }
                rows.into_iter().collect::<Result<Vec<_>,_>>()?
            } else {files.iter().map(encode).collect::<Result<Vec<_>,_>>()?};
            let row=json!({"format":format,"after":after,"batchMs":start.elapsed().as_millis(),"perFileMs":per_file}); println!("{row}");timings.push(row);
            std::fs::write(out.join("timings.json"),serde_json::to_vec_pretty(&timings)?)?;
        }
    }
    Ok(())
}

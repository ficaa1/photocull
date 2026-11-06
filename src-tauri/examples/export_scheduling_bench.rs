//! Compare uniform scheduling with rejected per-format candidates using identical encoders.
//! cargo run --example export_scheduling_bench -- <three-copied-RAW-dir> <report-dir> [workers] [format]
use lightcraft_engine::export::{ExportFormat, ExportOptions};
use lightcraft_pipeline::{OutputSpace, RenderRequest};
use photocull_lib::export_encode::{self, ExtraOptions};
use serde_json::json;
use std::{path::PathBuf, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().expect("copied RAW directory"));
    let out = PathBuf::from(args.next().expect("report directory"));
    std::fs::create_dir_all(&out)?;
    let override_workers = args.next().map(|s| {
        s.parse::<usize>()
            .expect("positive worker count")
            .clamp(1, 3)
    });
    let only_format = args.next();
    let mut files: Vec<_> = std::fs::read_dir(input)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|s| s.eq_ignore_ascii_case("arw")))
        .collect();
    files.sort();
    files.truncate(3);
    assert_eq!(files.len(), 3);
    let cores = std::thread::available_parallelism().map_or(2, usize::from);
    let mut rows = Vec::new();
    for format in [
        ExportFormat::Jpeg,
        ExportFormat::Png,
        ExportFormat::Tiff,
        ExportFormat::Webp,
        ExportFormat::Jxl,
        ExportFormat::Avif,
    ] {
        if only_format.as_ref().is_some_and(|names| {
            !names
                .split(',')
                .any(|name| name == serde_json::to_value(format).unwrap().as_str().unwrap())
        }) {
            continue;
        }
        // Alternate order on the second repeat to reduce warm-up/order bias.
        for repeat in 0..2 {
            for mode in if repeat == 0 {
                ["before", "after"]
            } else {
                ["after", "before"]
            } {
                let workers = if mode == "before" {
                    (cores / 2).clamp(1, 3)
                } else {
                    override_workers.unwrap_or_else(|| {
                        if matches!(format, ExportFormat::Avif | ExportFormat::Jxl) { (cores / 2).clamp(1, 3) } else { 1 }
                    })
                };
                let start = Instant::now();
                let encode = |file: &PathBuf| -> Result<serde_json::Value, String> {
                    let start = Instant::now();
                    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
                    let (src, mut info) = lightcraft_engine::files::load_bytes(&bytes, usize::MAX)?;
                    let raw = lightcraft_raw::probe_info(&bytes).map_err(|e| e.to_string())?;
                    info.lens = lightcraft_engine::files::embedded_lens(&raw);
                    let native = raw.developed_size();
                    info.native_long = Some(native.0.max(native.1));
                    let mut s = lightcraft_develop::DevelopSettings::for_raw(
                        info.as_shot_temp,
                        info.as_shot_tint,
                    );
                    s.profile.id = "lc.neutral".into();
                    s.detail.sharpen_amount = 0.0;
                    s.detail.nr_color = 0.0;
                    s.detail.nr_luminance = 0.0;
                    s.detail.nr_outliers = false;
                    s.optics.lens_profile = true;
                    let o = ExportOptions {
                        format,
                        quality: 90,
                        color_space: OutputSpace::Srgb,
                        ..Default::default()
                    };
                    let size = lightcraft_pipeline::native_output_size(src.width, src.height, &s);
                    let r = lightcraft_pipeline::render(
                        &src,
                        &info,
                        &s,
                        &RenderRequest::fit(size.0.round() as usize, size.1.round() as usize),
                    );
                    let extra = ExtraOptions {
                        webp_lossless: true,
                        ..Default::default()
                    };
                    let encode_start = Instant::now();
                    let bytes = export_encode::encode_rendered(&r, &o, &extra, None)?;
                    let encode_ms = encode_start.elapsed().as_secs_f64() * 1000.0;
                    std::fs::write(
                        out.join(format!(
                            "{}-{mode}.{}",
                            file.file_stem().unwrap().to_string_lossy(),
                            format.extension()
                        )),
                        &bytes,
                    )
                    .map_err(|e| e.to_string())?;
                    Ok(
                        json!({"file":file.file_name().unwrap().to_string_lossy(),"totalMs":start.elapsed().as_secs_f64()*1000.0,"encodeMs":encode_ms,"bytes":bytes.len()}),
                    )
                };
                let mut per_file = Vec::new();
                for chunk in files.chunks(workers) {
                    for result in std::thread::scope(|scope| {
                        chunk
                            .iter()
                            .map(|f| scope.spawn(|| encode(f)))
                            .collect::<Vec<_>>()
                            .into_iter()
                            .map(|h| h.join().unwrap())
                            .collect::<Vec<_>>()
                    }) {
                        per_file.push(result?);
                    }
                }
                let row = json!({"format":format,"mode":mode,"repeat":repeat,"workers":workers,"batchMs":start.elapsed().as_secs_f64()*1000.0,"files":per_file});
                println!("{row}");
                rows.push(row);
                std::fs::write(out.join("timings.json"), serde_json::to_vec_pretty(&rows)?)?;
            }
        }
    }
    Ok(())
}

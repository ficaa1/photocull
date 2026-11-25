use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=src/tether/icc_bridge.m");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    println!("cargo:rerun-if-env-changed=SDKROOT");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_icc_bridge();
    }
    tauri_build::build()
}

/// Compiles the ImageCaptureCore bridge into a static library linked into the shell.
fn build_icc_bridge() {
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let object = out.join("icc_bridge.o");
    let library = out.join("libphotocull_icc.a");
    let mut clang = Command::new("/usr/bin/clang");
    clang.args(["-fobjc-arc", "-fmodules", "-O2", "-Wall"]);
    if let Ok(target) = std::env::var("TARGET") {
        let arch = if target.starts_with("aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        clang.args(["-arch", arch]);
    }
    // Matches Rust's own macOS default so the bridge never requires a newer system than the app.
    let min = std::env::var("MACOSX_DEPLOYMENT_TARGET")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "11.0".into());
    clang.arg(format!("-mmacosx-version-min={min}"));
    if let Some(sdk) = sdk_root() {
        clang.arg("-isysroot").arg(sdk);
    }
    clang
        .args(["-c", "src/tether/icc_bridge.m", "-o"])
        .arg(&object);
    run(clang, "compile icc_bridge.m");
    let _ = std::fs::remove_file(&library);
    let mut ar = Command::new("/usr/bin/ar");
    ar.arg("rcs").arg(&library).arg(&object);
    run(ar, "archive libphotocull_icc.a");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=photocull_icc");
    println!("cargo:rustc-link-lib=framework=ImageCaptureCore");
    println!("cargo:rustc-link-lib=framework=Foundation");
}

fn sdk_root() -> Option<String> {
    if let Some(sdk) = std::env::var("SDKROOT")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        return Some(sdk);
    }
    let output = Command::new("/usr/bin/xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .ok()?;
    let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (output.status.success() && !path.is_empty()).then_some(path)
}

fn run(mut command: Command, what: &str) {
    let status = command
        .status()
        .unwrap_or_else(|e| panic!("failed to {what}: {e}"));
    assert!(status.success(), "failed to {what}: {status}");
}

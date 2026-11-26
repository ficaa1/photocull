use std::{io, path::Path};

#[cfg(unix)]
pub(crate) fn c_path(path: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

#[cfg(target_os = "linux")]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::raw::{c_char, c_int, c_uint};
    extern "C" {
        fn renameat2(
            olddirfd: c_int,
            oldpath: *const c_char,
            newdirfd: c_int,
            newpath: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }
    const AT_FDCWD: c_int = -100;
    const RENAME_NOREPLACE: c_uint = 1;
    let (a, b) = (c_path(from)?, c_path(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    let rc = unsafe { renameat2(AT_FDCWD, a.as_ptr(), AT_FDCWD, b.as_ptr(), RENAME_NOREPLACE) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::raw::{c_char, c_int, c_uint};
    extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: c_uint) -> c_int;
    }
    const RENAME_EXCL: c_uint = 0x0000_0004;
    let (a, b) = (c_path(from)?, c_path(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    let rc = unsafe { renamex_np(a.as_ptr(), b.as_ptr(), RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (a, b) = (wide(from), wide(to));
    // Flags 0: fails with ERROR_ALREADY_EXISTS instead of replacing.
    // SAFETY: both buffers are NUL-terminated UTF-16 strings that outlive the call.
    let ok = unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0) };
    if ok != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exclusive rename is not available on this platform",
    ))
}

pub fn main() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--rename-no-replace")) {
        return;
    }
    if let (Some(from), Some(to), None) = (args.next(), args.next(), args.next()) {
        match rename_no_replace(Path::new(&from), Path::new(&to)) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(if e.kind() == io::ErrorKind::AlreadyExists {
                    2
                } else {
                    1
                });
            }
        }
    }
    std::process::exit(1);
}

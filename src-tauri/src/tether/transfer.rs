//! Destination handling for tethered captures: validated folders, owned staging files,
//! exclusive publication and free space. Uses only `std`.

#![allow(dead_code)]

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

pub const STAGE_DIR: &str = ".photocull-tether";
pub const SPACE_MARGIN: u64 = 256 << 20;

/// SHA-256 per FIPS 180-4 / RFC 6234.
#[derive(Clone)]
pub struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffered: usize,
    length: u64,
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Sha256 {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0; 64],
            buffered: 0,
            length: 0,
        }
    }

    fn compress(state: &mut [u32; 8], block: &[u8]) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for t in 16..64 {
            let s0 = w[t - 15].rotate_right(7) ^ w[t - 15].rotate_right(18) ^ (w[t - 15] >> 3);
            let s1 = w[t - 2].rotate_right(17) ^ w[t - 2].rotate_right(19) ^ (w[t - 2] >> 10);
            w[t] = w[t - 16]
                .wrapping_add(s0)
                .wrapping_add(w[t - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for t in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[t])
                .wrapping_add(w[t]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        if self.buffered > 0 {
            let take = (64 - self.buffered).min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered < 64 {
                return;
            }
            let block = self.buffer;
            Self::compress(&mut self.state, &block);
            self.buffered = 0;
        }
        let mut blocks = data.chunks_exact(64);
        for block in &mut blocks {
            Self::compress(&mut self.state, block);
        }
        let rest = blocks.remainder();
        self.buffer[..rest.len()].copy_from_slice(rest);
        self.buffered = rest.len();
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.length.wrapping_mul(8);
        let mut pad = vec![0x80u8];
        let used = (self.buffered + 1) % 64;
        let zeros = if used <= 56 { 56 - used } else { 120 - used };
        pad.extend(std::iter::repeat(0).take(zeros));
        pad.extend_from_slice(&bits.to_be_bytes());
        let length = self.length;
        self.update(&pad);
        self.length = length;
        let mut out = [0u8; 32];
        for (chunk, word) in out.chunks_exact_mut(4).zip(self.state) {
            chunk.copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    pub fn digest(data: &[u8]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(data);
        h.finish()
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_file(path: &Path) -> io::Result<(u64, String)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, hex(&hasher.finish())))
}

#[derive(Debug)]
pub enum TransferError {
    /// A name or relative path failed validation.
    Name(String),
    /// The destination name already exists; nothing was replaced.
    Taken(PathBuf),
    /// A folder is missing, not a folder, or reached through a link.
    Destination(String),
    /// The write would exceed the configured limit.
    Limit(u64),
    /// The bytes are not the image type the file name promises.
    Signature(String),
    /// The staged file no longer holds the bytes that were journaled.
    Changed(String),
    NoSpace,
    Io(io::Error),
}

impl fmt::Display for TransferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransferError::Name(m)
            | TransferError::Destination(m)
            | TransferError::Signature(m)
            | TransferError::Changed(m) => write!(f, "{m}"),
            TransferError::Taken(p) => write!(f, "{} already exists", p.display()),
            TransferError::Limit(n) => write!(f, "the file is larger than its declared {n} bytes"),
            TransferError::NoSpace => write!(f, "the destination disk is full"),
            TransferError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for TransferError {}

pub fn is_no_space(e: &io::Error) -> bool {
    // ENOSPC on Unix (28), ERROR_DISK_FULL (112) / ERROR_HANDLE_DISK_FULL (39) on Windows.
    match e.raw_os_error() {
        #[cfg(unix)]
        Some(28) => true,
        #[cfg(windows)]
        Some(39 | 112) => true,
        _ => false,
    }
}

impl From<io::Error> for TransferError {
    fn from(e: io::Error) -> Self {
        if is_no_space(&e) {
            TransferError::NoSpace
        } else if e.kind() == io::ErrorKind::AlreadyExists {
            TransferError::Taken(PathBuf::new())
        } else {
            TransferError::Io(e)
        }
    }
}

pub type Result<T> = std::result::Result<T, TransferError>;

const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// One portable folder or file name: no separators, controls, reserved names or hidden prefix.
pub fn validate_component(name: &str) -> Result<()> {
    let bad = |m: &str| Err(TransferError::Name(format!("{m}: {name:?}")));
    if name.is_empty() || name.trim().is_empty() {
        return bad("Enter a name");
    }
    if name.len() > 255 {
        return bad("The name is too long");
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return bad("Names cannot start with a dot");
    }
    if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') {
        return bad("Names cannot start with a space or end with a dot or space");
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
    }) {
        return bad("Names cannot contain / \\ : < > \" | ? * or control characters");
    }
    let stem = name.split('.').next().unwrap_or("").trim_end();
    if WINDOWS_RESERVED
        .iter()
        .any(|r| r.eq_ignore_ascii_case(stem))
    {
        return bad("That name is reserved on Windows");
    }
    Ok(())
}

/// A `/`-separated relative folder path; empty means the root itself.
pub fn validate_relative(relative: &str) -> Result<Vec<String>> {
    if relative.is_empty() {
        return Ok(Vec::new());
    }
    if relative.len() > 1024 {
        return Err(TransferError::Name("The folder path is too long.".into()));
    }
    relative
        .split('/')
        .map(|part| validate_component(part).map(|_| part.to_string()))
        .collect()
}

/// Folds a path into canonical components only when it has no `..`/`.` and is absolute.
pub fn is_plain_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|c| !matches!(c, Component::ParentDir | Component::CurDir))
}

/// Resolves `root/relative`, requiring every step to be a real folder and not a link.
pub fn resolve_dir(root: &Path, relative: &str) -> Result<PathBuf> {
    if !is_plain_absolute(root) {
        return Err(TransferError::Destination(
            "The capture folder path is not absolute.".into(),
        ));
    }
    let meta = fs::symlink_metadata(root)
        .map_err(|_| TransferError::Destination(format!("{} is not available.", root.display())))?;
    if !meta.is_dir() {
        return Err(TransferError::Destination(format!(
            "{} is not a folder.",
            root.display()
        )));
    }
    let mut current = root.to_path_buf();
    for part in validate_relative(relative)? {
        current.push(&part);
        let meta = fs::symlink_metadata(&current).map_err(|_| {
            TransferError::Destination(format!("{relative} is not an available folder."))
        })?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(TransferError::Destination(format!(
                "{relative} is not a folder or is reached through a link."
            )));
        }
    }
    Ok(current)
}

/// Creates one new folder under an existing validated parent. An existing real folder is reused.
pub fn create_child_dir(root: &Path, parent: &str, leaf: &str) -> Result<(PathBuf, String)> {
    validate_component(leaf)?;
    let parent_dir = resolve_dir(root, parent)?;
    let dir = parent_dir.join(leaf);
    match fs::create_dir(&dir) {
        Ok(()) => {
            let _ = sync_dir(&parent_dir);
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let relative = if parent.is_empty() {
        leaf.to_string()
    } else {
        format!("{parent}/{leaf}")
    };
    let resolved = resolve_dir(root, &relative)?;
    Ok((resolved, relative))
}

/// `dev:ino`, matching Node's `${stat.dev}:${stat.ino}`.
#[cfg(unix)]
pub fn dir_identity(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path).ok()?;
    Some(format!("{}:{}", meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
pub fn dir_identity(_path: &Path) -> Option<String> {
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub dev: Option<u64>,
    pub ino: Option<u64>,
}

#[cfg(unix)]
pub fn file_identity(meta: &fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    FileIdentity {
        dev: Some(meta.dev()),
        ino: Some(meta.ino()),
    }
}

#[cfg(not(unix))]
pub fn file_identity(_meta: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        dev: None,
        ino: None,
    }
}

#[cfg(unix)]
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
pub fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// The staging folder at the root of a shoot, created on demand and never a link.
pub fn stage_dir(root: &Path) -> Result<PathBuf> {
    stage_dir_create(root).map(|(dir, _)| dir)
}

/// Like `stage_dir`, also reporting whether this call created the directory itself.
pub fn stage_dir_create(root: &Path) -> Result<(PathBuf, bool)> {
    resolve_dir(root, "")?;
    let dir = root.join(STAGE_DIR);
    let created = match fs::create_dir(&dir) {
        Ok(()) => {
            let _ = sync_dir(root);
            true
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(e.into()),
    };
    let meta = fs::symlink_metadata(&dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(TransferError::Destination(
            "The tether staging folder is not a folder.".into(),
        ));
    }
    Ok((dir, created))
}

/// Resolves a journal-owned stage path of the form `.photocull-tether/<name>.part`.
pub fn stage_path(root: &Path, stage_rel: &str) -> Result<PathBuf> {
    let name = stage_rel
        .strip_prefix(STAGE_DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|name| name.ends_with(".part") && name.len() > 5)
        .ok_or_else(|| TransferError::Name("Invalid staging path.".into()))?;
    validate_component(name)?;
    Ok(stage_dir(root)?.join(name))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageReceipt {
    pub bytes: u64,
    pub sha256: String,
}

/// A create-new staging file that hashes as it writes. Unfinished files are removed on drop
/// unless the writer was told to keep partial bytes.
pub struct StageWriter {
    path: PathBuf,
    file: Option<File>,
    hasher: Sha256,
    bytes: u64,
    limit: u64,
    keep_partial: bool,
}

impl StageWriter {
    /// Opens a fresh stage file. An empty leftover at the same owned path is removed; one with
    /// bytes is moved aside, never deleted.
    pub fn create(path: PathBuf, limit: u64) -> Result<Self> {
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err(TransferError::Destination(
                    "The staging entry is not a regular file.".into(),
                ));
            }
            if meta.len() == 0 {
                fs::remove_file(&path)?;
            } else {
                set_aside(&path)?;
            }
        }
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(StageWriter {
            path,
            file: Some(file),
            hasher: Sha256::new(),
            bytes: 0,
            limit,
            keep_partial: false,
        })
    }

    /// Keeps whatever bytes arrived if the writer is dropped unfinished.
    pub fn keep_partial(&mut self) {
        self.keep_partial = true;
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Flushes data and metadata to disk and keeps the file.
    pub fn finish(mut self) -> Result<StageReceipt> {
        let file = self.file.take().expect("open stage file");
        file.sync_all()?;
        drop(file);
        if let Some(dir) = self.path.parent() {
            let _ = sync_dir(dir);
        }
        let hasher = std::mem::take(&mut self.hasher);
        let receipt = StageReceipt {
            bytes: self.bytes,
            sha256: hex(&hasher.finish()),
        };
        self.path = PathBuf::new();
        Ok(receipt)
    }
}

impl Write for StageWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.bytes + buf.len() as u64 > self.limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                TransferError::Limit(self.limit),
            ));
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("stage file closed"))?;
        file.write_all(buf)?;
        self.hasher.update(buf);
        self.bytes += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

impl Drop for StageWriter {
    fn drop(&mut self) {
        let Some(file) = self.file.take() else {
            return;
        };
        if self.path.as_os_str().is_empty() {
            return;
        }
        if self.keep_partial && self.bytes > 0 {
            let _ = file.sync_all();
        } else {
            drop(file);
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Stores a complete payload, replacing whatever partial bytes an earlier attempt left at `path`.
pub fn stage_complete(path: PathBuf, data: &[u8]) -> Result<StageReceipt> {
    if fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
        fs::remove_file(&path)?;
    }
    let mut writer = StageWriter::create(path, data.len() as u64)?;
    writer.write_all(data)?;
    writer.finish()
}

/// Checks that a capture starts with the signature its file name promises. Only the types a Sony
/// body delivers can pass; anything else stays in staging.
pub fn validate_capture_signature(name: &str, head: &[u8]) -> Result<()> {
    let extension = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_uppercase())
        .unwrap_or_default();
    let valid = match extension.as_str() {
        "ARW" => head.starts_with(b"II*\0") || head.starts_with(b"MM\0*"),
        "JPG" | "JPEG" => head.starts_with(&[0xFF, 0xD8, 0xFF]),
        "HIF" | "HEIF" | "HEIC" => {
            head.len() >= 12
                && &head[4..8] == b"ftyp"
                && matches!(
                    &head[8..12],
                    b"heic" | b"heix" | b"mif1" | b"msf1" | b"heif" | b"hevc"
                )
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(TransferError::Signature(format!(
            "{name} does not contain the image data its name promises; it stays in staging."
        )))
    }
}

/// [`validate_capture_signature`] against the first bytes of a staged file.
pub fn validate_staged_signature(path: &Path, name: &str) -> Result<()> {
    let mut head = Vec::with_capacity(16);
    File::open(path)?.take(16).read_to_end(&mut head)?;
    validate_capture_signature(name, &head)
}

/// Renames `path` to the first free `<name>.<n>.kept` beside it.
fn set_aside(path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| TransferError::Name("Invalid staging path.".into()))?
        .to_string_lossy()
        .into_owned();
    for n in 1..1000 {
        let aside = path.with_file_name(format!("{name}.{n}.kept"));
        match publish_no_replace(path, &aside) {
            Ok(_) => return Ok(aside),
            Err(TransferError::Taken(_)) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(TransferError::Destination(
        "Too many kept partial transfers in the staging folder.".into(),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishMethod {
    HardLink,
    ExclusiveRename,
}

/// Moves a staged file to `target` without ever replacing an existing entry.
/// Hard link + unlink first, then the platform's exclusive rename.
pub fn publish_no_replace(stage: &Path, target: &Path) -> Result<PublishMethod> {
    publish_no_replace_checked(stage, target, &|_| true)
}

/// Whether the entry at a path is still the file that was verified.
type Verify<'a> = &'a dyn Fn(&Path) -> bool;

fn swapped() -> TransferError {
    TransferError::Changed(
        "The staged capture was replaced during publication; nothing was published.".into(),
    )
}

fn publish_no_replace_checked(
    stage: &Path,
    target: &Path,
    verify: Verify,
) -> Result<PublishMethod> {
    let taken = || TransferError::Taken(target.to_path_buf());
    if fs::symlink_metadata(target).is_ok() {
        return Err(taken());
    }
    let method = match fs::hard_link(stage, target) {
        Ok(()) => {
            if !verify(target) {
                let _ = fs::remove_file(target);
                return Err(swapped());
            }
            if verify(stage) {
                fs::remove_file(stage)?;
            }
            PublishMethod::HardLink
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(taken()),
        Err(e) if is_no_space(&e) => return Err(TransferError::NoSpace),
        Err(_) => match rename_no_replace(stage, target) {
            Ok(()) if verify(target) => PublishMethod::ExclusiveRename,
            Ok(()) => {
                let _ = rename_no_replace(target, stage);
                return Err(swapped());
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(taken()),
            Err(e) => return Err(e.into()),
        },
    };
    if let Some(dir) = target.parent() {
        let _ = sync_dir(dir);
    }
    if let Some(dir) = stage.parent() {
        let _ = sync_dir(dir);
    }
    Ok(method)
}

/// Publishes `stage` as `name` inside `dir` without replacing anything, only while `dir` is
/// still the folder whose identity was recorded. On Unix the folder is pinned by an open handle,
/// so a folder swapped in after the check cannot receive the file.
pub fn publish_into(
    stage: &Path,
    dir: &Path,
    expected_id: Option<&str>,
    name: &str,
) -> Result<PublishMethod> {
    publish_checked(stage, dir, expected_id, name, &|_| true)
}

/// What a verified publication put in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Published {
    pub method: PublishMethod,
    pub bytes: u64,
    pub identity: FileIdentity,
}

/// [`publish_into`] for a stage file that must still hold the journaled bytes. The stage is opened
/// once: the hash, the signature and the identity the published file must have all come from that
/// open file, so a file swapped in at the stage path is neither published nor removed.
pub fn publish_verified(
    stage: &Path,
    dir: &Path,
    expected_id: Option<&str>,
    name: &str,
    receipt: &StageReceipt,
) -> Result<Published> {
    let mut file = File::open(stage)?;
    let meta = file.metadata()?;
    let pinned = file_identity(&meta);
    let mut hasher = Sha256::new();
    let mut head = Vec::with_capacity(16);
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let want = 16usize.saturating_sub(head.len()).min(n);
        head.extend_from_slice(&buf[..want]);
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    if !meta.is_file()
        || total != receipt.bytes
        || hex(&hasher.finish()) != receipt.sha256.to_ascii_lowercase()
    {
        return Err(TransferError::Changed(format!(
            "{name}: the staged capture no longer matches what the camera sent."
        )));
    }
    validate_capture_signature(name, &head)?;
    let same = |path: &Path| {
        fs::symlink_metadata(path)
            .is_ok_and(|m| m.is_file() && m.len() == receipt.bytes && file_identity(&m) == pinned)
    };
    let method = publish_checked(stage, dir, expected_id, name, &same)?;
    Ok(Published {
        method,
        bytes: receipt.bytes,
        identity: pinned,
    })
}

fn publish_checked(
    stage: &Path,
    dir: &Path,
    expected_id: Option<&str>,
    name: &str,
    verify: Verify,
) -> Result<PublishMethod> {
    validate_component(name)?;
    let changed =
        || TransferError::Destination("The capture folder changed or is unavailable.".into());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let handle = File::open(dir).map_err(|_| changed())?;
        let meta = handle.metadata()?;
        if !meta.is_dir() {
            return Err(changed());
        }
        if let Some(expected) = expected_id {
            if format!("{}:{}", meta.dev(), meta.ino()) != expected {
                return Err(changed());
            }
        }
        let method = publish_at(stage, &handle, name, &dir.join(name), verify)?;
        let _ = handle.sync_all();
        if let Some(parent) = stage.parent() {
            let _ = sync_dir(parent);
        }
        Ok(method)
    }
    #[cfg(not(unix))]
    {
        if let (Some(expected), Some(actual)) = (expected_id, dir_identity(dir)) {
            if actual != expected {
                return Err(changed());
            }
        }
        publish_no_replace_checked(stage, &dir.join(name), verify)
    }
}

#[cfg(unix)]
fn publish_at(
    stage: &Path,
    dir: &File,
    name: &str,
    target: &Path,
    verify: Verify,
) -> Result<PublishMethod> {
    use std::os::raw::{c_char, c_int};
    use std::os::unix::io::AsRawFd;
    extern "C" {
        fn linkat(
            olddirfd: c_int,
            oldpath: *const c_char,
            newdirfd: c_int,
            newpath: *const c_char,
            flags: c_int,
        ) -> c_int;
    }
    let taken = || TransferError::Taken(target.to_path_buf());
    let (from, to) = (c_path(stage)?, c_path(Path::new(name))?);
    let fd = dir.as_raw_fd();
    // SAFETY: both pointers are valid NUL-terminated strings and `fd` is an open directory.
    let rc = unsafe { linkat(AT_FDCWD, from.as_ptr(), fd, to.as_ptr(), 0) };
    if rc == 0 {
        if !verify(target) {
            let _ = fs::remove_file(target);
            return Err(swapped());
        }
        // Only the very file that was published leaves the staging folder.
        if verify(stage) {
            fs::remove_file(stage)?;
        }
        return Ok(PublishMethod::HardLink);
    }
    let e = io::Error::last_os_error();
    if e.kind() == io::ErrorKind::AlreadyExists {
        return Err(taken());
    }
    if is_no_space(&e) {
        return Err(TransferError::NoSpace);
    }
    match rename_at_no_replace(&from, fd, &to) {
        Ok(()) if verify(target) => Ok(PublishMethod::ExclusiveRename),
        Ok(()) => {
            let _ = rename_no_replace(target, stage);
            Err(swapped())
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(taken()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(target_os = "linux")]
const AT_FDCWD: std::os::raw::c_int = -100;
#[cfg(all(unix, not(target_os = "linux")))]
const AT_FDCWD: std::os::raw::c_int = -2;

#[cfg(target_os = "linux")]
fn rename_at_no_replace(
    from: &std::ffi::CStr,
    dir: std::os::raw::c_int,
    name: &std::ffi::CStr,
) -> io::Result<()> {
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
    const RENAME_NOREPLACE: c_uint = 1;
    // SAFETY: both pointers are valid NUL-terminated strings and `dir` is an open directory.
    let rc = unsafe {
        renameat2(
            AT_FDCWD,
            from.as_ptr(),
            dir,
            name.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn rename_at_no_replace(
    from: &std::ffi::CStr,
    dir: std::os::raw::c_int,
    name: &std::ffi::CStr,
) -> io::Result<()> {
    use std::os::raw::{c_char, c_int, c_uint};
    extern "C" {
        fn renameatx_np(
            fromfd: c_int,
            from: *const c_char,
            tofd: c_int,
            to: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }
    const RENAME_EXCL: c_uint = 0x0000_0004;
    // SAFETY: both pointers are valid NUL-terminated strings and `dir` is an open directory.
    let rc = unsafe { renameatx_np(AT_FDCWD, from.as_ptr(), dir, name.as_ptr(), RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn rename_at_no_replace(
    _from: &std::ffi::CStr,
    _dir: std::os::raw::c_int,
    _name: &std::ffi::CStr,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exclusive rename is not available on this platform",
    ))
}

#[cfg(unix)]
fn c_path(path: &Path) -> io::Result<std::ffi::CString> {
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

/// Bytes available to this user on the volume holding `path`.
#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
pub fn free_space(path: &Path) -> io::Result<u64> {
    use std::os::raw::{c_char, c_int, c_ulong};
    #[repr(C)]
    struct StatVfs {
        f_bsize: c_ulong,
        f_frsize: c_ulong,
        f_blocks: u64,
        f_bfree: u64,
        f_bavail: u64,
        f_files: u64,
        f_ffree: u64,
        f_favail: u64,
        f_fsid: c_ulong,
        f_flag: c_ulong,
        f_namemax: c_ulong,
        spare: [c_int; 6],
    }
    extern "C" {
        fn statvfs(path: *const c_char, buf: *mut StatVfs) -> c_int;
    }
    let p = c_path(path)?;
    let mut buf = std::mem::MaybeUninit::<StatVfs>::zeroed();
    // SAFETY: `buf` is a correctly sized, writable statvfs for 64-bit Linux.
    let rc = unsafe { statvfs(p.as_ptr(), buf.as_mut_ptr()) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statvfs succeeded and initialized the structure.
    let s = unsafe { buf.assume_init() };
    let unit = if s.f_frsize != 0 {
        s.f_frsize
    } else {
        s.f_bsize
    };
    Ok(s.f_bavail.saturating_mul(unit))
}

#[cfg(target_os = "macos")]
pub fn free_space(path: &Path) -> io::Result<u64> {
    use std::os::raw::{c_char, c_int};
    #[repr(C)]
    struct StatFs {
        f_bsize: u32,
        f_iosize: i32,
        f_blocks: u64,
        f_bfree: u64,
        f_bavail: u64,
        f_files: u64,
        f_ffree: u64,
        f_fsid: [i32; 2],
        f_owner: u32,
        f_type: u32,
        f_flags: u32,
        f_fssubtype: u32,
        f_fstypename: [c_char; 16],
        f_mntonname: [c_char; 1024],
        f_mntfromname: [c_char; 1024],
        f_flags_ext: u32,
        f_reserved: [u32; 7],
    }
    extern "C" {
        #[cfg_attr(target_arch = "x86_64", link_name = "statfs$INODE64")]
        fn statfs(path: *const c_char, buf: *mut StatFs) -> c_int;
    }
    let p = c_path(path)?;
    let mut buf = std::mem::MaybeUninit::<StatFs>::zeroed();
    // SAFETY: `buf` matches the 64-bit-inode statfs layout used by this symbol.
    let rc = unsafe { statfs(p.as_ptr(), buf.as_mut_ptr()) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statfs succeeded and initialized the structure.
    let s = unsafe { buf.assume_init() };
    Ok(s.f_bavail.saturating_mul(s.f_bsize as u64))
}

#[cfg(windows)]
pub fn free_space(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    // SAFETY: the path is NUL-terminated and the out-pointers are valid u64s.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    if ok != 0 {
        Ok(available)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(
    all(target_os = "linux", target_pointer_width = "64"),
    target_os = "macos",
    windows
)))]
pub fn free_space(_path: &Path) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "free space is not available on this platform",
    ))
}

/// Shots that fit after the safety margin, from the median of the last ten complete exposures.
pub fn estimate_shots(free: u64, recent_sizes: &[u64]) -> Option<u64> {
    let mut sizes: Vec<u64> = recent_sizes
        .iter()
        .rev()
        .take(10)
        .copied()
        .filter(|s| *s > 0)
        .collect();
    if sizes.is_empty() {
        return None;
    }
    sizes.sort_unstable();
    let mid = sizes.len() / 2;
    let median = if sizes.len() % 2 == 1 {
        sizes[mid]
    } else {
        (sizes[mid - 1] + sizes[mid]) / 2
    };
    Some(free.saturating_sub(SPACE_MARGIN) / median.max(1))
}

/// Whether `needed` bytes fit while keeping the safety margin.
pub fn has_room(free: u64, needed: u64) -> bool {
    free >= needed.saturating_add(SPACE_MARGIN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "photocull-transfer-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sha256_matches_nist_vectors() {
        let cases: [(&[u8], &str); 3] = [
            (
                b"",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                b"abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(hex(&Sha256::digest(input)), expected);
        }
        let long = b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
        assert_eq!(
            hex(&Sha256::digest(long)),
            "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
        );
        let mut h = Sha256::new();
        let chunk = [b'a'; 1000];
        for _ in 0..1000 {
            h.update(&chunk);
        }
        assert_eq!(
            hex(&h.finish()),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn sha256_is_independent_of_chunking() {
        let data: Vec<u8> = (0..5000u32).map(|i| (i * 31 % 251) as u8).collect();
        let whole = Sha256::digest(&data);
        for split in [1, 55, 56, 63, 64, 65, 127, 4999] {
            let mut h = Sha256::new();
            for chunk in data.chunks(split) {
                h.update(chunk);
            }
            assert_eq!(h.finish(), whole, "chunk size {split}");
        }
    }

    #[test]
    fn components_and_relative_paths_are_validated() {
        for ok in ["Blue", "Shot 01", "Été", "a.b"] {
            validate_component(ok).unwrap();
        }
        for bad in [
            "", " ", ".", "..", ".hidden", "a/b", "a\\b", "c:d", "trail.", "trail ", "CON",
            "nul.txt", "Com1", "x\u{0}y", "q?", "tab\t",
        ] {
            assert!(validate_component(bad).is_err(), "{bad:?}");
        }
        assert!(validate_component(&"x".repeat(256)).is_err());
        assert_eq!(validate_relative("").unwrap(), Vec::<String>::new());
        assert_eq!(validate_relative("Blue/Red").unwrap(), ["Blue", "Red"]);
        for bad in ["/abs", "a//b", "a/../b", "a/", "../x", ".photocull-tether"] {
            assert!(validate_relative(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn folders_resolve_only_through_real_directories() {
        let root = temp_root("resolve");
        let _c = Cleanup(root.clone());
        let (blue, rel) = create_child_dir(&root, "", "Blue").unwrap();
        assert_eq!(rel, "Blue");
        assert_eq!(blue, root.join("Blue"));
        let (_, rel) = create_child_dir(&root, "Blue", "Red").unwrap();
        assert_eq!(rel, "Blue/Red");
        // An existing folder is reused, not truncated.
        fs::write(root.join("Blue/keep.txt"), b"keep").unwrap();
        create_child_dir(&root, "", "Blue").unwrap();
        assert_eq!(fs::read(root.join("Blue/keep.txt")).unwrap(), b"keep");
        assert!(resolve_dir(&root, "Missing").is_err());
        fs::write(root.join("file"), b"x").unwrap();
        assert!(resolve_dir(&root, "file").is_err());
        assert!(create_child_dir(&root, "", "file").is_err());
        assert!(resolve_dir(Path::new("relative/root"), "").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("Blue"), root.join("Link")).unwrap();
            assert!(matches!(
                resolve_dir(&root, "Link/Red"),
                Err(TransferError::Destination(_))
            ));
            assert_eq!(
                dir_identity(&root.join("Blue")),
                dir_identity(&root.join("Link"))
            );
            assert!(dir_identity(&root.join("Blue")).unwrap().contains(':'));
        }
    }

    #[test]
    fn stage_writer_hashes_syncs_and_cleans_up_failures() {
        let root = temp_root("stage");
        let _c = Cleanup(root.clone());
        assert!(stage_path(&root, "elsewhere/x.part").is_err());
        assert!(stage_path(&root, ".photocull-tether/../x.part").is_err());
        assert!(stage_path(&root, ".photocull-tether/x.jpg").is_err());
        let path = stage_path(&root, ".photocull-tether/abc-123.part").unwrap();
        assert_eq!(path, root.join(STAGE_DIR).join("abc-123.part"));
        let mut w = StageWriter::create(path.clone(), 1 << 20).unwrap();
        w.write_all(b"hello ").unwrap();
        w.write_all(b"world").unwrap();
        let receipt = w.finish().unwrap();
        assert_eq!(receipt.bytes, 11);
        assert_eq!(receipt.sha256, hex(&Sha256::digest(b"hello world")));
        assert_eq!(fs::read(&path).unwrap(), b"hello world");
        assert_eq!(sha256_file(&path).unwrap(), (11, receipt.sha256.clone()));

        // Exceeding the declared size fails and leaves no partial file.
        let other = stage_path(&root, ".photocull-tether/limit.part").unwrap();
        let mut w = StageWriter::create(other.clone(), 4).unwrap();
        assert!(w.write_all(b"12345").is_err());
        drop(w);
        assert!(!other.exists());

        // A leftover stage file with bytes is set aside, never deleted, before a fresh download.
        let mut w = StageWriter::create(path.clone(), 100).unwrap();
        w.write_all(b"new").unwrap();
        w.finish().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let aside = root.join(STAGE_DIR).join("abc-123.part.1.kept");
        assert_eq!(fs::read(&aside).unwrap(), b"hello world");
        StageWriter::create(path.clone(), 100)
            .unwrap()
            .finish()
            .unwrap();
        assert_eq!(
            fs::read(root.join(STAGE_DIR).join("abc-123.part.2.kept")).unwrap(),
            b"new"
        );
        // An empty leftover is simply replaced.
        StageWriter::create(path.clone(), 100)
            .unwrap()
            .finish()
            .unwrap();
        assert!(!root.join(STAGE_DIR).join("abc-123.part.3.kept").exists());

        // A writer told to keep partial bytes leaves them on disk when dropped unfinished.
        let partial = stage_path(&root, ".photocull-tether/partial.part").unwrap();
        let mut w = StageWriter::create(partial.clone(), 1 << 20).unwrap();
        w.keep_partial();
        w.write_all(b"first half").unwrap();
        drop(w);
        assert_eq!(fs::read(&partial).unwrap(), b"first half");
        let mut w = StageWriter::create(other.clone(), 1 << 20).unwrap();
        w.keep_partial();
        drop(w);
        assert!(!other.exists());

        #[cfg(unix)]
        {
            let target = root.join("victim");
            fs::write(&target, b"keep").unwrap();
            let link = root.join(STAGE_DIR).join("link.part");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(StageWriter::create(link, 100).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"keep");
        }
    }

    #[test]
    fn only_files_with_their_promised_signature_may_be_published() {
        let root = temp_root("signature");
        let _c = Cleanup(root.clone());
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE1, 0, 0x10, b'E', b'x'];
        let tiff = *b"II*\0\x08\0\0\0";
        let heif = *b"\0\0\0\x18ftypheic\0\0\0\0";
        for (name, head) in [
            ("DSC00001.ARW", &tiff[..]),
            ("dsc00001.arw", b"MM\0*\0\0\0\x08"),
            ("DSC00001.JPG", &jpeg[..]),
            ("DSC00001.jpeg", &jpeg[..]),
            ("DSC00001.HIF", &heif[..]),
        ] {
            assert!(validate_capture_signature(name, head).is_ok(), "{name}");
        }
        for (name, head) in [
            ("DSC00001.ARW", &jpeg[..]),
            ("DSC00001.JPG", &tiff[..]),
            ("DSC00001.JPG", &[0xFF, 0xD8][..]),
            ("DSC00001.HIF", &tiff[..]),
            ("DSC00001.ARW", &[][..]),
            ("DSC00001.MP4", &heif[..]),
            ("DSC00001", &jpeg[..]),
        ] {
            assert!(
                matches!(
                    validate_capture_signature(name, head),
                    Err(TransferError::Signature(_))
                ),
                "{name}"
            );
        }

        let staged = stage_path(&root, ".photocull-tether/sig.part").unwrap();
        let receipt = stage_complete(staged.clone(), &jpeg).unwrap();
        assert_eq!(receipt.bytes, jpeg.len() as u64);
        assert!(validate_staged_signature(&staged, "DSC00001.JPG").is_ok());
        assert!(validate_staged_signature(&staged, "DSC00001.ARW").is_err());
        // A late complete payload replaces the partial bytes of the failed attempt.
        stage_complete(staged.clone(), &tiff).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), tiff);
        assert!(validate_staged_signature(&staged, "DSC00001.ARW").is_ok());
        assert!(validate_staged_signature(&root.join("missing.part"), "DSC00001.ARW").is_err());
    }

    #[test]
    fn publication_never_replaces_an_existing_file() {
        let root = temp_root("publish");
        let _c = Cleanup(root.clone());
        let stage = stage_path(&root, ".photocull-tether/one.part").unwrap();
        fs::write(&stage, b"capture").unwrap();
        let target = root.join("Shot-0001.ARW");
        assert_eq!(
            publish_no_replace(&stage, &target).unwrap(),
            PublishMethod::HardLink
        );
        assert!(!stage.exists());
        assert_eq!(fs::read(&target).unwrap(), b"capture");

        let stage = stage_path(&root, ".photocull-tether/two.part").unwrap();
        fs::write(&stage, b"second").unwrap();
        assert!(matches!(
            publish_no_replace(&stage, &target),
            Err(TransferError::Taken(p)) if p == target
        ));
        assert_eq!(fs::read(&target).unwrap(), b"capture");
        assert_eq!(fs::read(&stage).unwrap(), b"second");
    }

    #[test]
    fn publication_is_pinned_to_the_recorded_folder() {
        let root = temp_root("pinned");
        let _c = Cleanup(root.clone());
        let dir = root.join("Day 1");
        fs::create_dir(&dir).unwrap();
        let id = dir_identity(&dir);
        let stage = stage_path(&root, ".photocull-tether/pin.part").unwrap();
        fs::write(&stage, b"capture").unwrap();
        publish_into(&stage, &dir, id.as_deref(), "Shot-0001.ARW").unwrap();
        assert!(!stage.exists());
        assert_eq!(fs::read(dir.join("Shot-0001.ARW")).unwrap(), b"capture");

        fs::write(&stage, b"second").unwrap();
        assert!(matches!(
            publish_into(&stage, &dir, id.as_deref(), "Shot-0001.ARW"),
            Err(TransferError::Taken(_))
        ));
        assert!(publish_into(&stage, &dir, id.as_deref(), "../escape.ARW").is_err());
        assert_eq!(fs::read(&stage).unwrap(), b"second");

        // The folder was replaced by another one at the same path: nothing is published.
        #[cfg(unix)]
        {
            fs::rename(&dir, root.join("Day 1 moved")).unwrap();
            fs::create_dir(&dir).unwrap();
            assert!(matches!(
                publish_into(&stage, &dir, id.as_deref(), "Shot-0002.ARW"),
                Err(TransferError::Destination(_))
            ));
            assert!(!dir.join("Shot-0002.ARW").exists());
            assert!(!root.join("Day 1 moved").join("Shot-0002.ARW").exists());
            assert_eq!(fs::read(&stage).unwrap(), b"second");
        }
    }

    #[test]
    fn only_the_journaled_bytes_are_published_and_only_that_file_leaves_staging() {
        let root = temp_root("verified");
        let _c = Cleanup(root.clone());
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE1, 1, 2, 3, 4];
        let stage = stage_path(&root, ".photocull-tether/v.part").unwrap();
        let receipt = stage_complete(stage.clone(), &jpeg).unwrap();
        let id = dir_identity(&root);

        // Bytes changed after the receipt was journaled: nothing is published, the stage stays.
        fs::write(&stage, [0xFF, 0xD8, 0xFF, 0xE1, 9, 9, 9, 9]).unwrap();
        assert!(matches!(
            publish_verified(&stage, &root, id.as_deref(), "Shot-0001.JPG", &receipt),
            Err(TransferError::Changed(_))
        ));
        assert!(!root.join("Shot-0001.JPG").exists());
        assert!(stage.exists());

        // A file swapped in after hashing: the published entry is withdrawn and the stage kept.
        stage_complete(stage.clone(), &jpeg).unwrap();
        assert!(matches!(
            publish_checked(&stage, &root, id.as_deref(), "Shot-0001.JPG", &|_| false),
            Err(TransferError::Changed(_))
        ));
        assert!(!root.join("Shot-0001.JPG").exists());
        assert_eq!(fs::read(&stage).unwrap(), jpeg);

        let published =
            publish_verified(&stage, &root, id.as_deref(), "Shot-0001.JPG", &receipt).unwrap();
        let target = root.join("Shot-0001.JPG");
        let meta = fs::symlink_metadata(&target).unwrap();
        assert_eq!(published.bytes, jpeg.len() as u64);
        assert_eq!(published.identity, file_identity(&meta));
        assert!(!stage.exists());
        assert_eq!(fs::read(&target).unwrap(), jpeg);
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn exclusive_rename_refuses_to_overwrite() {
        let root = temp_root("rename");
        let _c = Cleanup(root.clone());
        let (a, b, c) = (root.join("a"), root.join("b"), root.join("c"));
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let err = rename_no_replace(&a, &b).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&b).unwrap(), b"b");
        rename_no_replace(&a, &c).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(&c).unwrap(), b"a");
    }

    #[test]
    fn free_space_and_estimates() {
        #[cfg(any(
            all(target_os = "linux", target_pointer_width = "64"),
            target_os = "macos",
            windows
        ))]
        assert!(free_space(&std::env::temp_dir()).unwrap() > 0);
        assert_eq!(estimate_shots(1 << 40, &[]), None);
        let mb = 1u64 << 20;
        let sizes = [10 * mb, 90 * mb, 30 * mb];
        assert_eq!(estimate_shots(SPACE_MARGIN + 300 * mb, &sizes), Some(10));
        assert_eq!(estimate_shots(SPACE_MARGIN / 2, &sizes), Some(0));
        // Only the last ten sizes count.
        let mut many = vec![1000 * mb; 5];
        many.extend([10 * mb; 10]);
        assert_eq!(estimate_shots(SPACE_MARGIN + 100 * mb, &many), Some(10));
        assert!(has_room(SPACE_MARGIN + 10, 10));
        assert!(!has_room(SPACE_MARGIN + 9, 10));
    }

    #[test]
    fn disk_full_errors_are_recognized() {
        #[cfg(unix)]
        {
            let e: TransferError = io::Error::from_raw_os_error(28).into();
            assert!(matches!(e, TransferError::NoSpace));
        }
        let e: TransferError = io::Error::new(io::ErrorKind::AlreadyExists, "x").into();
        assert!(matches!(e, TransferError::Taken(_)));
    }
}

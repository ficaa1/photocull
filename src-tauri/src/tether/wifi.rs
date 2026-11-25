//! Wi-Fi camera discovery (SSDP and the two UPnP descriptions), the stable PTP/IP initiator GUID
//! and the macOS OpenSSH tunnel for Access Authentication. Uses only `std` so it tests alone.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const DIGITAL_IMAGING: &str = "urn:schemas-sony-com:service:DigitalImaging:1";
pub const DEFAULT_WINDOW: Duration = Duration::from_secs(4);
pub const CAMERA_PTP_PORT: u16 = 15740;
const SSDP_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORT: u16 = 1900;
const ROOT_DEVICE: &str = "upnp:rootdevice";
const BASIC_DEVICE: &str = "urn:schemas-upnp-org:device:Basic:1";
const MAX_HTTP_RESPONSE: usize = 256 << 10;
const HTTP_BUDGET: Duration = Duration::from_secs(3);
/// Listening and reading every description share this one deadline.
const DISCOVERY_BUDGET: Duration = Duration::from_secs(6);
const MAX_SIGHTINGS: usize = 16;
const MAX_XML_DEPTH: usize = 32;
const MAX_XML_ELEMENTS: usize = 4096;

// SSDP

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SsdpKind {
    Notify,
    SearchResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsdpMessage {
    pub kind: SsdpKind,
    /// NT for a NOTIFY, ST for a search response.
    pub target: String,
    pub nts: Option<String>,
    pub usn: String,
    pub location: Option<String>,
    pub max_age: Option<u64>,
}

impl SsdpMessage {
    pub fn is_byebye(&self) -> bool {
        self.nts
            .as_deref()
            .is_some_and(|n| n.eq_ignore_ascii_case("ssdp:byebye"))
    }

    /// The `uuid:…` part of the USN.
    pub fn udn(&self) -> &str {
        self.usn.split("::").next().unwrap_or("")
    }

    fn relevant(&self) -> bool {
        [DIGITAL_IMAGING, ROOT_DEVICE, BASIC_DEVICE]
            .iter()
            .any(|t| self.target.eq_ignore_ascii_case(t))
    }
}

/// Parses a NOTIFY or a unicast search response; header names are case-insensitive.
pub fn parse_ssdp(datagram: &[u8]) -> Option<SsdpMessage> {
    let text = std::str::from_utf8(datagram).ok()?;
    let mut lines = text.split("\r\n").flat_map(|l| l.split('\n'));
    let start = lines.next()?.trim();
    let kind = if start.eq_ignore_ascii_case("NOTIFY * HTTP/1.1") {
        SsdpKind::Notify
    } else if start.starts_with("HTTP/1.") && start.split_whitespace().nth(1) == Some("200") {
        SsdpKind::SearchResponse
    } else {
        return None;
    };
    let mut headers = BTreeMap::new();
    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        let (name, value) = line.split_once(':')?;
        headers.insert(name.trim().to_ascii_uppercase(), value.trim().to_string());
    }
    let target = match kind {
        SsdpKind::Notify => headers.get("NT"),
        SsdpKind::SearchResponse => headers.get("ST"),
    }?
    .clone();
    let max_age = headers.get("CACHE-CONTROL").and_then(|v| {
        v.split(',').find_map(|part| {
            let (k, v) = part.split_once('=')?;
            k.trim()
                .eq_ignore_ascii_case("max-age")
                .then(|| v.trim().parse().ok())?
        })
    });
    Some(SsdpMessage {
        kind,
        target,
        nts: headers.get("NTS").cloned(),
        usn: headers.get("USN").cloned().unwrap_or_default(),
        location: headers.get("LOCATION").cloned(),
        max_age,
    })
}

pub fn m_search() -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {DIGITAL_IMAGING}\r\n\r\n"
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WifiCamera {
    pub address: Option<Ipv4Addr>,
    pub udn: String,
    pub friendly_name: String,
    pub manufacturer: String,
    pub model_name: String,
    /// `X_ModelName` from the service description, such as `ILCE-7CM2`.
    pub model: String,
    pub firmware: String,
    pub server_version: String,
    pub pairing_required: Option<bool>,
    /// `X_SSH_Support`: `Some(true)` means Access Authentication requires the SSH tunnel.
    pub ssh: Option<bool>,
    /// Seconds the announcement stays valid (`CACHE-CONTROL: max-age`).
    pub max_age: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Discovery {
    pub cameras: Vec<WifiCamera>,
    /// UDNs that announced `ssdp:byebye` during the window.
    pub departed: Vec<String>,
    /// Why the list may be incomplete, for the photographer.
    pub hint: Option<String>,
}

/// One bounded discovery window: listens for NOTIFY on the SSDP group and sends a supplemental
/// M-SEARCH. Socket failures degrade to an empty list with a hint.
pub fn discover(window: Duration) -> Discovery {
    let mut problems = Vec::new();
    let listener = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, SSDP_PORT))
        .and_then(|s| {
            s.join_multicast_v4(&SSDP_GROUP, &Ipv4Addr::UNSPECIFIED)?;
            Ok(s)
        })
        .map_err(|e| problems.push(format!("listening on UDP 1900 failed: {e}")))
        .ok();
    let searcher = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|s| {
            s.set_multicast_ttl_v4(2)?;
            Ok(s)
        })
        .map_err(|e| problems.push(format!("searching failed: {e}")))
        .ok();
    run_discovery(
        listener,
        searcher,
        SocketAddr::V4(SocketAddrV4::new(SSDP_GROUP, SSDP_PORT)),
        window,
        DISCOVERY_BUDGET,
        problems,
    )
}

struct Sighting {
    sender: Ipv4Addr,
    location: String,
    udn: String,
    max_age: Option<u64>,
}

fn run_discovery(
    listener: Option<UdpSocket>,
    searcher: Option<UdpSocket>,
    search_to: SocketAddr,
    window: Duration,
    budget: Duration,
    mut problems: Vec<String>,
) -> Discovery {
    let began = Instant::now();
    let overall = began + budget;
    let until = began + window.min(budget);
    let mut departed = Vec::new();
    let search = m_search();
    let mut searches = 0;
    let mut sightings: Vec<Sighting> = Vec::new();
    let mut buf = [0u8; 4096];
    let sockets: Vec<&UdpSocket> = listener.iter().chain(searcher.iter()).collect();
    while Instant::now() < until && !sockets.is_empty() {
        // A second search a second later covers one lost datagram.
        if let Some(s) = &searcher {
            if searches < 2 && began.elapsed() >= Duration::from_secs(searches) {
                searches += 1;
                if let Err(e) = s.send_to(search.as_bytes(), search_to) {
                    if searches == 1 {
                        problems.push(format!("sending the search failed: {e}"));
                    }
                }
            }
        }
        for socket in &sockets {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let _ = socket.set_read_timeout(Some(left.min(Duration::from_millis(50))));
            let Ok((n, from)) = socket.recv_from(&mut buf) else {
                continue;
            };
            let (SocketAddr::V4(from), Some(message)) = (from, parse_ssdp(&buf[..n])) else {
                continue;
            };
            note(&mut sightings, &mut departed, *from.ip(), message);
        }
    }
    let mut cameras: Vec<WifiCamera> = Vec::new();
    for s in sightings {
        if Instant::now() >= overall {
            break;
        }
        let deadline = (Instant::now() + HTTP_BUDGET).min(overall);
        if let Ok(mut camera) = describe(s.sender, &s.location, deadline) {
            if !cameras.iter().any(|c| c.udn == camera.udn) {
                camera.max_age = s.max_age;
                cameras.push(camera);
            }
        }
    }
    let hint = if !cameras.is_empty() {
        None
    } else if !problems.is_empty() {
        Some(format!(
            "PhotoCull could not search the network ({}). Allow Local Network access for PhotoCull in System Settings → Privacy & Security → Local Network, or add the camera by its IP address.",
            problems.join("; ")
        ))
    } else {
        Some("No camera answered. Turn on PC Remote on a camera on this network, check Local Network access for PhotoCull in System Settings, or add the camera by its IP address.".into())
    };
    Discovery {
        cameras,
        departed,
        hint,
    }
}

/// Records an alive announcement whose LOCATION names its sender; a byebye retires it and is
/// reported so an earlier sighting of that camera can go too.
fn note(
    sightings: &mut Vec<Sighting>,
    departed: &mut Vec<String>,
    sender: Ipv4Addr,
    message: SsdpMessage,
) {
    let udn = message.udn().to_string();
    if message.is_byebye() {
        sightings.retain(|s| !(s.sender == sender && (udn.is_empty() || s.udn == udn)));
        if !udn.is_empty() && !departed.contains(&udn) {
            departed.push(udn);
        }
        return;
    }
    if !message.relevant() {
        return;
    }
    let Some(location) = message.location.clone() else {
        return;
    };
    match parse_url(&location) {
        Ok(url) if url.host == sender => {}
        _ => return,
    }
    if sightings
        .iter()
        .any(|s| s.sender == sender && s.location == location)
        || sightings.len() >= MAX_SIGHTINGS
    {
        return;
    }
    departed.retain(|d| *d != udn);
    sightings.push(Sighting {
        sender,
        location,
        udn,
        max_age: message.max_age,
    });
}

/// Fetches and validates both descriptions of one announced device.
pub fn describe(sender: Ipv4Addr, location: &str, deadline: Instant) -> Result<WifiCamera, String> {
    let base = parse_url(location)?;
    if base.host != sender {
        return Err("the description lives on another host".into());
    }
    let body = http_get(&base, deadline)?;
    let device = parse_device_description(&utf8(body)?)?;
    let scpd = device
        .scpd_url
        .as_deref()
        .ok_or("the device offers no Sony DigitalImaging service")?;
    let scpd = resolve(&base, scpd)?;
    if scpd.host != sender {
        return Err("the service description lives on another host".into());
    }
    let service = parse_service_description(&utf8(http_get(&scpd, deadline)?)?)?;
    Ok(WifiCamera {
        address: Some(sender),
        udn: device.udn,
        friendly_name: device.friendly_name,
        manufacturer: device.manufacturer,
        model_name: device.model_name,
        model: service.model,
        firmware: service.firmware,
        server_version: service.server_version,
        pairing_required: service.pairing_required,
        ssh: service.ssh,
        max_age: None,
    })
}

fn utf8(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| "the description is not UTF-8".to_string())
}

// HTTP

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    pub host: Ipv4Addr,
    pub port: u16,
    pub path: String,
}

/// `http://` with a numeric IPv4 host only.
pub fn parse_url(text: &str) -> Result<Url, String> {
    let rest = text
        .strip_prefix("http://")
        .or_else(|| text.strip_prefix("HTTP://"))
        .ok_or("only http:// descriptions are read")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.contains('@') {
        return Err("credentials in a description URL".into());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| "invalid port")?),
        None => (authority, 80),
    };
    let host: Ipv4Addr = host
        .parse()
        .map_err(|_| "the host is not an IPv4 address")?;
    if path.bytes().any(|b| b <= b' ' || b == 0x7F) {
        return Err("invalid characters in the path".into());
    }
    Ok(Url {
        host,
        port,
        path: path.to_string(),
    })
}

/// Resolves an absolute URL, an absolute path or a path relative to `base`.
pub fn resolve(base: &Url, reference: &str) -> Result<Url, String> {
    let reference = reference.trim();
    if reference.contains("://") {
        return parse_url(reference);
    }
    if reference.starts_with("//") {
        return parse_url(&format!("http:{reference}"));
    }
    let path = if reference.starts_with('/') {
        reference.to_string()
    } else {
        let dir = &base.path[..base.path.rfind('/').map_or(0, |i| i + 1)];
        format!("{}{reference}", if dir.is_empty() { "/" } else { dir })
    };
    parse_url(&format!("http://{}:{}{path}", base.host, base.port))
}

/// A bounded GET: absolute deadline, 256 KiB response cap, Content-Length or chunked framing
/// and redirects only on the same host.
pub fn http_get(url: &Url, deadline: Instant) -> Result<Vec<u8>, String> {
    let mut url = url.clone();
    for _ in 0..3 {
        let (status, headers, body) = http_once(&url, deadline)?;
        match status {
            200 => return Ok(body),
            301 | 302 | 303 | 307 | 308 => {
                let location = headers
                    .get("location")
                    .ok_or("a redirect without a location")?;
                let next = resolve(&url, location)?;
                if next.host != url.host {
                    return Err("a redirect to another host".into());
                }
                url = next;
            }
            other => return Err(format!("HTTP status {other}")),
        }
    }
    Err("too many redirects".into())
}

type Response = (u16, BTreeMap<String, String>, Vec<u8>);

fn left(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| "the camera did not answer in time".to_string())
}

fn http_once(url: &Url, deadline: Instant) -> Result<Response, String> {
    let addr = SocketAddr::V4(SocketAddrV4::new(url.host, url.port));
    let mut stream =
        TcpStream::connect_timeout(&addr, left(deadline)?).map_err(|e| e.to_string())?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nAccept: text/xml\r\nUser-Agent: PhotoCull\r\nConnection: close\r\n\r\n",
        url.path, url.host, url.port
    );
    stream
        .set_write_timeout(Some(left(deadline)?))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        stream
            .set_read_timeout(Some(left(deadline)?))
            .map_err(|e| e.to_string())?;
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if raw.len() + n > MAX_HTTP_RESPONSE {
                    return Err("the description is too large".into());
                }
                raw.extend_from_slice(&buf[..n]);
                if complete(&raw) {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return Err("the camera did not answer in time".into())
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    parse_response(&raw)
}

/// Whether a framed response has fully arrived, so a kept-alive connection need not close.
fn complete(raw: &[u8]) -> bool {
    match parse_response(raw) {
        Ok(_) => {
            let Some(end) = find(raw, b"\r\n\r\n") else {
                return false;
            };
            let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
            head.contains("content-length:") || head.contains("chunked")
        }
        Err(_) => false,
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_response(raw: &[u8]) -> Result<Response, String> {
    let end = find(raw, b"\r\n\r\n").ok_or("an incomplete HTTP response")?;
    let head = std::str::from_utf8(&raw[..end]).map_err(|_| "invalid HTTP headers")?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    if !status_line.starts_with("HTTP/1.") {
        return Err("not an HTTP response".into());
    }
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("invalid HTTP status")?;
    let mut headers = BTreeMap::new();
    for line in lines {
        let (k, v) = line.split_once(':').ok_or("invalid HTTP header")?;
        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
    }
    let rest = &raw[end + 4..];
    let chunked = headers
        .get("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        dechunk(rest).ok_or("an incomplete chunked response")?
    } else if let Some(len) = headers.get("content-length") {
        let len: usize = len.parse().map_err(|_| "invalid Content-Length")?;
        if rest.len() < len {
            return Err("an incomplete HTTP response".into());
        }
        rest[..len].to_vec()
    } else {
        rest.to_vec()
    };
    Ok((status, headers, body))
}

/// Decodes a complete chunked body. Sizes come from the network, so every bound is checked and
/// the body counts only once the last chunk and its trailer section have fully arrived.
pub fn dechunk(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = find(data, b"\r\n")?;
        let size_text = std::str::from_utf8(&data[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        data = data.get(line_end + 2..)?;
        if size == 0 {
            // Optional trailer fields, then the empty line that ends the message.
            loop {
                let end = find(data, b"\r\n")?;
                if end == 0 {
                    return Some(out);
                }
                data = data.get(end + 2..)?;
            }
        }
        let end = size.checked_add(2)?;
        if data.get(size..end)? != b"\r\n" {
            return None;
        }
        out.extend_from_slice(data.get(..size)?);
        data = data.get(end..)?;
    }
}

// XML

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Element {
    /// The local name, without a namespace prefix.
    pub name: String,
    pub text: String,
    pub children: Vec<Element>,
}

impl Element {
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// The single child called `name`; duplicates are ambiguous.
    fn unique_child<'a>(&'a self, name: &'a str) -> Result<Option<&'a Element>, String> {
        let mut found = self.children_named(name);
        let first = found.next();
        if found.next().is_some() {
            return Err(format!("duplicate {name}"));
        }
        Ok(first)
    }

    fn collect<'a>(&'a self, name: &str, out: &mut Vec<&'a Element>) {
        for c in &self.children {
            if c.name == name {
                out.push(c);
            }
            c.collect(name, out);
        }
    }

    /// The text of the single descendant called `name`.
    fn unique_text(&self, name: &str) -> Result<Option<String>, String> {
        let mut found = Vec::new();
        self.collect(name, &mut found);
        match found.as_slice() {
            [] => Ok(None),
            [one] => Ok(Some(one.text.clone())),
            _ => Err(format!("duplicate {name}")),
        }
    }
}

struct XmlParser<'a> {
    s: &'a str,
    i: usize,
    elements: usize,
}

/// A small UTF-8 reader for UPnP descriptions. DTDs, entity declarations and undeclared entities
/// are rejected.
pub fn parse_xml(input: &str) -> Result<Element, String> {
    let mut p = XmlParser {
        s: input.strip_prefix('\u{feff}').unwrap_or(input),
        i: 0,
        elements: 0,
    };
    p.misc()?;
    if !p.rest().starts_with('<') {
        return Err("no root element".into());
    }
    let root = p.element(0)?;
    p.misc()?;
    if p.i != p.s.len() {
        return Err("content after the root element".into());
    }
    Ok(root)
}

impl<'a> XmlParser<'a> {
    fn rest(&self) -> &'a str {
        &self.s[self.i..]
    }

    fn skip_ws(&mut self) {
        let rest = self.rest();
        self.i += rest.len() - rest.trim_start().len();
    }

    fn skip_past(&mut self, end: &str) -> Result<&'a str, String> {
        let rest = self.rest();
        let at = rest
            .find(end)
            .ok_or_else(|| format!("unterminated {end}"))?;
        self.i += at + end.len();
        Ok(&rest[..at])
    }

    /// Whitespace, comments and processing instructions; any declaration is refused.
    fn misc(&mut self) -> Result<(), String> {
        loop {
            self.skip_ws();
            let rest = self.rest();
            if rest.starts_with("<?") {
                self.skip_past("?>")?;
            } else if rest.starts_with("<!--") {
                self.i += 4;
                self.skip_past("-->")?;
            } else if rest.starts_with("<!") {
                return Err("DTDs and declarations are not accepted".into());
            } else {
                return Ok(());
            }
        }
    }

    fn name(&mut self) -> Result<&'a str, String> {
        let rest = self.rest();
        let len = rest
            .find(|c: char| c.is_whitespace() || c == '/' || c == '>' || c == '=')
            .unwrap_or(rest.len());
        let name = &rest[..len];
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
        {
            return Err("invalid element name".into());
        }
        self.i += len;
        Ok(name)
    }

    fn element(&mut self, depth: usize) -> Result<Element, String> {
        if depth >= MAX_XML_DEPTH {
            return Err("the document is nested too deeply".into());
        }
        self.elements += 1;
        if self.elements > MAX_XML_ELEMENTS {
            return Err("the document has too many elements".into());
        }
        self.i += 1;
        let qname = self.name()?;
        let mut element = Element {
            name: local(qname).to_string(),
            ..Element::default()
        };
        loop {
            self.skip_ws();
            let rest = self.rest();
            if rest.starts_with("/>") {
                self.i += 2;
                return Ok(element);
            }
            if rest.starts_with('>') {
                self.i += 1;
                break;
            }
            self.name()?;
            self.skip_ws();
            if !self.rest().starts_with('=') {
                return Err("an attribute without a value".into());
            }
            self.i += 1;
            self.skip_ws();
            let quote = self.rest().chars().next().ok_or("unterminated attribute")?;
            if quote != '"' && quote != '\'' {
                return Err("an unquoted attribute".into());
            }
            self.i += 1;
            let value = self.skip_past(if quote == '"' { "\"" } else { "'" })?;
            if value.contains('<') {
                return Err("'<' in an attribute".into());
            }
            decode_entities(value)?;
        }
        let mut text = String::new();
        loop {
            let rest = self.rest();
            if rest.is_empty() {
                return Err(format!("unterminated <{qname}>"));
            }
            if let Some(after) = rest.strip_prefix("</") {
                self.i += 2;
                let name = self.name()?;
                if name != qname {
                    return Err(format!("</{name}> closes <{qname}>"));
                }
                self.skip_ws();
                if !self.rest().starts_with('>') {
                    return Err(format!("malformed </{name}>"));
                }
                let _ = after;
                self.i += 1;
                element.text = text.trim().to_string();
                return Ok(element);
            }
            if rest.starts_with("<!--") {
                self.i += 4;
                self.skip_past("-->")?;
            } else if rest.starts_with("<![CDATA[") {
                self.i += 9;
                text.push_str(self.skip_past("]]>")?);
            } else if rest.starts_with("<!") {
                return Err("DTDs and declarations are not accepted".into());
            } else if rest.starts_with("<?") {
                self.skip_past("?>")?;
            } else if rest.starts_with('<') {
                let child = self.element(depth + 1)?;
                element.children.push(child);
            } else {
                let len = rest.find('<').unwrap_or(rest.len());
                text.push_str(&decode_entities(&rest[..len])?);
                self.i += len;
            }
        }
    }
}

fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

fn decode_entities(text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at + 1..];
        let end = rest
            .find(';')
            .filter(|e| *e <= 10)
            .ok_or("an unterminated entity")?;
        let name = &rest[..end];
        let c = match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = name.strip_prefix("#x").or(name.strip_prefix("#X")) {
                    u32::from_str_radix(hex, 16).ok()
                } else if let Some(dec) = name.strip_prefix('#') {
                    dec.parse().ok()
                } else {
                    None
                };
                code.filter(|c| *c != 0)
                    .and_then(char::from_u32)
                    .ok_or_else(|| format!("the undeclared entity &{name};"))?
            }
        };
        out.push(c);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceDescription {
    pub device_type: String,
    pub friendly_name: String,
    pub manufacturer: String,
    pub model_name: String,
    pub model_description: String,
    pub udn: String,
    /// SCPDURL of the Sony DigitalImaging service, if offered.
    pub scpd_url: Option<String>,
}

pub fn parse_device_description(xml: &str) -> Result<DeviceDescription, String> {
    let root = parse_xml(xml)?;
    if root.name != "root" {
        return Err("not a UPnP device description".into());
    }
    let device = root.unique_child("device")?.ok_or("no device element")?;
    let field = |name: &str| -> Result<String, String> {
        Ok(device
            .unique_child(name)?
            .map(|e| e.text.clone())
            .unwrap_or_default())
    };
    let udn = field("UDN")?;
    if !udn.starts_with("uuid:") {
        return Err("the device has no UDN".into());
    }
    let mut services = Vec::new();
    if let Some(list) = device.unique_child("serviceList")? {
        for service in list.children_named("service") {
            let kind = service
                .unique_child("serviceType")?
                .map(|e| e.text.as_str());
            if kind == Some(DIGITAL_IMAGING) {
                services.push(service);
            }
        }
    }
    let scpd_url = match services.as_slice() {
        [] => None,
        [one] => one.unique_child("SCPDURL")?.map(|e| e.text.clone()),
        _ => return Err("duplicate DigitalImaging services".into()),
    };
    Ok(DeviceDescription {
        device_type: field("deviceType")?,
        friendly_name: field("friendlyName")?,
        manufacturer: field("manufacturer")?,
        model_name: field("modelName")?,
        model_description: field("modelDescription")?,
        udn,
        scpd_url,
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServiceDescription {
    pub model: String,
    pub firmware: String,
    pub server_version: String,
    pub ptp_versions: String,
    pub pairing_required: Option<bool>,
    pub ssh: Option<bool>,
}

pub fn parse_service_description(xml: &str) -> Result<ServiceDescription, String> {
    let root = parse_xml(xml)?;
    let text =
        |name: &str| -> Result<String, String> { Ok(root.unique_text(name)?.unwrap_or_default()) };
    let pairing = text("X_PTP_PairingNecessity")?;
    let ssh = text("X_SSH_Support")?;
    Ok(ServiceDescription {
        model: text("X_ModelName")?,
        firmware: text("X_FirmwareVersion")?,
        server_version: text("X_ServerVersion")?,
        ptp_versions: text("X_PTP_Versions")?,
        // Unknown spellings stay unknown: they never select plaintext.
        pairing_required: match pairing.to_ascii_lowercase().as_str() {
            "necessary" | "enable" => Some(true),
            "unnecessary" | "disable" => Some(false),
            _ => None,
        },
        ssh: match ssh.to_ascii_lowercase().as_str() {
            "enable" => Some(true),
            "disable" => Some(false),
            _ => None,
        },
    })
}

/// A typed camera address: a numeric unicast IPv4 address and nothing else.
pub fn parse_camera_address(text: &str) -> Result<Ipv4Addr, String> {
    let invalid = || "Enter the camera's IPv4 address, such as 192.168.122.1.".to_string();
    if text.is_empty() || text.len() > 15 || text.trim() != text {
        return Err(invalid());
    }
    let ip: Ipv4Addr = text.parse().map_err(|_| invalid())?;
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() || ip.is_broadcast() {
        return Err(invalid());
    }
    Ok(ip)
}

// Initiator GUID

/// PhotoCull's PTP/IP initiator GUID, created once per installation. The camera remembers
/// paired initiators by it.
pub fn initiator_guid(data_dir: &Path) -> io::Result<[u8; 16]> {
    let dir = data_dir.join("tether");
    fs::create_dir_all(&dir)?;
    let path = dir.join("initiator-guid.txt");
    match fs::read_to_string(&path) {
        Ok(text) => {
            if let Some(guid) = parse_uuid(text.trim()) {
                return Ok(guid);
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut guid = random_bytes()?;
    guid[6] = (guid[6] & 0x0F) | 0x40;
    guid[8] = (guid[8] & 0x3F) | 0x80;
    let tmp = dir.join(format!(
        "initiator-guid.{}.{}.tmp",
        std::process::id(),
        nanos()
    ));
    {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(format!("{}\n", format_uuid(&guid)).as_bytes())?;
        f.sync_all()?;
    }
    // Linking fails if another process created the file first; its GUID wins.
    let linked = fs::hard_link(&tmp, &path);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(guid),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            parse_uuid(fs::read_to_string(&path)?.trim())
                .ok_or_else(|| io::Error::new(ErrorKind::InvalidData, "invalid initiator GUID"))
        }
        Err(_) if !path.exists() => {
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            f.write_all(format!("{}\n", format_uuid(&guid)).as_bytes())?;
            f.sync_all()?;
            Ok(guid)
        }
        // An unreadable file left by a crash is replaced.
        Err(_) => {
            let replace = dir.join(format!(
                "initiator-guid.{}.{}.new",
                std::process::id(),
                nanos()
            ));
            fs::write(&replace, format!("{}\n", format_uuid(&guid)))?;
            fs::rename(&replace, &path)?;
            Ok(guid)
        }
    }
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn random_bytes() -> io::Result<[u8; 16]> {
    let mut out = [0u8; 16];
    if let Ok(mut f) = File::open("/dev/urandom") {
        f.read_exact(&mut out)?;
        return Ok(out);
    }
    // Without /dev/urandom, std's per-process hash keys come from the OS generator.
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    for (i, chunk) in out.chunks_mut(8).enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(nanos());
        h.write_usize(i);
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    Ok(out)
}

pub fn format_uuid(b: &[u8; 16]) -> String {
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

pub fn parse_uuid(text: &str) -> Option<[u8; 16]> {
    let hex: String = text.chars().filter(|c| *c != '-').collect();
    if text.len() != 36 || hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

// SSH host keys

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKey {
    pub key_type: String,
    /// The base64 public key blob as written in known_hosts.
    pub blob: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    Verified,
    Unverified(HostKey),
    Changed(HostKey),
}

/// OpenSSH's `SHA256:` fingerprint of a public key blob.
pub fn fingerprint(blob: &[u8]) -> String {
    format!("SHA256:{}", base64_encode(&sha256(blob), false))
}

/// Keys from `ssh-keyscan` output, the camera's preferred ECDSA key first.
pub fn parse_keyscan(output: &str) -> Vec<HostKey> {
    let mut keys: Vec<HostKey> = output
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let _host = parts.next()?;
            let key_type = parts.next()?;
            let blob = parts.next()?;
            let raw = base64_decode(blob)?;
            if !valid_key_type(key_type) {
                return None;
            }
            Some(HostKey {
                key_type: key_type.to_string(),
                blob: blob.to_string(),
                fingerprint: fingerprint(&raw),
            })
        })
        .collect();
    keys.sort_by_key(|k| match k.key_type.as_str() {
        "ecdsa-sha2-nistp256" => 0,
        "ssh-ed25519" => 1,
        t if t.starts_with("ecdsa-") => 2,
        _ => 3,
    });
    keys.dedup();
    keys
}

fn valid_key_type(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 64
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'@' | b'.'))
}

/// A per-camera alias for the app's known_hosts file.
pub fn host_alias(seed: &str) -> String {
    let clean: String = seed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    format!("photocull-camera-{clean}")
}

pub fn valid_username(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn pinned(known_hosts: &Path, alias: &str) -> io::Result<Vec<(String, String)>> {
    let text = match fs::read_to_string(known_hosts) {
        Ok(t) => t,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            (parts.next()? == alias)
                .then(|| Some((parts.next()?.to_string(), parts.next()?.to_string())))?
        })
        .collect())
}

/// Compares the camera's scanned keys with the key pinned for `alias`.
pub fn check_host_key(
    known_hosts: &Path,
    alias: &str,
    scanned: &[HostKey],
) -> io::Result<HostKeyStatus> {
    let preferred = scanned
        .first()
        .cloned()
        .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "the camera offered no SSH host key"))?;
    let pins = pinned(known_hosts, alias)?;
    if pins.is_empty() {
        return Ok(HostKeyStatus::Unverified(preferred));
    }
    if scanned
        .iter()
        .any(|k| pins.iter().any(|(t, b)| *t == k.key_type && *b == k.blob))
    {
        return Ok(HostKeyStatus::Verified);
    }
    Ok(HostKeyStatus::Changed(preferred))
}

/// Pins `key` as the only key for `alias`, replacing the file atomically.
pub fn pin_host_key(known_hosts: &Path, alias: &str, key: &HostKey) -> io::Result<()> {
    let dir = known_hosts.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let existing = match fs::read_to_string(known_hosts) {
        Ok(t) => t,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let mut out: String = existing
        .lines()
        .filter(|l| l.split_whitespace().next() != Some(alias))
        .map(|l| format!("{l}\n"))
        .collect();
    out.push_str(&format!("{alias} {} {}\n", key.key_type, key.blob));
    let tmp = dir.join(format!(".known_hosts.{}.{}", std::process::id(), nanos()));
    {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(out.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, known_hosts)
}

/// Reads the camera's SSH host keys with `ssh-keyscan`.
pub fn scan_host_keys(address: Ipv4Addr, timeout: Duration) -> Result<Vec<HostKey>, SshError> {
    let output = run_bounded(
        Command::new("/usr/bin/ssh-keyscan")
            .args(["-p", "22", "-T", &timeout.as_secs().max(1).to_string()])
            .arg(address.to_string()),
        timeout + Duration::from_secs(3),
    )?;
    let keys = parse_keyscan(&output);
    if keys.is_empty() {
        return Err(SshError::Unreachable(
            "The camera did not offer an SSH host key. Check that Access Authentication is on and the camera is reachable."
                .into(),
        ));
    }
    Ok(keys)
}

fn run_bounded(command: &mut Command, limit: Duration) -> Result<String, SshError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| SshError::Unavailable(format!("OpenSSH is not available: {e}")))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = (&mut stdout).take(1 << 20).read_to_end(&mut out);
        out
    });
    let until = Instant::now() + limit;
    loop {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(SshError::Unreachable(
                "The camera did not answer on the SSH port.".into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = reader.join().unwrap_or_default();
    Ok(String::from_utf8_lossy(&out).into_owned())
}

// SSH tunnel

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshError {
    Unavailable(String),
    HostKey(String),
    Authentication(String),
    Unreachable(String),
    Failed(String),
    /// The photographer disconnected while the tunnel was starting.
    Cancelled,
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshError::Unavailable(m)
            | SshError::HostKey(m)
            | SshError::Authentication(m)
            | SshError::Unreachable(m)
            | SshError::Failed(m) => f.write_str(m),
            SshError::Cancelled => f.write_str("Connecting was cancelled."),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SshTarget {
    pub address: Ipv4Addr,
    pub username: String,
    pub alias: String,
    pub known_hosts: PathBuf,
}

/// ssh expands % tokens in a control path, including one given with `-S`.
fn control_arg(socket: &Path) -> String {
    socket.to_string_lossy().replace('%', "%%")
}

/// OpenSSH arguments for one tunnel. The camera only forwards to the literal name
/// `localhost:15740`; `127.0.0.1:15740` is refused as a remote destination. The tunnel is a
/// control master on a private socket, so readiness is asked of ssh itself.
pub fn ssh_args(
    target: &SshTarget,
    local_port: u16,
    control: &Path,
) -> Result<Vec<String>, SshError> {
    if !valid_username(&target.username) {
        return Err(SshError::Failed("Invalid camera user name.".into()));
    }
    let known = target.known_hosts.to_string_lossy();
    if known.contains(['"', '\n', '\r']) {
        return Err(SshError::Failed("Unusable known-hosts path.".into()));
    }
    // ssh_config splits on whitespace unless quoted and expands % tokens in this option.
    let known = format!("UserKnownHostsFile=\"{}\"", known.replace('%', "%%"));
    let control = control_arg(control);
    let args = [
        "-F",
        "/dev/null",
        "-N",
        "-T",
        "-M",
        "-S",
        &control,
        "-p",
        "22",
        "-c",
        "aes128-ctr",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        &known,
        "-o",
        &format!("HostKeyAlias={}", target.alias),
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "PreferredAuthentications=password,keyboard-interactive",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ControlPersist=no",
        "-o",
        "LogLevel=DEBUG1",
        "-L",
        &format!("127.0.0.1:{local_port}:localhost:{CAMERA_PTP_PORT}"),
        &format!("{}@{}", target.username, target.address),
    ];
    Ok(args.iter().map(|s| s.to_string()).collect())
}

/// What ssh's diagnostics say about a start-up failure.
fn classify(log: &str) -> SshError {
    let has = |s: &str| log.contains(s);
    if has("REMOTE HOST IDENTIFICATION HAS CHANGED") || has("Host key verification failed") {
        SshError::HostKey(
            "The camera's SSH host key does not match the one confirmed earlier.".into(),
        )
    } else if has("Permission denied") || has("Too many authentication failures") {
        SshError::Authentication(
            "The camera refused the user name or password from Access Authen. Info.".into(),
        )
    } else if has("Address already in use")
        || has("cannot listen to port")
        || has("Could not request local forwarding")
    {
        SshError::Failed("local port in use".into())
    } else if has("Connection refused") {
        SshError::Unreachable(
            "The camera refused SSH. Turn on Access Authentication or connect without it.".into(),
        )
    } else if has("timed out") || has("No route to host") || has("Network is unreachable") {
        SshError::Unreachable("The camera did not answer on the network.".into())
    } else {
        SshError::Failed("The SSH tunnel to the camera did not start.".into())
    }
}

const SSH_ENV_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Asks the control master `ssh -O <op>` within `limit`; true when ssh answered success.
fn control(program: &Path, socket: &Path, destination: &str, op: &str, limit: Duration) -> bool {
    let child = Command::new(program)
        .args(["-F", "/dev/null", "-S"])
        .arg(control_arg(socket))
        .args(["-O", op, destination])
        .env_clear()
        .env("PATH", SSH_ENV_PATH)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return false;
    };
    let until = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(10)),
            _ => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

/// A private directory for the control socket, removed with everything in it on drop.
struct ControlDir {
    dir: PathBuf,
    socket: PathBuf,
}

impl ControlDir {
    #[cfg(unix)]
    fn create(private_dir: &Path) -> Result<ControlDir, SshError> {
        use std::os::unix::fs::DirBuilderExt;
        let name = format!("ctl-{}-{:x}", std::process::id(), nanos());
        let mut dir = private_dir.join(&name);
        // ssh first binds the socket under a name 17 bytes longer; macOS socket paths end at 104.
        if dir.as_os_str().len() + "/c".len() + 17 > 100 {
            dir = Path::new("/tmp").join(format!("photocull-{name}"));
        }
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| SshError::Failed(format!("Could not prepare the SSH tunnel: {e}")))?;
        Ok(ControlDir {
            socket: dir.join("c"),
            dir,
        })
    }

    #[cfg(not(unix))]
    fn create(_private_dir: &Path) -> Result<ControlDir, SshError> {
        Err(SshError::Unavailable(
            "SSH camera sign-in runs on macOS.".into(),
        ))
    }
}

impl Drop for ControlDir {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket);
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// A running `ssh -N -L` forward to the camera's PTP/IP port. On drop the master is asked to
/// exit, then killed and reaped, and its control socket removed.
pub struct SshTunnel {
    child: Child,
    local_port: u16,
    log: Arc<Mutex<String>>,
    stderr: Option<JoinHandle<()>>,
    askpass: Option<Askpass>,
    program: PathBuf,
    destination: String,
    control: Option<ControlDir>,
    ready: bool,
}

impl SshTunnel {
    /// Starts the tunnel, retrying a local port collision on a fresh port. The password reaches
    /// ssh only through a one-shot askpass pipe in `private_dir`. Setting `cancel` stops the
    /// attempt and reaps ssh.
    pub fn start(
        target: &SshTarget,
        password: &str,
        private_dir: &Path,
        timeout: Duration,
        cancel: &AtomicBool,
    ) -> Result<SshTunnel, SshError> {
        Self::start_with(
            Path::new("/usr/bin/ssh"),
            target,
            password,
            private_dir,
            timeout,
            cancel,
        )
    }

    fn start_with(
        program: &Path,
        target: &SshTarget,
        password: &str,
        private_dir: &Path,
        timeout: Duration,
        cancel: &AtomicBool,
    ) -> Result<SshTunnel, SshError> {
        let mut last = SshError::Failed("The SSH tunnel to the camera did not start.".into());
        for _ in 0..3 {
            let port = free_port()?;
            match Self::attempt(
                program,
                target,
                password,
                private_dir,
                port,
                timeout,
                cancel,
            ) {
                Ok(t) => return Ok(t),
                Err(SshError::Failed(m)) if m == "local port in use" => {
                    last = SshError::Failed("No free local port for the SSH tunnel.".into());
                }
                Err(e) => return Err(e),
            }
        }
        Err(last)
    }

    fn attempt(
        program: &Path,
        target: &SshTarget,
        password: &str,
        private_dir: &Path,
        port: u16,
        timeout: Duration,
        cancel: &AtomicBool,
    ) -> Result<SshTunnel, SshError> {
        let until = Instant::now() + timeout;
        let askpass = Askpass::create(private_dir, password, until)?;
        let control_dir = ControlDir::create(private_dir)?;
        let mut command = Command::new(program);
        command
            .args(ssh_args(target, port, &control_dir.socket)?)
            .env_clear()
            .env("PATH", SSH_ENV_PATH)
            .env("SSH_ASKPASS", &askpass.script)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "photocull")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(home) = std::env::var_os("HOME") {
            command.env("HOME", home);
        }
        let mut child = command
            .spawn()
            .map_err(|e| SshError::Unavailable(format!("OpenSSH is not available: {e}")))?;
        let log = Arc::new(Mutex::new(String::new()));
        let stderr = child.stderr.take().map(|pipe| {
            let log = log.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines() {
                    let Ok(line) = line else { break };
                    let mut tail = log.lock().unwrap();
                    tail.push_str(&line);
                    tail.push('\n');
                    if tail.len() > 16 << 10 {
                        let cut = tail.len() - (8 << 10);
                        let cut = (cut..tail.len())
                            .find(|i| tail.is_char_boundary(*i))
                            .unwrap_or(0);
                        tail.drain(..cut);
                    }
                }
            })
        });
        let mut tunnel = SshTunnel {
            child,
            local_port: port,
            log,
            stderr,
            askpass: Some(askpass),
            program: program.to_path_buf(),
            destination: format!("{}@{}", target.username, target.address),
            control: Some(control_dir),
            ready: false,
        };
        let mut next_check = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(SshError::Cancelled);
            }
            if let Ok(Some(_)) = tunnel.child.try_wait() {
                if let Some(h) = tunnel.stderr.take() {
                    let _ = h.join();
                }
                return Err(classify(&tunnel.log.lock().unwrap()));
            }
            let now = Instant::now();
            if now >= until {
                return Err(SshError::Unreachable(
                    "The SSH tunnel to the camera did not start in time.".into(),
                ));
            }
            // Only an authenticated master with its forward in place answers the check.
            if now >= next_check {
                let socket = &tunnel.control.as_ref().expect("control dir").socket;
                let limit = (until - now).min(Duration::from_secs(2));
                if control(program, socket, &tunnel.destination, "check", limit) {
                    tunnel.ready = true;
                    tunnel.askpass.take();
                    return Ok(tunnel);
                }
                next_check = Instant::now() + Duration::from_millis(100);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn local_addr(&self) -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.local_port))
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.askpass.take();
        if let (true, Some(dir)) = (self.ready, &self.control) {
            control(
                &self.program,
                &dir.socket,
                &self.destination,
                "exit",
                Duration::from_secs(2),
            );
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(h) = self.stderr.take() {
            let _ = h.join();
        }
        self.control.take();
    }
}

fn free_port() -> Result<u16, SshError> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| SshError::Failed(format!("No local port for the SSH tunnel: {e}")))
}

/// A private directory holding an askpass script and a FIFO that hands the password over once.
/// The password never touches arguments, the environment or a file on disk.
struct Askpass {
    dir: PathBuf,
    script: PathBuf,
    stop: Arc<AtomicBool>,
    writer: Option<JoinHandle<()>>,
}

impl Askpass {
    #[cfg(unix)]
    fn create(private_dir: &Path, password: &str, until: Instant) -> Result<Askpass, SshError> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
        let fail = |e: io::Error| SshError::Failed(format!("Could not prepare SSH sign-in: {e}"));
        fs::create_dir_all(private_dir).map_err(fail)?;
        let _ = fs::set_permissions(private_dir, fs::Permissions::from_mode(0o700));
        let dir = private_dir.join(format!("askpass-{}-{}", std::process::id(), nanos()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(fail)?;
        let fifo = dir.join("secret");
        let made = Command::new("/usr/bin/mkfifo")
            .args(["-m", "600"])
            .arg(&fifo)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(fail)?;
        if !made.success() {
            let _ = fs::remove_dir_all(&dir);
            return Err(SshError::Failed("Could not prepare SSH sign-in.".into()));
        }
        let script = dir.join("askpass");
        let body = askpass_script(&fifo);
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&script)
            .and_then(|mut f| f.write_all(body.as_bytes()));
        if let Err(e) = written {
            let _ = fs::remove_dir_all(&dir);
            return Err(fail(e));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let mut secret = password.as_bytes().to_vec();
        secret.push(b'\n');
        let flag = stop.clone();
        let (fifo_path, script_path) = (fifo.clone(), script.clone());
        let writer = std::thread::spawn(move || {
            // Non-blocking open fails until askpass opens the reading end.
            while !flag.load(Ordering::SeqCst) && Instant::now() < until {
                match OpenOptions::new()
                    .write(true)
                    .custom_flags(O_NONBLOCK)
                    .open(&fifo_path)
                {
                    Ok(mut f) => {
                        // Unlinked before writing: a second prompt finds nothing to read.
                        let _ = fs::remove_file(&fifo_path);
                        let _ = fs::remove_file(&script_path);
                        let _ = f.write_all(&secret);
                        break;
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
            secret.iter_mut().for_each(|b| *b = 0);
            let _ = fs::remove_file(&fifo_path);
            let _ = fs::remove_file(&script_path);
        });
        Ok(Askpass {
            dir,
            script,
            stop,
            writer: Some(writer),
        })
    }

    #[cfg(not(unix))]
    fn create(_private_dir: &Path, _password: &str, _until: Instant) -> Result<Askpass, SshError> {
        Err(SshError::Unavailable(
            "SSH camera sign-in runs on macOS.".into(),
        ))
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
const O_NONBLOCK: i32 = 0o4000;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
const O_NONBLOCK: i32 = 0x0004;

impl Drop for Askpass {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn askpass_script(fifo: &Path) -> String {
    let quoted = fifo.to_string_lossy().replace('\'', "'\\''");
    format!("#!/bin/sh\nexec /bin/cat -- '{quoted}'\n")
}

// Known cameras

pub const WIFI_PREFIX: &str = "wifi:";
/// How long an SSDP sighting lasts when the camera gives no `max-age` (UPnP's default).
const DEFAULT_MAX_AGE: u64 = 1800;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WifiAuth {
    Unknown,
    Ssh,
    Plain,
}

impl WifiAuth {
    pub fn as_str(self) -> Option<&'static str> {
        match self {
            WifiAuth::Unknown => None,
            WifiAuth::Ssh => Some("ssh"),
            WifiAuth::Plain => Some("plain"),
        }
    }
}

/// A camera found by SSDP, entered by address or remembered from a verified connection.
#[derive(Debug, Clone)]
pub struct WifiCandidate {
    pub address: Ipv4Addr,
    pub name: String,
    pub model: String,
    pub udn: String,
    pub auth: WifiAuth,
    /// What the camera's description advertised; a hint only.
    pub ssh_advertised: Option<bool>,
    pub username: Option<String>,
    pub alias: String,
    pub discovered: bool,
    /// When the last SSDP sighting lapses.
    pub expires_at: Option<Instant>,
    /// Set by a verified connection, so a reconnect can check it is the same body.
    pub responder_guid: Option<[u8; 16]>,
}

impl WifiCandidate {
    pub fn new(address: Ipv4Addr, udn: &str) -> Self {
        let seed = if udn.is_empty() {
            address.to_string()
        } else {
            udn.to_string()
        };
        WifiCandidate {
            address,
            name: String::new(),
            model: String::new(),
            udn: udn.to_string(),
            auth: WifiAuth::Unknown,
            ssh_advertised: None,
            username: None,
            alias: host_alias(&seed),
            discovered: false,
            expires_at: None,
            responder_guid: None,
        }
    }

    /// Remembered from a connection or given a route by the photographer; such a camera stays
    /// listed when its announcements stop.
    fn kept(&self) -> bool {
        self.responder_guid.is_some() || self.auth != WifiAuth::Unknown
    }
}

#[derive(Default)]
pub struct WifiState {
    pub loaded: bool,
    pub candidates: BTreeMap<String, WifiCandidate>,
    /// SSH passwords for this run only; never written to disk, logs or the renderer.
    pub passwords: std::collections::HashMap<String, String>,
}

impl WifiState {
    /// Adds one discovery window: fresh sightings, and cameras that said goodbye.
    pub fn merge(&mut self, cameras: &[WifiCamera], departed: &[String], now: Instant) {
        for camera in cameras {
            let Some(address) = camera.address else {
                continue;
            };
            let id = format!("{WIFI_PREFIX}{address}");
            // The same advertised body at a new address keeps its SSH requirement and host-key
            // pin; its identity is checked again when it connects.
            let earlier = self
                .candidates
                .values()
                .find(|c| !camera.udn.is_empty() && c.udn == camera.udn)
                .cloned();
            let entry = self
                .candidates
                .entry(id)
                .or_insert_with(|| WifiCandidate::new(address, &camera.udn));
            if let Some(earlier) = earlier {
                if entry.auth == WifiAuth::Unknown {
                    entry.auth = earlier.auth;
                    entry.username = earlier.username;
                    entry.alias = earlier.alias;
                }
            }
            entry.name = camera.friendly_name.clone();
            entry.model = camera.model.clone();
            entry.udn = camera.udn.clone();
            entry.ssh_advertised = camera.ssh;
            entry.discovered = true;
            let max_age = camera.max_age.unwrap_or(DEFAULT_MAX_AGE);
            entry.expires_at = now.checked_add(Duration::from_secs(max_age));
        }
        for udn in departed.iter().filter(|u| !u.is_empty()) {
            for c in self.candidates.values_mut().filter(|c| c.udn == *udn) {
                c.expires_at = Some(now);
            }
        }
    }

    /// Retires sightings whose announcement lapsed. Remembered, configured and `active`
    /// cameras stay, no longer marked as discovered.
    pub fn prune(&mut self, now: Instant, active: Option<&str>) {
        let lapsed: Vec<String> = self
            .candidates
            .iter()
            .filter(|(_, c)| c.expires_at.is_some_and(|t| t <= now))
            .map(|(id, _)| id.clone())
            .collect();
        for id in lapsed {
            let c = self.candidates.get_mut(&id).expect("listed above");
            if c.kept() || active == Some(id.as_str()) {
                c.discovered = false;
                c.expires_at = None;
            } else {
                self.candidates.remove(&id);
                self.passwords.remove(&id);
            }
        }
    }
}

/// The route Auto picks, or why the photographer has to choose. Plaintext is never assumed: it
/// needs an earlier explicit choice, and an SSH pin is never silently given up.
pub fn auto_auth(candidate: &WifiCandidate, ssh_pinned: bool) -> Result<WifiAuth, &'static str> {
    const CHOOSE: &str =
        "Choose whether this camera uses Access Authentication (SSH) or connects without it.";
    const CONFIRM_PLAIN: &str = "The camera reports Access Authentication off. Confirm connecting without SSH; anyone on this network could then control the camera.";
    const SSH_OFF: &str = "The camera reports Access Authentication off, but PhotoCull connected to it with SSH before. Turn Access Authentication back on, or confirm connecting without SSH.";
    let ssh_before = candidate.auth == WifiAuth::Ssh || ssh_pinned;
    match (candidate.ssh_advertised, candidate.auth) {
        (Some(true), _) => Ok(WifiAuth::Ssh),
        (_, WifiAuth::Plain) => Ok(WifiAuth::Plain),
        (Some(false), _) if ssh_before => Err(SSH_OFF),
        (Some(false), _) => Err(CONFIRM_PLAIN),
        (None, _) if ssh_before => Ok(WifiAuth::Ssh),
        (None, _) => Err(CHOOSE),
    }
}

/// What a failed connection attempt to the camera says about the network path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// The OS refused PhotoCull local network access.
    Denied,
    /// Nothing answered at the address.
    Unreachable,
    /// The address answered but nothing listens for PTP/IP.
    Refused,
    Other,
}

pub fn reach(kind: ErrorKind) -> Reach {
    match kind {
        ErrorKind::PermissionDenied => Reach::Denied,
        ErrorKind::ConnectionRefused => Reach::Refused,
        ErrorKind::HostUnreachable
        | ErrorKind::NetworkUnreachable
        | ErrorKind::NetworkDown
        | ErrorKind::AddrNotAvailable
        | ErrorKind::TimedOut => Reach::Unreachable,
        _ => Reach::Other,
    }
}

/// Whether `alias` has a pinned host key.
pub fn has_pin(known_hosts: &Path, alias: &str) -> bool {
    pinned(known_hosts, alias).is_ok_and(|p| !p.is_empty())
}

/// The route a shoot attached through, frozen when it attached: every reconnect, automatic or
/// requested, goes the same way to the same verified body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachedWifiRoute {
    pub address: Ipv4Addr,
    pub auth: WifiAuth,
    pub username: Option<String>,
    pub alias: String,
    pub pinned_host_key: Vec<(String, String)>,
    pub responder_guid: Option<[u8; 16]>,
    pub model: String,
}

impl AttachedWifiRoute {
    /// The route for a first connection; identity is filled in once the camera answers.
    pub fn attach(candidate: &WifiCandidate, known_hosts: &Path) -> Result<Self, SshError> {
        let pinned_host_key = match candidate.auth {
            WifiAuth::Ssh => pinned(known_hosts, &candidate.alias)
                .map_err(|e| SshError::Failed(format!("Could not read the SSH key pin: {e}")))?,
            _ => Vec::new(),
        };
        if candidate.auth == WifiAuth::Ssh && pinned_host_key.is_empty() {
            return Err(SshError::HostKey(
                "Confirm the camera's SSH key by adding the camera again.".into(),
            ));
        }
        Ok(AttachedWifiRoute {
            address: candidate.address,
            auth: candidate.auth,
            username: candidate.username.clone(),
            alias: candidate.alias.clone(),
            pinned_host_key,
            responder_guid: None,
            model: String::new(),
        })
    }

    /// A reconnect only trusts the key that was pinned when the shoot attached.
    pub fn check_pin(&self, known_hosts: &Path) -> Result<(), SshError> {
        if self.auth != WifiAuth::Ssh {
            return Ok(());
        }
        let now = pinned(known_hosts, &self.alias)
            .map_err(|e| SshError::Failed(format!("Could not read the SSH key pin: {e}")))?;
        if now != self.pinned_host_key {
            return Err(SshError::HostKey(
                "The camera's SSH key pin changed since this shoot connected. Choose the camera again to continue.".into(),
            ));
        }
        Ok(())
    }

    /// Whether a reopened camera is the body this route attached to.
    pub fn same_body(&self, model: &str, responder_guid: Option<[u8; 16]>) -> bool {
        self.responder_guid.is_some()
            && self.responder_guid == responder_guid
            && self.model == model.trim()
    }
}

// SHA-256 and base64 for host-key fingerprints

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

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8], pad: bool) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = chunk.len();
        let v = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= n {
                out.push(B64[(v >> (18 - 6 * i)) as usize & 63] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim_end_matches('=');
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in text.bytes() {
        let v = B64.iter().position(|b| *b == c)? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    const DD_XML: &str = r#"<?xml version="1.0"?>
<!-- recorded shape, identifiers synthetic -->
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:av="urn:schemas-sony-com:av">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
    <friendlyName>ILCE-7CM2</friendlyName>
    <manufacturer>Sony Corporation</manufacturer>
    <manufacturerURL>http://www.sony.net/</manufacturerURL>
    <modelDescription>SonyRemoteCamera</modelDescription>
    <modelName>SonyImagingDevice</modelName>
    <UDN>uuid:00000000-0000-1010-8000-0123456789ab</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-sony-com:service:DigitalImaging:1</serviceType>
        <serviceId>urn:schemas-sony-com:serviceId:DigitalImaging</serviceId>
        <SCPDURL>/DigitalImagingDesc.xml</SCPDURL>
        <controlURL>/upnp/control/DigitalImaging</controlURL>
        <eventSubURL></eventSubURL>
      </service>
    </serviceList>
    <av:X_ScalarWebAPI_DeviceInfo/>
  </device>
</root>
"#;

    const SCPD_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <X_DigitalImagingDeviceInfo xmlns="urn:schemas-sony-com:av">
    <X_DeviceInfo>
      <X_ModelName>ILCE-7CM2</X_ModelName>
      <X_FirmwareVersion>2.01</X_FirmwareVersion>
      <X_ServerVersion>3.00</X_ServerVersion>
      <X_SerialVersion>1.00</X_SerialVersion>
    </X_DeviceInfo>
    <X_PTP_Information>
      <X_PTP_Versions>1.0 &amp; 1.1</X_PTP_Versions>
      <X_PTP_RemoteControlSupport>Enable</X_PTP_RemoteControlSupport>
      <X_PTP_MediaServerSupport>Disable</X_PTP_MediaServerSupport>
      <X_PTP_PairingNecessity>Unnecessary</X_PTP_PairingNecessity>
    </X_PTP_Information>
    <X_ConnectionInfo><X_SSH_Support>Enable</X_SSH_Support></X_ConnectionInfo>
  </X_DigitalImagingDeviceInfo>
</scpd>
"#;

    fn notify(nt: &str, nts: &str, location: &str) -> String {
        format!(
            "NOTIFY * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\ncache-control: max-age = 1800\r\nLocation: {location}\r\nnt: {nt}\r\nNTS: {nts}\r\nSERVER: FedoraCore/2 UPnP/1.0 MINT-X/1.8.1\r\nUSN: uuid:00000000-0000-1010-8000-0123456789ab::{nt}\r\n\r\n"
        )
    }

    fn search_ok(location: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: {location}\r\nSERVER: UPnP/1.0\r\nST: {DIGITAL_IMAGING}\r\nUSN: uuid:00000000-0000-1010-8000-0123456789ab::{DIGITAL_IMAGING}\r\n\r\n"
        )
    }

    /// Serves `routes` over HTTP/1.1, the SCPD chunked, until `stop`.
    fn http_server(
        routes: Vec<(&'static str, String)>,
        requests: usize,
    ) -> (SocketAddr, thread::JoinHandle<Vec<String>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..requests {
                let (mut s, _) = l.accept().unwrap();
                s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut req = Vec::new();
                let mut buf = [0u8; 1024];
                while find(&req, b"\r\n\r\n").is_none() {
                    let n = s.read(&mut buf).unwrap();
                    req.extend_from_slice(&buf[..n]);
                }
                let req = String::from_utf8(req).unwrap();
                let path = req.split_whitespace().nth(1).unwrap().to_string();
                seen.push(req.clone());
                let reply = match routes.iter().find(|(p, _)| *p == path) {
                    Some((p, body)) if p.ends_with("Desc.xml") => {
                        let (a, b) = body.split_at(body.len() / 2);
                        format!(
                            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/xml\r\n\r\n{:x}\r\n{a}\r\n{:x};ext=1\r\n{b}\r\n0\r\n\r\n",
                            a.len(),
                            b.len()
                        )
                    }
                    Some((_, body)) => format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nConnection: keep-alive\r\n\r\n{body}",
                        body.len()
                    ),
                    None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string(),
                };
                s.write_all(reply.as_bytes()).unwrap();
            }
            seen
        });
        (addr, handle)
    }

    #[test]
    fn ssdp_notify_search_response_and_byebye_parse_case_insensitively() {
        let alive = parse_ssdp(
            notify(
                DIGITAL_IMAGING,
                "ssdp:alive",
                "http://192.168.122.1:64321/dd.xml",
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(alive.kind, SsdpKind::Notify);
        assert_eq!(alive.target, DIGITAL_IMAGING);
        assert_eq!(alive.max_age, Some(1800));
        assert_eq!(
            alive.location.as_deref(),
            Some("http://192.168.122.1:64321/dd.xml")
        );
        assert_eq!(alive.udn(), "uuid:00000000-0000-1010-8000-0123456789ab");
        assert!(!alive.is_byebye());
        let bye = parse_ssdp(
            notify(
                ROOT_DEVICE,
                "ssdp:byebye",
                "http://192.168.122.1:64321/dd.xml",
            )
            .as_bytes(),
        )
        .unwrap();
        assert!(bye.is_byebye());
        let reply = parse_ssdp(search_ok("http://10.0.0.7/dd.xml").as_bytes()).unwrap();
        assert_eq!(reply.kind, SsdpKind::SearchResponse);
        assert_eq!(reply.target, DIGITAL_IMAGING);
        assert!(parse_ssdp(m_search().as_bytes()).is_none());
        assert!(
            parse_ssdp(b"HTTP/1.1 200 OK\r\nUSN: x\r\n\r\n").is_none(),
            "no ST"
        );
        assert_eq!(
            m_search(),
            "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-sony-com:service:DigitalImaging:1\r\n\r\n"
        );
    }

    #[test]
    fn descriptions_separate_identity_from_model_and_read_flags() {
        let device = parse_device_description(DD_XML).unwrap();
        assert_eq!(device.friendly_name, "ILCE-7CM2");
        assert_eq!(device.model_name, "SonyImagingDevice");
        assert_eq!(device.manufacturer, "Sony Corporation");
        assert_eq!(device.udn, "uuid:00000000-0000-1010-8000-0123456789ab");
        assert_eq!(device.scpd_url.as_deref(), Some("/DigitalImagingDesc.xml"));
        let service = parse_service_description(SCPD_XML).unwrap();
        assert_eq!(service.model, "ILCE-7CM2");
        assert_eq!(service.firmware, "2.01");
        assert_eq!(service.ptp_versions, "1.0 & 1.1");
        assert_eq!(service.ssh, Some(true));
        assert_eq!(service.pairing_required, Some(false));

        let unknown = SCPD_XML
            .replace(">Enable</X_SSH", ">Maybe</X_SSH")
            .replace("Unnecessary", "Necessary");
        let service = parse_service_description(&unknown).unwrap();
        assert_eq!((service.ssh, service.pairing_required), (None, Some(true)));

        let twice = DD_XML.replace(
            "<UDN>",
            "<UDN>uuid:00000000-0000-1010-8000-ffffffffffff</UDN><UDN>",
        );
        assert!(parse_device_description(&twice)
            .unwrap_err()
            .contains("duplicate UDN"));
        let twice = SCPD_XML.replace(
            "<X_SSH_Support>Enable",
            "<X_SSH_Support>Disable</X_SSH_Support><X_SSH_Support>Enable",
        );
        assert!(parse_service_description(&twice).is_err());
        let no_service = DD_XML.replace("DigitalImaging:1</serviceType>", "Other:1</serviceType>");
        assert_eq!(
            parse_device_description(&no_service).unwrap().scpd_url,
            None
        );
    }

    #[test]
    fn xml_rejects_dtds_and_undeclared_entities() {
        let doctype = format!(
            "<?xml version=\"1.0\"?><!DOCTYPE root [<!ENTITY x SYSTEM \"file:///etc/passwd\">]>{}",
            &DD_XML[22..]
        );
        assert!(parse_xml(&doctype).unwrap_err().contains("DTD"));
        assert!(parse_xml("<root><!ENTITY x \"y\"></root>").is_err());
        assert!(parse_xml("<root>&xxe;</root>")
            .unwrap_err()
            .contains("entity"));
        assert!(parse_xml("<root>a & b</root>").is_err());
        assert!(parse_xml("<root><a></b></root>").is_err());
        assert!(parse_xml("<root></root><root/>").is_err());
        assert!(parse_xml(&"<a>".repeat(40)).is_err());
        let e =
            parse_xml("<p:root a='1' b=\"&lt;\"><x>&#x41;&#66;<![CDATA[<c>]]></x><y/></p:root>")
                .unwrap();
        assert_eq!(e.name, "root");
        assert_eq!(e.child("x").unwrap().text, "AB<c>");
        assert!(e.child("y").is_some());
    }

    #[test]
    fn urls_stay_on_the_announcing_host() {
        let base = parse_url("http://192.168.122.1:64321/dd.xml").unwrap();
        assert_eq!(
            resolve(&base, "/DigitalImagingDesc.xml").unwrap(),
            parse_url("http://192.168.122.1:64321/DigitalImagingDesc.xml").unwrap()
        );
        assert_eq!(resolve(&base, "sub/x.xml").unwrap().path, "/sub/x.xml");
        assert_eq!(parse_url("http://10.1.2.3").unwrap().port, 80);
        assert!(parse_url("http://camera.local/dd.xml").is_err());
        assert!(parse_url("https://10.0.0.1/dd.xml").is_err());
        assert!(parse_url("http://user@10.0.0.1/dd.xml").is_err());
        let (mut sightings, mut departed) = (Vec::new(), Vec::new());
        let sender = Ipv4Addr::new(192, 168, 122, 1);
        note(
            &mut sightings,
            &mut departed,
            sender,
            parse_ssdp(
                notify(
                    DIGITAL_IMAGING,
                    "ssdp:alive",
                    "http://192.168.122.9:64321/dd.xml",
                )
                .as_bytes(),
            )
            .unwrap(),
        );
        assert!(sightings.is_empty(), "LOCATION on another host");
        let alive = notify(
            BASIC_DEVICE,
            "ssdp:alive",
            "http://192.168.122.1:64321/dd.xml",
        );
        note(
            &mut sightings,
            &mut departed,
            sender,
            parse_ssdp(alive.as_bytes()).unwrap(),
        );
        note(
            &mut sightings,
            &mut departed,
            sender,
            parse_ssdp(alive.as_bytes()).unwrap(),
        );
        assert_eq!(sightings.len(), 1, "duplicates coalesce");
        note(
            &mut sightings,
            &mut departed,
            sender,
            parse_ssdp(notify("urn:other", "ssdp:alive", "http://192.168.122.1:1/x").as_bytes())
                .unwrap(),
        );
        assert_eq!(sightings.len(), 1, "unrelated targets are ignored");
        note(
            &mut sightings,
            &mut departed,
            sender,
            parse_ssdp(notify(ROOT_DEVICE, "ssdp:byebye", "").as_bytes()).unwrap(),
        );
        assert!(sightings.is_empty(), "byebye retires the candidate");
        assert_eq!(departed, ["uuid:00000000-0000-1010-8000-0123456789ab"]);
    }

    #[test]
    fn camera_addresses_are_numeric_unicast_ipv4() {
        assert_eq!(
            parse_camera_address("192.168.122.1"),
            Ok(Ipv4Addr::new(192, 168, 122, 1))
        );
        assert!(parse_camera_address("169.254.10.2").is_ok());
        for bad in [
            "",
            "localhost",
            "camera.local",
            "0.0.0.0",
            "127.0.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "192.168.1.5:15740",
            " 192.168.1.5",
            "192.168.1.5\n",
            "::1",
            "192.168.001.5",
            "1.2.3",
            "192.168.1.256",
        ] {
            assert!(parse_camera_address(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn discovery_reads_both_descriptions_over_loopback() {
        let (http, server) = http_server(
            vec![
                ("/dd.xml", DD_XML.to_string()),
                ("/DigitalImagingDesc.xml", SCPD_XML.to_string()),
            ],
            2,
        );
        let location = format!("http://127.0.0.1:{}/dd.xml", http.port());
        let responder = UdpSocket::bind("127.0.0.1:0").unwrap();
        responder
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
        let searcher = UdpSocket::bind("127.0.0.1:0").unwrap();
        let notify_to = listener.local_addr().unwrap();
        let search_to = responder.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        let camera = thread::spawn(move || {
            let mut buf = [0u8; 2048];
            let (n, from) = responder.recv_from(&mut buf).unwrap();
            tx.send(String::from_utf8_lossy(&buf[..n]).into_owned())
                .unwrap();
            responder
                .send_to(search_ok(&location).as_bytes(), from)
                .unwrap();
            responder
                .send_to(
                    notify(DIGITAL_IMAGING, "ssdp:alive", &location).as_bytes(),
                    notify_to,
                )
                .unwrap();
            responder.send_to(b"garbage", notify_to).unwrap();
        });
        let found = run_discovery(
            Some(listener),
            Some(searcher),
            search_to,
            Duration::from_millis(1500),
            DISCOVERY_BUDGET,
            Vec::new(),
        );
        camera.join().unwrap();
        assert_eq!(rx.recv().unwrap(), m_search());
        assert_eq!(found.hint, None);
        assert_eq!(found.cameras.len(), 1);
        let c = &found.cameras[0];
        assert_eq!(c.address, Some(Ipv4Addr::LOCALHOST));
        assert_eq!(c.friendly_name, "ILCE-7CM2");
        assert_eq!(c.model, "ILCE-7CM2");
        assert_eq!(c.model_name, "SonyImagingDevice");
        assert_eq!(c.firmware, "2.01");
        assert_eq!(c.ssh, Some(true));
        assert_eq!(c.max_age, Some(1800));
        assert!(found.departed.is_empty());
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /dd.xml HTTP/1.1\r\nHost: 127.0.0.1:"));
        assert!(requests[1].starts_with("GET /DigitalImagingDesc.xml HTTP/1.1"));
    }

    fn sighting(last: u8, udn: &str, max_age: Option<u64>) -> WifiCamera {
        WifiCamera {
            address: Some(Ipv4Addr::new(192, 168, 1, last)),
            udn: udn.into(),
            friendly_name: "ILCE-7CM2".into(),
            manufacturer: String::new(),
            model_name: String::new(),
            model: "ILCE-7CM2".into(),
            firmware: String::new(),
            server_version: String::new(),
            pairing_required: None,
            ssh: None,
            max_age,
        }
    }

    #[test]
    fn sightings_lapse_and_goodbyes_retire_all_but_kept_cameras() {
        let t0 = Instant::now();
        let secs = |s| t0 + Duration::from_secs(s);
        let mut state = WifiState::default();
        state.merge(
            &[
                sighting(10, "uuid:a", Some(60)),
                sighting(11, "uuid:b", None),
                sighting(12, "uuid:c", Some(60)),
                sighting(13, "uuid:d", None),
            ],
            &[],
            t0,
        );
        state
            .candidates
            .get_mut("wifi:192.168.1.12")
            .unwrap()
            .responder_guid = Some([7; 16]);
        state
            .passwords
            .insert("wifi:192.168.1.10".into(), "secret".into());

        state.prune(secs(59), None);
        assert_eq!(state.candidates.len(), 4);
        assert!(state.candidates.values().all(|c| c.discovered));

        state.prune(secs(61), None);
        assert!(!state.candidates.contains_key("wifi:192.168.1.10"));
        assert!(!state.passwords.contains_key("wifi:192.168.1.10"));
        let remembered = &state.candidates["wifi:192.168.1.12"];
        assert!(
            !remembered.discovered,
            "a remembered camera stays, no longer discovered"
        );
        assert!(
            state.candidates["wifi:192.168.1.11"].discovered,
            "UPnP's default max-age"
        );

        // A goodbye retires at once, except the camera the shoot is connected to.
        state.merge(&[], &["uuid:b".into(), "uuid:d".into()], secs(62));
        state.prune(secs(62), Some("wifi:192.168.1.11"));
        assert!(!state.candidates.contains_key("wifi:192.168.1.13"));
        assert!(!state.candidates["wifi:192.168.1.11"].discovered);

        // A camera that announces itself again is listed again.
        state.merge(&[sighting(13, "uuid:d", Some(60))], &[], secs(63));
        state.prune(secs(64), None);
        assert!(state.candidates["wifi:192.168.1.13"].discovered);
    }

    #[test]
    fn auto_never_assumes_plaintext_and_keeps_an_ssh_pin() {
        let camera = |advertised, auth| {
            let mut c = WifiCandidate::new(Ipv4Addr::new(192, 168, 1, 20), "uuid:x");
            c.ssh_advertised = advertised;
            c.auth = auth;
            c
        };
        use WifiAuth::*;
        // (advertised, earlier choice, pinned, Auto's route; None asks the photographer)
        let cases = [
            (Some(true), Unknown, false, Some(Ssh)),
            (Some(true), Plain, false, Some(Ssh)),
            (Some(false), Unknown, false, None),
            (Some(false), Plain, false, Some(Plain)),
            (Some(false), Ssh, false, None),
            (Some(false), Unknown, true, None),
            (None, Unknown, false, None),
            (None, Unknown, true, Some(Ssh)),
            (None, Ssh, false, Some(Ssh)),
            (None, Plain, false, Some(Plain)),
        ];
        for (advertised, auth, pinned, want) in cases {
            let got = auto_auth(&camera(advertised, auth), pinned).ok();
            assert_eq!(got, want, "{advertised:?} {auth:?} pinned={pinned}");
        }
        let confirm = auto_auth(&camera(Some(false), Unknown), false).unwrap_err();
        assert!(confirm.contains("without SSH"), "{confirm}");
    }

    #[test]
    fn connect_failures_say_whether_the_network_or_the_camera_refused() {
        let cases = [
            (ErrorKind::PermissionDenied, Reach::Denied),
            (ErrorKind::ConnectionRefused, Reach::Refused),
            (ErrorKind::HostUnreachable, Reach::Unreachable),
            (ErrorKind::NetworkUnreachable, Reach::Unreachable),
            (ErrorKind::TimedOut, Reach::Unreachable),
            (ErrorKind::ConnectionReset, Reach::Other),
        ];
        for (kind, want) in cases {
            assert_eq!(reach(kind), want, "{kind:?}");
        }
    }

    #[test]
    fn an_attached_route_keeps_its_pin_and_body() {
        let dir = std::env::temp_dir().join(format!(
            "photocull-route-{}-{}",
            std::process::id(),
            nanos()
        ));
        let known = dir.join("known_hosts");
        let mut camera = WifiCandidate::new(Ipv4Addr::new(192, 168, 1, 30), "uuid:r");
        camera.auth = WifiAuth::Ssh;
        camera.username = Some("photographer".into());
        let key = |blob: &str| HostKey {
            key_type: "ssh-ed25519".into(),
            blob: blob.into(),
            fingerprint: String::new(),
        };
        assert!(matches!(
            AttachedWifiRoute::attach(&camera, &known),
            Err(SshError::HostKey(_))
        ));
        pin_host_key(&known, &camera.alias, &key("AAAAfirst")).unwrap();
        pin_host_key(&known, &host_alias("other"), &key("AAAAother")).unwrap();
        let mut route = AttachedWifiRoute::attach(&camera, &known).unwrap();
        route.responder_guid = Some([3; 16]);
        route.model = "ILCE-7CM2".into();
        assert_eq!(
            route.pinned_host_key,
            [("ssh-ed25519".into(), "AAAAfirst".into())]
        );
        assert!(route.check_pin(&known).is_ok());

        pin_host_key(&known, &camera.alias, &key("AAAAsecond")).unwrap();
        assert!(matches!(route.check_pin(&known), Err(SshError::HostKey(_))));

        assert!(route.same_body("ILCE-7CM2 ", Some([3; 16])));
        assert!(!route.same_body("ILCE-7CM2", Some([4; 16])));
        assert!(!route.same_body("ILCE-7CM2", None));
        assert!(!route.same_body("ILCE-7M4", Some([3; 16])));
        let unverified = AttachedWifiRoute {
            responder_guid: None,
            ..route.clone()
        };
        assert!(!unverified.same_body("ILCE-7CM2", None));

        camera.auth = WifiAuth::Plain;
        let plain = AttachedWifiRoute::attach(&camera, &known).unwrap();
        assert!(plain.pinned_host_key.is_empty());
        assert!(plain.check_pin(&known).is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn silent_descriptions_share_one_deadline_and_a_byebye_retires_its_camera() {
        // Three announced cameras whose description servers accept and never answer.
        let silent: Vec<TcpListener> = (0..3)
            .map(|_| TcpListener::bind("127.0.0.1:0").unwrap())
            .collect();
        let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
        let to = listener.local_addr().unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        for (i, l) in silent.iter().enumerate() {
            let location = format!("http://127.0.0.1:{}/dd.xml", l.local_addr().unwrap().port());
            let alive = notify(DIGITAL_IMAGING, "ssdp:alive", &location)
                .replace("0123456789ab", &format!("00000000000{i}"));
            sender.send_to(alive.as_bytes(), to).unwrap();
        }
        let gone = notify(DIGITAL_IMAGING, "ssdp:byebye", "http://127.0.0.1:1/dd.xml")
            .replace("0123456789ab", "0000000000ff");
        sender.send_to(gone.as_bytes(), to).unwrap();
        let nowhere = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let began = Instant::now();
        let found = run_discovery(
            Some(listener),
            None,
            nowhere,
            Duration::from_millis(300),
            Duration::from_millis(1000),
            Vec::new(),
        );
        assert!(
            began.elapsed() < Duration::from_millis(1800),
            "{:?}",
            began.elapsed()
        );
        assert!(found.cameras.is_empty());
        assert_eq!(
            found.departed,
            ["uuid:00000000-0000-1010-8000-0000000000ff"]
        );
        drop(silent);
    }

    #[test]
    fn an_empty_window_or_missing_sockets_give_an_empty_list_with_a_hint() {
        let quiet = UdpSocket::bind("127.0.0.1:0").unwrap();
        let nowhere = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let began = Instant::now();
        let found = run_discovery(
            Some(quiet),
            None,
            nowhere,
            Duration::from_millis(300),
            DISCOVERY_BUDGET,
            Vec::new(),
        );
        assert!(began.elapsed() < Duration::from_secs(2));
        assert!(found.cameras.is_empty());
        assert!(found.hint.unwrap().contains("IP address"));
        let found = run_discovery(
            None,
            None,
            nowhere,
            Duration::from_millis(300),
            DISCOVERY_BUDGET,
            vec!["listening on UDP 1900 failed: in use".into()],
        );
        assert!(found.cameras.is_empty());
        assert!(found.hint.unwrap().contains("Local Network"));
    }

    #[test]
    fn http_reads_are_bounded_and_redirects_stay_on_the_host() {
        let deadline = || Instant::now() + Duration::from_secs(5);
        let serve = |reply: String| {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = l.local_addr().unwrap();
            let h = thread::spawn(move || {
                let (mut s, _) = l.accept().unwrap();
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(reply.as_bytes());
            });
            (parse_url(&format!("http://{addr}/dd.xml")).unwrap(), h)
        };
        let (url, h) = serve(
            "HTTP/1.1 302 Found\r\nLocation: http://10.9.9.9/dd.xml\r\nContent-Length: 0\r\n\r\n"
                .into(),
        );
        assert!(http_get(&url, deadline())
            .unwrap_err()
            .contains("another host"));
        h.join().unwrap();
        let (url, h) = serve(format!(
            "HTTP/1.1 200 OK\r\n\r\n{}",
            "x".repeat(MAX_HTTP_RESPONSE)
        ));
        assert!(http_get(&url, deadline())
            .unwrap_err()
            .contains("too large"));
        h.join().unwrap();
        let (url, h) = serve("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef".into());
        assert_eq!(http_get(&url, deadline()).unwrap(), b"abc");
        h.join().unwrap();
        // A server that never answers ends at the deadline.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = parse_url(&format!("http://{}/dd.xml", l.local_addr().unwrap())).unwrap();
        let began = Instant::now();
        assert!(http_get(&url, Instant::now() + Duration::from_millis(300)).is_err());
        assert!(began.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn chunked_bodies_decode_only_when_complete_and_never_overflow() {
        assert_eq!(dechunk(b"3\r\nabc\r\n0\r\n\r\n").unwrap(), b"abc");
        assert_eq!(
            dechunk(b"4\r\nWiki\r\n5;x=y\r\npedia\r\n0\r\nExpires: 0\r\n\r\n").unwrap(),
            b"Wikipedia"
        );
        for bad in [
            &b"5\r\nabc\r\n0\r\n\r\n"[..],
            b"3\r\nabc\r\n0\r\n",
            b"3\r\nabc\r\n0",
            b"3\r\nabc\r\n",
            b"3\r\nabcXY0\r\n\r\n",
            b"FFFFFFFFFFFFFFFF\r\nabc\r\n0\r\n\r\n",
            b"FFFFFFFFFFFFFFFE\r\n",
            b"FFFFFFFFFFFFFFFFF\r\nabc\r\n",
            b"zz\r\n",
            b"",
        ] {
            assert!(dechunk(bad).is_none(), "{bad:?}");
        }
        // Every prefix of a valid body, and arbitrary bytes, decode to nothing or stop cleanly.
        let body = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        for n in 0..body.len() {
            assert!(dechunk(&body[..n]).is_none(), "{n}");
        }
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..2000 {
            let len = (seed % 48) as usize;
            let bytes: Vec<u8> = (0..len)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    let alphabet = b"0123456789abcdefF\r\n;x";
                    alphabet[(seed % alphabet.len() as u64) as usize]
                })
                .collect();
            let _ = dechunk(&bytes);
        }
    }

    #[test]
    fn the_initiator_guid_is_a_persistent_v4_uuid() {
        let dir =
            std::env::temp_dir().join(format!("photocull-guid-{}-{}", std::process::id(), nanos()));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let dir = dir.clone();
                thread::spawn(move || initiator_guid(&dir).unwrap())
            })
            .collect();
        let guids: Vec<[u8; 16]> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(
            guids.iter().all(|g| *g == guids[0]),
            "racing creators agree"
        );
        let guid = guids[0];
        assert_eq!(guid[6] >> 4, 4);
        assert_eq!(guid[8] >> 6, 0b10);
        assert_eq!(initiator_guid(&dir).unwrap(), guid);
        let text = fs::read_to_string(dir.join("tether/initiator-guid.txt")).unwrap();
        assert_eq!(parse_uuid(text.trim()), Some(guid));
        assert_eq!(
            fs::read_dir(dir.join("tether")).unwrap().count(),
            1,
            "no temp files left"
        );
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            format_uuid(&parse_uuid("4f2a9103-c755-4e10-8b61-02d4ee379a18").unwrap()),
            "4f2a9103-c755-4e10-8b61-02d4ee379a18"
        );
    }

    #[test]
    fn host_keys_match_openssh_fingerprints_and_pin_per_alias() {
        assert_eq!(
            base64_encode(&sha256(b"abc"), true),
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
        );
        assert_eq!(base64_encode(&sha256(&[0x61; 1000]), false).len(), 43);
        // Expected fingerprints from ssh-keygen -lf.
        let scan = "# 192.168.122.1:22 SSH-2.0-OpenSSH_7.9\n\
            192.168.122.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINWpPvz3eV7EybknSpKFhjTqpuk1gQf0eOWhRRlmSkLA\n\
            192.168.122.1 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBBFbJxmk2zs9bhAOuLYT48bSqZrSK8elul4MsImGffuKgiLCJHyXkyKOCisS+snQ6Y0RuqYrjUlt1IGkBFM1TZk=\n\
            192.168.122.1 ssh-rsa !!notbase64\n";
        let keys = parse_keyscan(scan);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].key_type, "ecdsa-sha2-nistp256");
        assert_eq!(
            keys[0].fingerprint,
            "SHA256:Dy/+Eg1tO3tGrl+0QLNrJB7TT30aocbqj6iUQP+6U2U"
        );
        assert_eq!(
            keys[1].fingerprint,
            "SHA256:qgwfei5JpRGTHBufiKr0cQqQtHU4hbIMxO3NBH1pEeg"
        );

        let dir =
            std::env::temp_dir().join(format!("photocull-kh-{}-{}", std::process::id(), nanos()));
        let known = dir.join("known_hosts");
        let alias = host_alias("uuid:00000000-0000-1010-8000-0123456789AB");
        assert_eq!(
            alias,
            "photocull-camera-uuid-00000000-0000-1010-8000-0123456789ab"
        );
        assert_eq!(
            check_host_key(&known, &alias, &keys).unwrap(),
            HostKeyStatus::Unverified(keys[0].clone())
        );
        pin_host_key(&known, "photocull-camera-other", &keys[1]).unwrap();
        pin_host_key(&known, &alias, &keys[1]).unwrap();
        pin_host_key(&known, &alias, &keys[0]).unwrap();
        let text = fs::read_to_string(&known).unwrap();
        assert_eq!(text.lines().count(), 2, "one pin per alias: {text}");
        assert_eq!(
            check_host_key(&known, &alias, &keys).unwrap(),
            HostKeyStatus::Verified
        );
        assert_eq!(
            check_host_key(&known, &alias, &keys[1..]).unwrap(),
            HostKeyStatus::Changed(keys[1].clone())
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    fn target(known: &str) -> SshTarget {
        SshTarget {
            address: Ipv4Addr::new(192, 168, 1, 40),
            username: "Ab3xY9".into(),
            alias: "photocull-camera-x".into(),
            known_hosts: PathBuf::from(known),
        }
    }

    #[test]
    fn ssh_arguments_forward_to_literal_localhost() {
        let args = ssh_args(
            &target("/Users/a/Library/Application Support/50%/known_hosts"),
            25740,
            Path::new("/tmp/photocull-ctl-1%/c"),
        )
        .unwrap();
        let pos = |s: &str| {
            args.iter()
                .position(|a| a == s)
                .unwrap_or_else(|| panic!("{s}"))
        };
        assert_eq!(
            &args[..11],
            [
                "-F",
                "/dev/null",
                "-N",
                "-T",
                "-M",
                "-S",
                "/tmp/photocull-ctl-1%%/c",
                "-p",
                "22",
                "-c",
                "aes128-ctr"
            ]
        );
        assert!(!args
            .iter()
            .any(|a| a.starts_with("ControlMaster") || a.starts_with("ControlPath")));
        assert_eq!(args[pos("-L") + 1], "127.0.0.1:25740:localhost:15740");
        assert!(!args.iter().any(|a| a.contains("127.0.0.1:15740")));
        assert_eq!(args.last().unwrap(), "Ab3xY9@192.168.1.40");
        for option in [
            "ExitOnForwardFailure=yes",
            "StrictHostKeyChecking=yes",
            "UserKnownHostsFile=\"/Users/a/Library/Application Support/50%%/known_hosts\"",
            "HostKeyAlias=photocull-camera-x",
            "ControlPersist=no",
        ] {
            assert_eq!(args[pos(option) - 1], "-o");
        }
        let mut bad = target("/tmp/known_hosts");
        bad.username = "-oProxyCommand=x".into();
        let control = Path::new("/tmp/c");
        assert!(ssh_args(&bad, 1, control).is_err());
        assert!(ssh_args(&target("/tmp/\"q/known_hosts"), 1, control).is_err());
        assert_eq!(
            askpass_script(Path::new("/a b/it's/secret")),
            "#!/bin/sh\nexec /bin/cat -- '/a b/it'\\''s/secret'\n"
        );
        assert!(matches!(
            classify("Host key verification failed."),
            SshError::HostKey(_)
        ));
        assert!(matches!(
            classify("cam@1.2.3.4: Permission denied (password)."),
            SshError::Authentication(_)
        ));
        assert!(
            matches!(classify("bind [127.0.0.1]:25740: Address already in use"), SshError::Failed(m) if m == "local port in use")
        );
        assert!(matches!(
            classify("ssh: connect to host 1.2.3.4 port 22: Connection refused"),
            SshError::Unreachable(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn the_tunnel_reads_the_password_once_waits_for_its_master_and_reaps_ssh() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("photocull-ssh-{}-{}", std::process::id(), nanos()));
        fs::create_dir_all(&dir).unwrap();
        let report = dir.join("report");
        // Stands in for OpenSSH: the master records what reached it, asks twice, then holds the
        // forward with its control socket in place; `-O check` and `-O exit` talk to that socket.
        let fake = dir.join("ssh");
        let script = |master: &str| {
            format!(
                "#!/bin/sh\nr='{}'\nall=\"$*\"\ns=''\nprev=''\n\
                 for a in \"$@\"; do [ \"$prev\" = -S ] && s=\"$a\"; prev=\"$a\"; done\n\
                 case \"$all\" in\n\
                 *'-O check'*) [ -e \"$s\" ] && exit 0; exit 255;;\n\
                 *'-O exit'*) echo \"exit $all\" >> \"$r\"; exit 0;;\n\
                 esac\n\
                 echo \"pid=$$\" >> \"$r\"\n{master}",
                report.display()
            )
        };
        fs::write(
            &fake,
            script(
                "case \"$all\" in *s3cret*) echo args-leak >> \"$r\";; esac\n\
                 env | grep -q s3cret && echo env-leak >> \"$r\"\n\
                 case \"$all\" in *'-M -S'*'ControlPersist=no'*) echo master >> \"$r\";; esac\n\
                 echo \"require=$SSH_ASKPASS_REQUIRE display=$DISPLAY\" >> \"$r\"\n\
                 echo \"first=$(\"$SSH_ASKPASS\" 'Password:')\" >> \"$r\"\n\
                 \"$SSH_ASKPASS\" 'Password:' >/dev/null 2>&1 && echo second-read >> \"$r\"\n\
                 sleep 0.3\n: > \"$s\"\nexec sleep 30\n",
            ),
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let private = dir.join("private");
        let gone =
            |pid: &str| !Path::new(&format!("/proc/{pid}")).exists() || !cfg!(target_os = "linux");
        let pid_of = |text: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix("pid="))
                .unwrap()
                .to_string()
        };
        let idle = AtomicBool::new(false);
        let mut tunnel = SshTunnel::start_with(
            &fake,
            &target("/tmp/kh"),
            "s3cret",
            &private,
            Duration::from_secs(10),
            &idle,
        )
        .unwrap();
        assert!(tunnel.is_alive());
        assert_eq!(tunnel.local_addr().ip().to_string(), "127.0.0.1");
        let report_text = fs::read_to_string(&report).unwrap();
        let pid = pid_of(&report_text);
        assert_eq!(
            report_text,
            format!("pid={pid}\nmaster\nrequire=force display=photocull\nfirst=s3cret\n")
        );
        assert!(
            fs::read_dir(&private).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("askpass")),
            "askpass files removed"
        );
        drop(tunnel);
        assert!(fs::read_to_string(&report)
            .unwrap()
            .ends_with("-O exit Ab3xY9@192.168.1.40\n"));
        assert!(gone(&pid), "ssh reaped");
        assert_eq!(
            fs::read_dir(&private).unwrap().count(),
            0,
            "control socket removed"
        );

        // Disconnecting while the master is still signing in stops it at once.
        fs::write(&report, "").unwrap();
        fs::write(
            &fake,
            script("\"$SSH_ASKPASS\" 'Password:' >/dev/null\nexec sleep 30\n"),
        )
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::SeqCst);
        });
        let began = Instant::now();
        let err = SshTunnel::start_with(
            &fake,
            &target("/tmp/kh"),
            "s3cret",
            &private,
            Duration::from_secs(20),
            &cancel,
        )
        .err()
        .unwrap();
        stopper.join().unwrap();
        assert!(matches!(err, SshError::Cancelled), "{err:?}");
        assert!(began.elapsed() < Duration::from_secs(3));
        assert!(gone(&pid_of(&fs::read_to_string(&report).unwrap())));
        assert_eq!(fs::read_dir(&private).unwrap().count(), 0);

        // A failing ssh reports a classified error and leaves nothing behind.
        fs::write(
            &fake,
            "#!/bin/sh\necho 'cam@1.2.3.4: Permission denied (password).' >&2\nexit 255\n",
        )
        .unwrap();
        let err = SshTunnel::start_with(
            &fake,
            &target("/tmp/kh"),
            "s3cret",
            &private,
            Duration::from_secs(10),
            &idle,
        )
        .err()
        .unwrap();
        assert!(matches!(err, SshError::Authentication(_)), "{err:?}");
        assert_eq!(fs::read_dir(&private).unwrap().count(), 0);
        fs::remove_dir_all(&dir).unwrap();
    }
}

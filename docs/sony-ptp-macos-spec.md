# Sony α7 III and α7C II USB tethering on macOS

**Engineering decision.** Build the Sony session engine in PhotoCull’s Rust shell. Use Apple ImageCaptureCore (ICC) for the first macOS implementation, with a single command in flight per camera. Negotiate the Sony protocol on every open. Transfer queued photos ahead of preview frames. Keep a transaction-level transport interface so Linux tests can exercise the same state machine and a direct-USB adapter can be evaluated independently.

**What is verified.** An α7 III firmware 4.0 USB trace supplies actual command, data, response and event bytes. Its full property data container is 1,709 bytes. Decoding its 60 records consumes the final byte exactly. For the α7C II, a firmware 2.01 USB report confirms the control PID, successful capture and preview. A second 2.01 bench report compares USB PC Remote DeviceInfo with PTP/IP and publishes a 970-byte **PTP/IP** Sony capability dataset. Its version is 300, with 421 property codes and 59 control codes. Sony’s *Camera Control PTP 2* and *PTP 3* references specify the two profiles. One material discrepancy is the single enumeration list in the α7 III capture, where the PTP 2 reference shows two. Neither bench establishes ICC RAW throughput, frame rate, or system-process ownership for both bodies on macOS 13, 14 and 15. The acceptance tests below identify the missing measurements. [α7 III wire trace][M3wire] · [α7C II USB report][CM2usb] · [α7C II bench][bench] · [binary capability dataset][CM2caps] · [Sony PTP 2][S2] · [Sony PTP 3][S3]

## Device selection and camera setup

| Body | Sony USB VID:PID in PC Remote | PTP identity and mode discrimination |
|---|---|---|
| α7 III | **054c:0c34**, observed in the 4.0 trace on configuration 1, interface 0, alternate 0, with bulk IN 81, bulk OUT 02 and interrupt IN 83. libgphoto2 also lists **054c:096f**. | Manufacturer `Sony Corporation`, Model `ILCE-7M3`. The published 096f “control” descriptor actually shows an HID interface (03/00/00, interrupt IN only). That attachment cannot carry PTP bulk. Another field report sees 096f before the user selects a connection mode. Mass Storage 0c02 and MTP 0c03 are reported separately. [0c34 observation][pidm3] · [096f descriptor][hid] · [PID discussion][pidissue] · [USB trace][M3wire] |
| α7C II | **054c:0e8c** | Manufacturer `Sony Corporation`, Model `ILCE-7CM2`. Firmware 2.01 MTP was observed as 054c:0e8b. Both modes can identify as cameras. The PC Remote DeviceInfo has Sony extension 0x00000011 and Sony remote operations. The bench found 81 operations, 48 events and zero initial device property codes in that mode. [USB identification and capture][CM2usb] · [mode comparison][bench] |

Inspect **interface descriptors**, including alternate settings, when using USB directly. Match VID 054c and Still Image class/subclass/protocol 06/01/01, with bulk OUT, bulk IN and interrupt IN. Discover endpoint addresses, interface number, alternate setting and maximum packet sizes. ICC provides transport type, vendor ID and product ID but abstracts endpoint descriptors. There, select a local USB camera with the raw PTP capability. Read DeviceInfo, match the model and Sony operations, then complete the Sony handshake. Permit an unknown PID for a known model that passes these checks. A sibling body can be identified and probed read-only before enabling controls supported by its own descriptors. A mounted volume, HID, UVC stream or an MTP catalog alone cannot establish PC Remote readiness. [USB class definition §§6–7][USB] · [Apple ICDevice][device] · [Sony control profiles][lib]

| Setting | α7 III, classic menu | α7C II, current menu |
|---|---|---|
| USB remote shooting | MENU → Network → Ctrl w/ Smartphone → Ctrl w/ Smartphone → Off. MENU → Setup → USB Connection → PC Remote. | Disconnect any active smartphone session. MENU → Setup → USB → USB Connection Mode → **PC Remote**, or choose **Sel. When Connect** and select **Remote Shoot (PC Remote)** in the plug-in prompt. Use the USB-C terminal and a data cable. The Network → Cnct./PC Remote → PC Remote Function → PC Remote → On procedure is documented for network connections. Sony’s USB procedure specifies the USB mode selection. |
| Photo destination | Before starting remote shooting, MENU → Setup → PC Remote Settings → Still Img. Save Dest. → **PC Only** or **PC+Camera**. Sony locks this menu during PC Remote shooting. | MENU → Network → Cnct./PC Remote → Remote Shoot Setting → Still Img. Save Dest. → **Destination Only**, **Dest.+Camera** or **Camera Only**. Camera Only disables host-file expectations. |
| RAW and JPEG | Select RAW & JPEG under Camera Settings1 → File Format. Before starting remote shooting, Setup → PC Remote Settings → RAW+J PC Save Img → RAW & JPEG, JPEG Only or RAW Only. | MENU → Shooting → Image Quality/Rec → File Format → RAW & JPEG. Under Remote Shoot Setting → RAW+J Save Image choose RAW & JPEG, JPEG Only or RAW Only for Dest.+Camera. Save Image Size → Original avoids the 2M JPEG transfer. RAW+H Save Image is the corresponding HEIF control. |
| Power and media | MENU → Setup → USB Power Supply → On as desired. Use a writable card for PC+Camera. | MENU → Setup → USB → USB Power Supply → On as desired. Insert a battery. Dest.+Camera and Camera Only require a writable card even with Release w/o Card enabled. |

Selecting Mass Storage/Image Transfer lists stored files. USB Streaming on the α7C II selects video streaming. Re-enumerate after changing mode. Sony’s camera guides give the exact menu text and conditions. [M3 USB][m3menu] · [M3 destination][m3dest] · [M3 file selection][m3format] · [M3 power][m3power] · [CM2 USB][cm2menu] · [CM2 connection][cm2connect] · [CM2 file format][cm2format] · [CM2 remote settings][cm2dest] · [CM2 power][cm2power]

## macOS transport and ownership

| Path | Who owns the USB transaction | Engineering consequence |
|---|---|---|
| ImageCaptureCore | macOS mediates the device, session, transfers and events. PhotoCull submits one complete PTP command and optional outbound dataset. | Best first implementation for a normally signed-in user. Sony vendor commands, Sony shutter actions, capture-object reads and viewfinder reads have a macOS ICC implementation precedent in INDIGO. Apple publishes no Sony opcode allowlist, guaranteed per-command byte limit, performance SLA, or process-launch matrix. Check the runtime capability, errors and PTP response. [Apple][ICC] · [command API][send] · [Mac command implementation][ICA] · [Mac Sony operations][ICASony] |
| nusb | The app opens the device/interface through IOKit and owns packet framing, endpoints, events, timeouts and buffer management. | Can stream directly to a file and measure USB packet boundaries. The inspected macOS backend calls **USBDeviceOpen** and **USBInterfaceOpen**. Its detach-and-claim method just claims. The existence of an OpenSeize function pointer in the bindings gives no automatic takeover. A busy interface can fail with exclusive access even after successful enumeration. nusb is MIT OR Apache-2.0. [IOKit calls][nusb] · [macOS claim implementation][nusbclaim] |
| rusb/libusb | Rust wrapper around native libusb. Darwin libusb tries **USBDeviceOpenSeize** at the device level, tolerates exclusive access for some device-level operations, then calls **USBInterfaceOpen** for the claim. | A device handle does not imply an interface claim. Darwin kernel-driver detach may re-enumerate/capture the **device** and needs privileges or an appropriate entitlement. Detaching a kernel driver and freeing another user-space client are different operations. Adds a native LGPL distribution dependency. [Darwin backend][libusb] · [libusb license][libusblic] |

**Contention.** macOS can attach its Image Capture PTP service to a still-image interface and mediate sessions for clients. `PTPCamera` is the historical name, and `ptpcamerad` appears in contemporary implementations. Apple’s contract is with `ICDeviceBrowser` and `ICCameraDevice`. It does not define that a particular executable launches at plug-in, opens first or remains attached on every 13–15+ build. A foreground importer or another tethering client can change the outcome. An ICC client can use the broker while it is running. There is no documented entitlement or ICC call that evicts all other clients. On the direct path, device seize and interface seize have different scopes. Even an explicit `USBInterfaceOpenSeize` is an acquisition attempt, whose return value and subsequent interface state must be checked. A real direct-USB project reports exclusive access and inconsistent release by an established holder. PhotoCull should surface “camera in use”, offer a normal reconnect after the other client closes, and leave system services running. [Apple discovery][browser] · [libgphoto2 claim path][gpusb] · [direct IOKit observations][contention]

**What other apps demonstrate.** darktable opens the camera with libgphoto2; the USB backend checks for a kernel driver, attempts detach where applicable, then claims the interface and names macOS PTPCamera as a possible source of failure. Capture One’s model table reports tethered shooting and Live View for both targets. Sony Imaging Edge documents quitting competing remote or online-storage clients, waiting about a minute, and relaunching Remote. Sony also documents a Local Network setting for its Mac application on 15+ and USB-interference issues on macOS 26. These are application-specific support instructions. No public implementation evidence reviewed here establishes that Capture One or Imaging Edge uses ICC, seizes this interface, terminates a daemon, or uses the same backend for both bodies. [darktable code][dt] · [gphoto2 USB backend][gpusb] · [Capture One supported models][c1] · [Sony Remote troubleshooting][sonyfaq]

**Fallback selection.** Ship the ICC adapter first. If a native bench exposes a reproducible ICC limitation, qualify nusb as an explicitly selected alternate transport. Stop the ICC dispatcher, await session closure, unregister callbacks, increment the generation, then acquire the free USB interface and start a new PTP session. If the interface remains busy, report that state. Do not switch transports during a shutter press or an indeterminate file transfer. There is no dual-owner mode.

### ICC contract for the Rust adapter

1. Under `#[cfg(target_os = "macos")]`, use objc2 with the Foundation and ImageCaptureCore bindings, or a small ARC Objective-C adapter compiled and linked only on macOS. Own the browser, delegates and retained camera objects on the app main run loop. Set the browser delegate **before** `start`, browse local cameras, set the camera delegate, register event handling, then `requestOpenSession`. Wait for session-open success. The ICC open/close operations own the PTP session lifecycle. A complete file catalog is unnecessary for vendor commands. Check `ICCameraDeviceCanAcceptPTPCommands`. Apple deprecated `requestEnableTethering` in macOS 14 for the standard take-picture path. It does not perform Sony SDIO negotiation. [Browser start][start] · [camera SDK header][header] · [Apple ICDevice][device]
2. Preferred selector on macOS 10.15+ is `requestSendPTPCommand:outData:completion:`. The older full selector is `requestSendPTPCommand:outData:sendCommandDelegate:didSendCommandSelector:contextInfo:`. Its callback is `didSendPTPCommand:inData:response:error:contextInfo:`. Command NSData contains the **entire type-1 command container**, length 12–32. INDIGO passes zero at byte 8. Use zero as the ICC placeholder and correlate with a local request token and the callback. The framework can renumber transactions. A real ICC α7C II iPhone MTP trace returned TID 801 for caller TID 1. Direct bulk, by contrast, checks the actual wire TID. [Apple command API][send] · [Mac command serialization and callbacks][ICA] · [bench, pass-through reply layout][bench]
3. For data-in or no-data operations pass `nil` as outData. For data-out pass only the encoded value bytes. Direction is implicit in the operation and the presence of outbound data. At completion the **first** NSData is the inbound dataset/file bytes and the **second** is the PTP response container. Validate length, type 3, response code and any u32 parameters. Preserve NSError domain/code separately. Missing or malformed response is a transport failure even when NSError is nil. Skip 12 bytes only on an actual container. In particular, write byte zero of an inbound ARW to byte zero of its destination. [Header][header] · [INDIGO ICC][ICA] · [measured callback layout][bench]
4. On macOS 12+, `ptpEventHandler` takes precedence over the delegate. Otherwise use `cameraDevice:didReceivePTPEvent:`. Both deliver event NSData. Validate type 4 and length, enqueue the event and return. Never issue a synchronous camera command from an event or completion callback. An event can arrive before a command completes. [Header, PTP interaction][header]
5. ICC hands back one NSData for the entire data phase. `NSData.length` is an NSUInteger (64-bit on Apple Silicon). Preserve it as a checked usize/u64. The classic PTP length fields are still u32. A 30–60 MB object fits these fields. There is no streaming callback, configurable timeout, caller-supplied receive buffer or published promise of 30 fps on this selector. Retain the completed NSData while a worker writes its bytes to the open destination, use bounded slices and release it promptly. Avoid an extra Vec, JSON/base64, main-thread disk I/O and a queued frame backlog. A host deadline stops new work; it cannot cancel an already submitted request by dropping its Rust future. Quarantine that session until completion or confirmed teardown. Raw throughput, timeout and peak memory need measurements from the packaged app on the two cameras. [API signature][send] · [Mac implementation][ICA]
6. Use `requestCloseSession` for an orderly stop. Invalidate the attachment generation on removal or reset, fail pending callers once, and discard stale callbacks by token. A newly discovered device needs fresh delegates, a fresh session and a fresh handshake. [ICDevice][device]

### Permissions, signing and packaging

Apple explicitly prescribes **Hardened Runtime + `com.apple.security.personal-information.photos-library` = true** for macOS ICC import/tethering, and **`com.apple.security.device.usb` = true for sandboxed apps on macOS 14+**. PhotoCull’s existing ad-hoc package uses bundle ID `app.photocull.desktop`, minimum macOS 11 and an entitlements file containing JIT/library exceptions. It currently declares neither App Sandbox nor the Photos Library entitlement. Merge the required entitlement into the shell’s signing configuration when implementing. Preserve the existing sidecar’s signing requirements. Weak-link or availability-check newer selectors (in particular the macOS 12 event block), or scope the tether feature to its verified deployment range. [Apple’s platform-specific configuration][ICC] · [Photos Library entitlement][photosent] · [USB entitlement][usbent] · [bundle configuration](../src-tauri/tauri.bundle.conf.json) · [current entitlements](../assets/entitlements.mac.plist)

Apple’s ICC overview prescribes `NSCameraUsageDescription` specifically for **iOS** tethering. Native macOS `requestControlAuthorization` and `requestContentsAuthorization` on ICDeviceBrowser are unavailable. Apple prescribes `NSCameraUsageDescription` and the appropriate camera entitlement for protected camera APIs, and `NSPhotoLibraryUsageDescription` for APIs reading/writing the user’s Photos library. Include a truthful camera purpose string in the proposed Mac bundle (“PhotoCull controls your connected camera and downloads the photos you take”). Verify the actual prompts on a fresh user account. USB-to-folder tethering needs neither a PhotoKit library query nor an iOS external-camera entitlement. Removable-volume consent applies independently to a destination on removable media. USB accessory approval on Apple Silicon laptops can allow charging while data access is denied. [ICC configuration][ICC] · [authorization availability][auth] · [camera purpose][camkey] · [Apple camera entitlement][cament] · [Photos purpose][photokey] · [volume privacy][volkey] · [accessory approval][accessory]

Use the same signed .app that customers will launch when testing TCC. Inspect `codesign -d --entitlements :- PhotoCull.app`, check for the runtime flag with `codesign -dv --verbose=4 PhotoCull.app`, and run `codesign --verify --deep --strict PhotoCull.app`. Ad-hoc signing supplies no notarization and overrides no TCC denial, accessory approval or exclusive USB claim. Retest after rebuilding with a changed signature. Keep the photographer’s selected destination and all camera/USB privileges in the shell. [PhotoCull macOS packaging](macos.md) · [Apple ICC requirements][ICC]

### Rust boundary and virtual camera

Proposed internal contract, using static dispatch on the sequential camera worker. `open` and `close` refer to the underlying session, so Sony code never has to guess who sends OpenSession. The adapter binds a discovered device and an event channel at construction. A transaction starts only when the worker has exclusive access. A borrowed file sink lets direct USB stream and lets ICC write retained NSData without forcing a second full-file allocation.

```rust
use std::{io::Write, time::Instant};

struct Operation<'a> {
    opcode: u16,
    params: &'a [u32], // at most five
}

enum DataPhase<'a> {
    None,
    Out(&'a [u8]),
    In { sink: &'a mut (dyn Write + Send), limit: u64 },
}

struct Reply {
    code: u16,
    params: Vec<u32>,
    bytes_in: u64,
}

enum TransportError {
    Removed,
    InUse,
    Permission,
    TimedOut,
    Framing,
    Limit,
    Sink(std::io::Error),
    Native { domain: String, code: i64 },
}

trait PtpTransport {
    async fn open(&mut self, deadline: Instant) -> Result<(), TransportError>;
    async fn transact(
        &mut self,
        request: Operation<'_>,
        phase: DataPhase<'_>,
        deadline: Instant,
    ) -> Result<Reply, TransportError>;
    async fn close(&mut self, deadline: Instant) -> Result<(), TransportError>;
}

enum TransportEvent {
    Ptp { generation: u64, code: u16, params: Vec<u32> },
    Removed { generation: u64 },
    SessionLost { generation: u64 },
}
```

Implement `IccTransport` as a Rust handle to a main-thread Objective-C owner. Send owned command bytes and a oneshot sender to that owner. Retain the completion block and input NSData through completion, and move an owned data handle with a lifetime-safe immutable byte view to the file writer. Never move a borrowed Rust sink into an escaping Objective-C block. Serialize and bounds-check at the transport boundary. Send camera events through a separate channel so a command wait does not block receipt. Coalesce property-dirty notifications and wake the worker on removal even under event pressure. During data-in a direct adapter must finish reading the response or discard the whole session on sink/limit failure. An ICC limit can prevent application copies and writes, but the system may already have allocated the full NSData.

Implement `ScriptedTransport` on all platforms using an ordered queue of expected open/transaction/close steps, byte-exact requests, synthetic datasets/responses, and separately scheduled events/removals. For a virtual capture queue, GetObjectInfo peeks, successful GetObject consumes exactly one head, a second info query sees the next head. A scripted error can also consume the head before the host receives its response. Use a controllable clock for deadlines. Compile only the ICC adapter and its target-specific dependencies on macOS. Keep Sony datasets, state machine and mocks in ordinary target-independent Rust. Expose typed Tauri operations such as connect, change an advertised setting, capture, select destination and disconnect. Give the renderer no raw opcode or arbitrary write-path API. Notify Node of **completed local files** through the existing shell/backend boundary. [Current shell boundary](../src-tauri/src/lib.rs) · [dependency layout](../src-tauri/Cargo.toml)

The ARC adapter's submission call can use the legacy delegate or this completion-block shape. The owner installs the event handler and opens the session before dispatching. Here `finish` is a block copied by the adapter, bound to exactly one generation and request. It retains the returned objects for the Rust worker and posts a completion; it does no file I/O.

```objective-c
typedef void (^PtpCompletion)(NSData *payload, NSData *response, NSError *error);

static void submitCommand(ICCameraDevice *camera, NSData *command,
                          NSData *outPayload, PtpCompletion finish) {
    [camera requestSendPTPCommand:command
                          outData:outPayload
                       completion:^(NSData *payload, NSData *response, NSError *error) {
        finish(payload, response, error);
    }];
}
```

For offline transaction tests, the following is a minimal queue-backed implementation of the trait above. A fixture must specify a separate step for each call, including repeated calls with the same pseudo-handle. Assertion failures identify a state-machine regression. Use the production response parser in adapter framing tests; this mock starts at the decoded transaction boundary.

```rust
use std::collections::VecDeque;

enum ExpectedPhase {
    None,
    Out(Vec<u8>),
    In(Vec<u8>),
}

enum Step {
    Open,
    Transaction {
        opcode: u16,
        params: Vec<u32>,
        phase: ExpectedPhase,
        result: Result<Reply, TransportError>,
    },
    Close,
}

struct ScriptedTransport(VecDeque<Step>);

impl PtpTransport for ScriptedTransport {
    async fn open(&mut self, _: Instant) -> Result<(), TransportError> {
        assert!(matches!(self.0.pop_front(), Some(Step::Open)));
        Ok(())
    }

    async fn transact(
        &mut self,
        request: Operation<'_>,
        phase: DataPhase<'_>,
        _: Instant,
    ) -> Result<Reply, TransportError> {
        let Some(Step::Transaction { opcode, params, phase: expected, result })
            = self.0.pop_front() else { panic!("unexpected PTP transaction") };
        assert_eq!(request.opcode, opcode);
        assert_eq!(request.params, params.as_slice());
        match (expected, phase) {
            (ExpectedPhase::None, DataPhase::None) => {}
            (ExpectedPhase::Out(bytes), DataPhase::Out(sent)) => {
                assert_eq!(sent, bytes.as_slice());
            }
            (ExpectedPhase::In(bytes), DataPhase::In { sink, limit }) => {
                if bytes.len() as u64 > limit {
                    return Err(TransportError::Limit);
                }
                sink.write_all(&bytes).map_err(TransportError::Sink)?;
                if let Ok(reply) = &result {
                    assert_eq!(reply.bytes_in, bytes.len() as u64);
                }
            }
            _ => panic!("unexpected PTP data phase"),
        }
        result
    }

    async fn close(&mut self, _: Instant) -> Result<(), TransportError> {
        assert!(matches!(self.0.pop_front(), Some(Step::Close)));
        Ok(())
    }
}
```

A test driver injects `TransportEvent` into the same actor mailbox used by ICC, advances its clock, and asserts that all steps were consumed and only expected local files were published. For cancellation races, hold a scripted completion until after the driver sends Removed, then deliver it under its old generation.

## PTP/USB framing

All offsets below are byte offsets. All multibyte PTP integers are little-endian. Embedded files retain their own byte order. Fields are packed, with no alignment or native struct padding.

| Offset | Type | Meaning |
|---:|---|---|
| 0 | u32 | Length of this container **including** its 12-byte header |
| 4 | u16 | 1 command, 2 data, 3 response, 4 event |
| 6 | u16 | Operation code in command/data, response code in response, event code in event |
| 8 | u32 | Transaction ID. Same in all bulk phases of the transaction. Asynchronous events may use a sentinel. |
| 12 | bytes | Command/response: zero to five u32 parameters. Event: zero to three u32 parameters. Data: operation-specific dataset or file bytes. |

Bulk OUT takes the command. There is at most one data phase in its specified direction, then a bulk IN response. An error may return a response in place of expected data. The interrupt IN endpoint is independent. Check declared lengths against bytes received, code, type and TID. Check `(length-12) % 4 == 0` only for parameter containers. Short header, mismatched TID or a second command before consuming the response can desynchronize a direct session. Event TID is not a capture correlation key. USB SIC specifies zero when no TID applies, while the M3 trace has 0xffffffff in a C203 event. [USB §§7.1–7.3][USB] · [M3 trace][M3wire]

**Packet termination for direct USB.** A normal bulk phase ends at its declared byte count with a short packet. If the total transfer length is an integral multiple of endpoint maximum packet size, the sender terminates it with a zero-length packet (ZLP). Use the actual endpoint descriptor: bulk high speed 512 bytes, SuperSpeed 1,024 bytes, full speed up to 64. The modulus normally includes the container header, so 500 data bytes + 12 header bytes on a 512-byte endpoint needs a ZLP. A non-final host I/O chunk ending on a packet boundary does not end the phase. Submit packet-aligned intermediate chunks; a host buffer filling exactly does not prove a terminating ZLP was consumed. On IN, allow for a separate terminator before the response. On OUT, send exactly one terminator if required by the actual transfer layout. Some devices separate header and payload transfers. Reassemble the 12-byte header then exactly its declared payload across reads, and handle an observed split-header quirk explicitly. A short 12-byte header read alone cannot complete a declared 40 MB data container. SuperSpeed bursting changes scheduling, not the length calculation. ICC handles all of this below the API. [USB §§7.1–7.2 and errata][USB] · [libgphoto2 USB send/receive implementation][wireusb] · [nusb bulk semantics][nusbdevice]

| Standard operation | Parameters | Phase and relevant result |
|---|---|---|
| 1001 GetDeviceInfo | none | IN DeviceInfo. Can be used outside a session with TID 0. |
| 1002 OpenSession | nonzero session ID, e.g. 1 | No data. Direct sends TID 0. On success use TID 1 for the first in-session command and advance once per operation, including failed operations. |
| 1003 CloseSession | none | No data. Drain an outstanding transaction first. |
| 1008 GetObjectInfo | handle | IN ObjectInfo |
| 1009 GetObject | handle | IN complete object bytes |
| 101B GetPartialObject | handle, byte offset, maximum bytes, each u32 | IN bytes. Response parameter 1 gives actual count. Require advertised support and forward progress. Sony recommends GetObject for throughput. Partial reads of a transient queue head do not establish a resumable/consuming protocol. |

DeviceInfo has u16 standard version at 0, u32 vendor extension ID at 2, u16 vendor extension version at 6, then a PTP string at 8, u16 functional mode and five counted u16 arrays (operations, events, properties, capture formats, display formats), then PTP strings for manufacturer, model, device version and serial number. Each array starts with a u32 element count. Each string starts with a u8 count of UTF-16LE units including its terminating NUL; an empty string may be a single zero byte. Parse fields with a checked cursor. The vendor extension version here (e.g. 100) is independent of the Sony remote protocol version below. [USB string definition][USB] · [DeviceInfo/ObjectInfo parser][pack] · [standard operations and session counter][ptp]

## Sony initialization and descriptor grammar

| Step | α7 III in SDI 2.00 | α7C II in SDI 3.00 |
|---|---|---|
| Open | Direct: open PTP session; ICC: await framework session. Verify DeviceInfo advertises 9201/9202. | Same |
| 1, 2 | 9201(1,0,0), then 9201(2,0,0). Each IN, then OK. | Same. Sony defines the IN dataset as u64. The normal handshake returns eight zero bytes. |
| Negotiate | Firmware 4.0 trace: **9202(0x000000C8)**, one parameter, IN dataset starts `c8 00`. | **9202(0x0000012C)** is the base sequence. Parameter 2 = 1 requests extended property/control codes. Current libgphoto2 offers **9202(0x12C,1)** for all models. |
| 3 | After a successful, nonempty negotiation, 9201(3,0,0), IN then OK. | Same |
| Snapshot | **9209()**, no parameters, IN. | Sony documents **9209(diff,options)**: `(0,0)` full/base, `(0,1)` full/extended, `(1,0)` or `(1,1)` changes only. libgphoto2 sends **9209()** for its normal full snapshot in both modes. One parameter with value 1 requests differences, not “v3”. |

**How to negotiate.** Read the **first two bytes of the inbound dataset** as u16 version, then `u32 nprops; u16 props[nprops]; u32 ncontrols; u16 controls[ncontrols]`. Keep the property and action registries distinct. The M3 trace returns `c8 00 2c 00 00 00` then 44 property codes and 17 actions, 132 payload bytes total. CM2 2.01’s PTP/IP fixture starts `2c 01 a5 01 00 00` and is exactly `2+4+421*2+4+59*2` bytes. Sony’s optional response parameter 1 is the **vendor code version**. The M3 has a 12-byte OK response with no parameters. Determine SDI mode from the payload. In v3 the extended-code option enables E000–EFFF properties and F000–FFFF controls where 9216 GetVendorCodeVersion is supported and vendor code version is at least 3.10. It is separate from SDI version 3.00. [M3 USB][M3wire] · [CM2 binary][CM2caps] · [Sony PTP 2 operations pp. 23–28][S2] · [Sony operation definitions §§SDIO_Connect–GetAllExtDevicePropInfo][S3] · [current negotiation][ptp]

For the two known bodies, prefer the M3’s observed one-argument 200 request and the CM2’s 300 request with extended codes when supported. For an unidentified compatible Sony, the upstream auto-probe offers 300 and branches on the reported version. Upstream verified a 300 offer returning 200 on an A99V and α7R III, and returning 300 on newer bodies. **A direct 300→200 trace from this specific α7 III was not located.** Sony’s April 2024 PTP 2 compatibility matrix lists **both ILCE-7M3 and ILCE-7CM2** for 9201, 9202, 9205, 9207 and 9209. Thus 9202(200) is a documented legacy profile on the CM2. Its 2.01 USB summary with 5004 and u16 drive settings is consistent with this profile, although it omits the negotiation bytes. Sony documents A101 AuthenticationFailed when the initiator major is below the responder’s required major. Sony also warns that PTP 2 commands may become unusable on some models from 2027. Prefer 300 on the CM2 and record the actual returned version on every firmware. On an unsupported parameter or negotiation failure, close and reopen cleanly before one known-compatible profile trial. If the negotiated version is unknown, or the dataset stays empty after bounded retries, stop before control writes. Sony documents retry on an empty negotiation dataset; libgphoto2 attempts up to 20 reads. [PTP 2 body matrix p. 19 and version rules p. 24][S2] · [Sony compatibility notice][Sony] · [Negotiation tests][p1234] · [historical regressions][i937] · [CM2 report][CM2dump] · [Sony reference][S3]

**Which operation.** 9203 gets one Sony property descriptor, 9204 gets one property value, 9205 sets a property, 9206 gets a control descriptor, 9207 actuates a control, 9209 gets the descriptor array. Codes are hex throughout. 9204 cannot replace 9209 for enumeration. Test advertised operations; the numeric interval includes unassigned/unused slots. 9205 and 9207 both take the zero-extended property/control code in parameter 1, and a **separate data-out payload** encoded in the operation’s declared type. For v3 extended codes use parameter 2 = 1 on applicable operations. Preserve the distinction between an absolute setting, a relative notch and a held button. [Sony reference][S3] · [libgphoto2 opcodes][codes] · [set/control implementations][ptp]

**Byte layout of a full 9209 data payload.** At offset 0 read a **u64 LE** number of records, first record at offset 8. Sony specifies UINT64 for the array count. libgphoto2 skips eight bytes and describes them as u32 count + zero u32. INDIGO reads the low u32 and also starts at 8. Those implementations agree for every realistic count. Reject a count that cannot fit the remaining bytes. With a delta request, apply valid records to a preceding full snapshot. Never clear unmentioned values. [Sony v2 array definition p. 28][S2] · [Sony v3 array definition pp. 74–76][S3] · [libgphoto2 array reader][ptp] · [INDIGO bounds and enum parser][indigo]

| Offset relative to descriptor | Field |
|---|---|
| +0 | u16 property or control code |
| +2 | u16 PTP DataType |
| +4 | u8 GetSet for normal properties. For controls this can be a control type. |
| +5 | u8 IsEnabled, or reserved where the control definition says so |
| +6 | default/reserved value of the declared type |
| following default | current/reserved value of the same type |
| following current | u8 FormFlag: 0 no tail, 1 range, 2 enumeration |
| form 1 | exactly three typed values: minimum, maximum, increment |
| form 2, observed α7 III firmware 4.0, SDI 200 | One u16 count then that many typed values |
| form 2, Sony PTP 2 and PTP 3 references | **Two adjacent counted lists**: u16 Set count, typed Set values, u16 Get/Set count, typed Get/Set values. One FormFlag total. A count of zero still occupies two bytes. |

For a scalar of width W, current begins at 6+W, FormFlag at 6+2W and form data at 7+2W. In Sony’s two-list layout, the **first** enum is the current write choice list. The second includes values that may be reported but unavailable to set. INDIGO illustrates a lens state with only MF in the first list and five modes in the second. libgphoto2’s compatibility reader peeks for a low u16 (<0x0200) and may replace the first enum with the second. Treat that as its parsing heuristic, not the v3 wire grammar. A range has one triple in both profiles. When an extended option is in use, E-series property and F-series control codes can also begin the next record. An unknown type or form cannot be skipped by looking for the next plausible property code because values can contain those bytes. Reject the whole malformed snapshot, preserve the last good state, and requery. For the traced M3 firmware, use the single-list layout. For an unfamiliar SDI 200 profile, try both grammars across the **entire payload**, with bounded counts, valid typed records and exact consumption. Accept a unique coherent interpretation, including equivalent interpretations when there are no enums. If distinct interpretations both fit, disable descriptor-dependent writes and retain the raw diagnostic. Negotiated version alone cannot choose the enum grammar. [M3 USB bytes][M3wire] · [Sony v2 enumeration example p. 28][S2] · [Sony v3 enumeration table][S3] · [libgphoto2 ptp_unpack_Sony_DPD][pack] · [INDIGO parser and two-list example][indigo]

Normal IsEnabled values are 0 greyed out (current/default may be invalid), 1 enabled, 2 display-only. V3 GetSet 0/1 means read-only/read-write. In v2 several exposure readouts have GetSet 0 despite separate notch controls. Values 81/82/83/84 hex denote button/notch/lock/variable control types. The M3 D2D1 descriptor is 82. A control code can occur in the bulk snapshot. Use its control definition for action payloads. Some v2 properties can be set despite display-only flags in upstream implementations. Permit specific verified routes and read back their results; avoid enabling writes across the whole registry. [M3 trace][M3wire] · [Sony descriptor handling][pack]

Scalar DataTypes 0001/0002 = i8/u8, 0003/0004 = i16/u16, 0005/0006 = i32/u32, 0007/0008 = i64/u64, 0009/000A = i128/u128. Signed values use two’s complement. Array variants 4001–400A prefix a u32 element count. FFFF is the PTP string encoding above. No native casts, alignment padding, C enum width or host byte order belong in the codec. Decode even unrecognized **property codes** when their type/form is understood. Preserve unknown values as raw values for diagnostics. [PTP data definitions][codes] · [dataset parser][pack]

**Reproducible byte checks.** In the M3 trace, TID 4 command `10 00 00 00 01 00 02 92 04 00 00 00 c8 00 00 00` returns version 200. The 9209 data header at TID 10 is `ad 06 00 00 02 00 09 92 0a 00 00 00`. Its payload begins `3c 00 00 00 00 00 00 00`. Relative to that payload, 5004 starts at 0x08, 5005 at 0x1A, D215 at 0x05C4 and the last record D2D1 at 0x0690. Its range is signed −7…+7 with increment 1. The records end at offset 0x06A1 exclusive. An independent synthetic v3 enum record for a u16 AF mode is `0a 50 04 00 01 01 01 00 01 00 02 01 00 01 00 02 00 01 00 02 00`: writable choices [MF], reportable choices [MF, AF-S]. [Source bytes for M3][M3wire] · [v3 enum definition][S3]

## Properties and actions

Hex values below omit the 0x prefix. Types refer to the PTP DataType table above. **M3** means the 4.0 SDI 200 trace. **CM2** means the SDI 300 specification and the 2.01 capability dataset unless a row explicitly cites the legacy-shaped USB summary. A capability code establishes presence. The current descriptor, lens, mode dial, firmware and save policy determine what is writable. Preserve both the raw value and its label. [M3 bytes][M3wire] · [CM2 capability bytes][CM2caps] · [CM2 USB summary][CM2dump] · [Sony PTP 2 properties and controls][S2] · [Sony PTP 3 properties and controls][S3] · [upstream value mappings][config]

| Code | Type | Decode, choices and body-specific behavior |
|---|---|---|
| 5005 White Balance | u16 | 0002 AWB, 0004 daylight, 8011 shade, 8010 cloudy, 0006 incandescent, 8001 warm-white fluorescent, 8002 cool white, 8003 day white, 8004 daylight fluorescent, 0007 flash, 8030 underwater auto, 8012 color temperature/filter, 8020/8021/8022 Custom 1/2/3. All fifteen appear on M3 and in the CM2 USB summary. |
| 5007 F-Number | u16 | Divide by 100. Decimal 280 = 0118 = f/2.8. FFFF means no numeric display; its cause cannot be inferred from this field. M3 returned a nominal 0000–FFFF range, current 0320 = f/8. Lens, shooting mode and current enum govern usable stops. |
| 500A Focus Mode | u16 | 0001 MF, 0002 AF-S, 8004 AF-C, 8005 AF-A, 8006 DMF. M3 also reports 8009 (preset focus in the Sony reference). Wait for readback after changes. |
| 500B Exposure Metering | u16 | 8001 multi, 8002 center-weighted, 8003 entire-screen average, 8004 spot standard, 8005 spot large, 8006 highlight. Both body reports include these six. |
| 500E Exposure Program | u16 legacy, u32 v3 | Legacy M/P/A/S = 1/2/3/4, Auto 8000, MR 8020 if advertised, Movie P/A/S/M = 8050–8053, S&Q P/A/S/M = 8084–8087. M3’s snapshot omits MR. V3 M/P/A/S = 00000001/00010002/00020003/00030004, Auto 00048000, MR 00008020, Movie P/A/S/M = 00078050–00078053. Sony lists movie S&Q variants 00098059–0009805C and S&Q 00008084–00008087; gphoto also labels 00088084–00088087. Match the **entire** advertised word. CM2 USB summary has type u16. |
| 5010 Exposure Bias | i16 | Signed milli-EV divided by 1000. D4 FE on the wire = −300 = −0.3 EV, E8 03 = +1000 = +1 EV. Use enumerated detents (e.g. 300 or 700), without rounding a computed third stop into an unadvertised value. |
| 5013 Still Capture/Drive | u16 legacy, u32 v3 | Legacy single 0001, continuous Lo 8012, Mid 8015, Hi 0002, Hi+ 8010. Timers 2s 8005, 5s 8003, 10s 8004. V3 single 00000001; continuous Lo/Mid/Hi/Hi+ 00018012/00018015/00010002/00018010; timers 00038005/00038003/00038004. Brackets below. CM2 USB summary has type u16; CM2’s v3 capability list includes this property. |
| D20D Shutter Speed | u32 | `n = raw >> 16`, `d = raw & 0xffff`. 000100FA = 1/250 s, 001E000A = 30/10 = 3 s. Special values first: 00000000 BULB, FFFFFFFF **nothing to display**. Reject other zero denominators. Retain original representation for writes. |
| D20F Color Temperature | u16 | Kelvin. 09C4…26AC = 2500…9900 K in 0064 (100 K) steps. Sony v3 defines 0000 below and FFFF above range as current-only. M3 reported current 0 while the setting was disabled. |
| D210 G–M, D21C A–B WB fine tuning | u8 each | V3 signed display offset = `(int(raw) − 192) / 4.0`. Negative = M or B, positive = G or A. 9C…E4 represents −9…+9 at quarter units. M3 actually returned current C0 on both, range A4…DC, G–M increment 1, A–B increment 2; its reserved/default byte was 80. Use the reported range and step. |
| D211 Aspect Ratio | u8 | 1 = 3:2, 2 = 16:9, 3 = 4:3, 4 = 1:1. M3 lists 1 and 2; CM2 USB lists all four. |
| D213 Focus Indication | u8 | 01 unlocked, 02 AF-S locked/focused, 03 AF-S low contrast/unfocused, 05 AF-C tracking, 06 AF-C focused, 07 AF-C low contrast/unfocused. M3 enumerates all six. V3 also defines 08/09 unpause/pause on applicable devices. Upstream capture treats 2 or 3 as a reason to end a wait on some cameras. Do not tell the photographer 3 indicates focus. |
| D215 Shooting File Info / ObjectInMemory | u16 | 0000 empty, 0001–7FFF a file exists but completion bit is clear. MSB 8000 marks transfer readiness in Sony’s acquisition sequence. **8001 is captured on M3**. The exact bare-8000 boundary is discussed below. Low bits are a queue hint; never assume an exact number of shutter releases or file companions from them. |
| D218 Battery Remaining | i8 | 0…100 percent. FF = −1, reading unavailable. M3 trace has 33 hex = 51%, CM2 reports 78%. The separate D20E u8 battery indicator has discrete levels and USB bus-power states. Keep those flags out of the percentage. |
| D21E ISO Sensitivity | u32 | `base = raw & 00FFFFFF`, base FFFFFF = Auto ISO. Sony defines 01000000 + base for multi-frame NR, 02000000 + base for high multi-frame NR, and **10000000** offset for extended ISO in both Sony references. Example 01000320 = multi-frame NR ISO 800. Preserve all high bits; show unknown modes raw. M3 lists normal, 01 and 02 high-byte variants. ISO 50 alone does not identify which flag a particular firmware uses. |
| D221 Live View Status | u8 | 00 supported/disabled, 01 enabled, 02 unsupported (property can also be absent). A readout governs whether the host can fetch frames. |
| D222 Still Image Save Destination | u16 | 0001 host/PC only, 0010 camera only, 0011 host and camera. M3’s actual enum is **[0001,0011]**; CM2’s is **[0001,0011,0010]**. Sony v3 defines this property as Get. Display the effective destination and direct the user to the camera menu if a change is required. |
| D22C Focus Area | u16 | 0001 wide, 0002 zone, 0003 center; 0101/0102/0103 flexible spot S/M/L, 0104 expand flexible spot. These seven appear on M3 in the recorded state. Tracking/lock-on 0201/0202/0203 wide/zone/center, 0204/0205/0206 spot S/M/L, 0207 expand. Additional sizes are model-dependent. Show only current choices. |
| D200 Flash Compensation | i16 | Signed milli-EV. M3 includes −3000…+3000 detents. This code has no file-format function. |
| 5004 Compression Setting | u8, legacy | M3 advertises 02 JPEG Std, 03 Fine, 04 X.Fine, 10 RAW, 12/13/14 RAW+JPEG Std/Fine/X.Fine. CM2 legacy-shaped summary adds 01 JPEG Light and 11 RAW+JPEG Light. In its SDI 300 capability dataset 5004 is absent. |
| D253 File Format, D252 JPEG Quality | u8 each, v3 | D253: 01 RAW, 02 RAW+JPEG, 03 JPEG, 04 RAW+HEIF, 05 HEIF. D252: 01 X.Fine, 02 Fine, 03 Std, 04 Light. CM2 advertises both. |
| D288 RAW File Type | u8, v3 | 01 compressed, 02 lossless L, 03 lossless M, 04 lossless S, 05 uncompressed, 06 unsized lossless on applicable bodies. CM2 advertises D288 and its menu offers lossless L/M/S. M3 lacks this code in the trace. D289/D28A are separate slot-specific properties where advertised. [CM2 RAW types][cm2raw] |
| D268 PC Save Image Size, D269 PC Save Image Format | u8 each where present | D268: 01 original, 02 2M. D269: 00 disabled, 01 RAW & JPEG, 02 JPEG only, 03 RAW only, 04 RAW & HEIF, 05 HEIF only. The host file set may differ from the card file set. |
| D232, D235, D24C, E042/E043 | various | M3 reports D232 as u32, current 00AA00FE, disabled in that snapshot. Its semantics as a writable focus coordinate were not established. Keep opaque. D235 u8 is Near/Far Enable Status, 0/1 disabled/enabled. D24C u8 reads relative focal position 0…100. CM2 advertises D235/D24C and E042/E043 (u16 absolute target/readback 0…FFFF), omits D232. Sony warns that CM2 firmware 2.00 changed focus-position calibration. Key saved positions to body, lens and firmware. [Sony firmware advisory][Sony] |

**Drive brackets.** Use the exact advertised values. In M3’s exposure brackets the low 16-bit word for an N-shot centered bracket has the form `0x8000 | (N << 8) | b`. For continuous 0.3/0.5/0.7/1/2/3 EV, b = 37/57/77/11/21/31 hex. For single bracket the corresponding b = 36/56/76/10/20/30. The M3 dump has N=3/5/9 for the first four intervals, N=3/5 for 2 and 3 EV. In v3 a continuous exposure bracket has prefix 0004 in the high word and single exposure bracket 0005. Examples: 00048337 = continuous 3 at 0.3 EV, 00058536 = single 5 at 0.3 EV. Directional two-frame variants use distinct codes, e.g. 0004C237/0004C23F for +/− at 0.3. WB low/high = 8018/8028 (v3 high word 0006); DRO low/high = 8019/8029 (v3 0007). The CM2 legacy summary also advertises 8040 focus bracket; v3 defines 000A8040. The table in Sony’s Still Capture Mode section maps further variable increments. This decoding is for displaying returned values, never for generating unsupported choices. [M3 bytes][M3wire] · [CM2 dump][CM2dump] · [Sony Still Capture Mode][S3] · [gphoto drive mappings][config]

| Control | Payload after 9207(code) | Availability and meaning |
|---|---|---|
| D2C1 S1, D2C2 S2 | u16 0002 down, 0001 up | Both bodies. Data bytes 02 00 or 01 00. S1 half-press initiates AF where configured. S2 releases the shutter. |
| D2C3 AEL, D2C9 FEL | u16 0002 down, 0001 up | AE lock and flash exposure lock respectively. D217 and D21F report their lock states. |
| D2C8 Movie Rec (Hold) | u16 button | Movie record control. Do not send this for a manual-focus step. |
| D2D1 Near/Far | i16 notch | Both bodies. M3 range −7…+7, step 1. Example −1/−2/−3 = FF FF / FE FF / FD FF, +1/+2/+3 = 01 00 / 02 00 / 03 00. Confirm near/far polarity with the attached lens. One notch changes by a lens-dependent amount. 0 is in range; no sustained motion is required to finish a notch. gphoto uses its separate AF/MF hold release for a zero UI input. Gate on D235. |
| D2D2 AF/MF Hold | button, u16 up/down on M3 | Separate action. CM2 advertises this and distinct D2D7/D2D8 Focus Step Near/Far controls. Treat those as separate advertised controls with their own descriptors. |
| D2CB/D2CC Focus Magnifier/Cancel | u16 up/down | Present on M3, together with D2CD…D2D0 direction buttons. Read D22D (magnifier status) and D22F (current ratio) after toggling. CM2’s v3 dataset omits CB/CC but advertises D254. D254 is a **9205** u64 property: upper 32 bits ratio ×10, then u16 x and u16 y; ratio zero = off. Sony specifies FFFFFFFF for the unspecified coordinate portion of enum choices. |
| D2DC AF Area Position | u32 `(x << 16) \| y` | CM2 advertises this control. Sony’s coordinate grid is x 0…639, y 0…479. Map the displayed image rectangle to this grid and take account of cropping/letterboxing. Enable for supported spot/AF modes. M3’s 4.0 control list omits D2DC. |

**Write dispatch.** For normal writable properties such as WB, color temperature, WB axes, area and file format, use 9205 with the descriptor’s absolute type/value. For S1/S2, AEL, near/far and AF-point movement, use 9207 with the control type above. For M3 exposure changes, the readout and notch control may share the same code: upstream adjusts 5007, D20D, D21E and 5010 via 9207, then rereads 9209. A sign is a relative detent, not a new ISO or shutter fraction. gphoto sends one-byte 01/FF in its generic notch routine; an M3 USB project uses two-byte 01 00/FF 00 for ISO, aperture and shutter. Select and validate a profile for each **control**, including step direction. Never try both after an ambiguous timeout. In v3 upstream directly sets D21E (u32), D20D (u32) and 5010 (i16) via 9205. Sony’s D20D text also describes relative control; upstream found different behavior on 7RM4/7RM5. For v3 5007 Sony specifies u16, while upstream’s absolute setter explicitly passes u32. Use the documented two-byte encoding first in a qualified profile and verify actual readback on CM2 before shipping aperture writes. A broad writable flag alone cannot resolve these differences. [Sony properties and controls][S3] · [gphoto setters][config] · [M3 USB implementation][m3app] · [related-body fixes][p1067]

Upstream’s 7RM5/7M4 regressions and the ZV-E1 u32 program-mode report illustrate the cost of selecting a parser by model year. The FX3/FX30 discussion concerns exposure ranges; it supplies no raw α7C II 9209 payload. Preserve each model’s evidence boundary. [7RM5/7M4 reports][i937] · [ZV-E1 typed readback][zve1] · [7M3/7M4/FX exposure investigation][fx]

## Shutter, events and transfer queue

**Host capture.** Open the destination and check free space before arming. Read the current save destination, drive, focus and pending-file state. Drain any older transferable objects into the session as pre-existing captures. Never discard one to “clean” camera RAM. For a single exposure, send these four 9207 commands serially. Each command has one u32 code parameter and the two-byte data phase shown. [Sony control sequence][S3] · [upstream camera_sony_capture][lib]

| Transition | Parameter 1 | Outbound data | Completion criterion |
|---|---|---|---|
| S1 down | 0000D2C1 | 02 00 | Record that release is owed as soon as dispatch can have reached the body. |
| S2 down | 0000D2C2 | 02 00 | In focus-priority mode, optionally wait after S1 for focused D213 (02 AF-S, 06 AF-C) until a bounded deadline. In release-priority or MF, proceed without a focus wait. |
| S2 up | 0000D2C2 | 01 00 | Release after the intended press interval. If a hold is required for AF, observe D213/ready events and enforce a hold deadline. |
| S1 up | 0000D2C1 | 01 00 | Always unwind outstanding presses in reverse order on success, cancel and recoverable failure. For a disconnect, invalidate the old session and report uncertain shutter state. |

A synthetic direct-bulk S2 down at TID 7 consists of command `10 00 00 00 01 00 07 92 07 00 00 00 c2 d2 00 00` and data `0e 00 00 00 02 00 07 92 07 00 00 00 02 00`. The empty OK response is `0c 00 00 00 03 00 01 20 07 00 00 00`. For ICC use the command with the ICC TID placeholder and pass only `02 00` in outData.

Sony specifies ordering and reports OK even when focus priority prevents exposure. It prescribes no universal S1→S2 delay. Upstream sends S1/S2 down immediately, waits up to 1 s during the press in autofocus, then releases S2/S1. It also applies a roughly 3 s warm-up to selected models including the M3. These are implementation observations. For AF-priority, a proposed 1 s acquisition budget can end in “focus not acquired”; release S1 and leave the camera’s priority setting intact. In balanced or release priority, lack of AF lock is not proof of missed exposure. After S2 dispatch, never automatically shoot again on timeout. Watch for real file readiness after releasing the buttons. Distinguish “shutter command accepted”, “file pending” and “local file saved”. For long exposures use an exposure-aware deadline that includes noise reduction and write time. BULB needs an explicit end-of-exposure action and an outstanding-release guard. CM2’s D179/D17A report AF-S/AF-C priority when available, with 01 AF, 02 release, 03 balanced. [Sony reference][S3] · [upstream capture behavior][lib] · [M3 AF-S priority](https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001653133.html)

**Body shutter.** A physical press generates no host S1/S2 transactions. While idle or showing preview, keep event reception and queue polling active. A file routed to the host goes through the same drain path regardless of trigger source. Camera Only produces no promised host file. Avoid forcing application-priority mode at startup simply to poll: D25A (where advertised) selects camera-position priority 0 or PC Remote setting priority 1. Test the actual dial, shutter button and AF behavior in both priority states. A press on the body close in time to a host press can be indistinguishable; attach files to the session and keep trigger origin unknown if ambiguous. [M3 physical-shutter implementation][m3app] · [Sony priority and queue properties][S3]

**Events and readiness.**

| Event | Payload | Host action |
|---|---|---|
| C201 SDIE_ObjectAdded | parameter 1 = object handle | Wake the drain worker. A fresh added event is evidence of transferability. For a delayed/coalesced event, reconcile with the current queue before consuming the head. |
| C202 SDIE_ObjectRemoved | parameter 1 = object handle | Sony sends it after transfer. Invalidate the old notification. The next queued file may immediately reuse FFFFC001. Never request or delete the just-removed object based on this event. |
| C203 SDIE_DevicePropChanged | V3 reference: no parameters. M3 USB trace: can carry changed property code in parameter 1 (e.g. 5004). | Mark properties dirty and coalesce into a 9209 refresh. Never require a parameter or infer a value from the event. |
| 4002/4003/4006 standard PTP | ordinary ObjectAdded/ObjectRemoved/DevicePropChanged | Decode separately if advertised. ICC catalog callbacks are not the Sony transfer queue. |

Sony recommends polling on older models because events can be lost. Maintain a property poll even on CM2, after a receive overflow, on open, and after each file transfer. As a starting **scheduler policy**, poll at 100 ms while waiting for a shot and 250–500 ms while idle. Suspend recurring bulk polls during a RAW transfer; service events without starting a second command. Prefer a fresh C201 over waiting for the next timer. [Sony overview, shooting sequence and events][S3] · [M3 C203 wire packet][M3wire] · [upstream polling][lib]

**D215 boundary.** The M3 sample contains 8001. Sony’s overview describes a nonzero value with the MSB set; its detailed property text uses the wording “over 0x8001”. Upstream capture uses `>= 0x8000`, while its wait-for-event path uses `> 0x8000`. Values like 0001 can occur before the object is readable, and upstream reports that premature reads can crash camera firmware. PhotoCull’s conservative predicate is **8001…FFFF**, or a fresh, valid C201 announcing the head. For **exactly 8000** without that event, keep polling under a deadline, record the state and surface a stalled queue if it persists. Do not poll FFFFC001 blindly. This is a deliberate interoperability decision pending a body-specific observation of the bare value. [Sony Shooting File Info and Get Image File][S3] · [upstream comparison][lib] · [M3 trace][M3wire]

### Drain one file at a time

1. Pause Live View submissions and wait for any in-flight preview transaction to finish. On confirmed readiness send **1008(FFFFC001)**. Parse the newest ObjectInfo. An empty/unready response or zero-size shot is reason to recheck readiness under a deadline, not to create a successful empty image.
2. Reserve a unique destination on the selected filesystem. Sanitize the camera-provided basename, reject directory components and use no-overwrite creation. Account for filesystem capacity and room for both members of a pair. For a transient head send **1009(FFFFC001)** once, collect/write the payload, retain the PTP response. Treat this operation as consuming the camera queue. GetObjectInfo alone peeks. Never issue DeleteObject. Never write embedded metadata to a card/source.
3. Check response OK, byte count and known shot size. Bound expected allocations even if ObjectInfo reports an unknown length. On a mismatch retain recoverable bytes as incomplete and report the discrepancy. After a complete write, flush/sync as required, close and publish atomically with create-if-absent semantics in the same filesystem. A plain rename which replaces an existing capture is unsafe. Only then notify the sidecar’s normal local scanning/preview path. If local writing fails after ICC received the RAW, retain the owned bytes while offering a destination retry. A second GetObject might already refer to another file.
4. Refresh 9209/D215. If ready, repeat **1008 + 1009 on the same handle**. If pending, wait for readiness; if empty, release the drain and continue background monitoring. A 2009 at this boundary ends that read attempt: refresh the state, wait on a raced event if necessary, and stop the drain once the queue settles. An endlessly repeated ready/invalid combination is a recoverable session fault. RAW+JPEG may remain ready across two successful reads **with exactly the same D215 value**. Waiting for a change in its numeric value can strand the second file.
5. Both Sony references specify JPEG/HEIF first, then RAW, with the same ObjectInfo SequenceNumber when both companions are transferred. The counter restarts on power-up. Pair by body, connection generation, sequence and compatible formats. Check Exif capture time when reconciling across power cycles. Inspect each actual format and respect the host save filter on both bodies. Preserve independent files when pairing is uncertain. Burst and bracket modes run the same loop. Bounded buffering, disk-space checks and giving downloads priority reduce loss, but a finite camera buffer and a cable or disk slower than the burst preclude a loss-free guarantee. Record incomplete or ambiguous captures visibly. [Sony v2 transfer and pairing pp. 12–13][S2] · [Sony v3 pp. 30–31][S3] · [upstream RAW/JPEG and event code][lib] · [INDIGO Sony queue handling][indigo]

**ObjectInfo data payload, classic PTP layout.** All offsets are from the first dataset byte (the first callback buffer on ICC).

| Offset | Field | Offset | Field |
|---:|---|---:|---|
| 0 | StorageID u32 | 4 | ObjectFormat u16 |
| 6 | ProtectionStatus u16 | 8 | ObjectCompressedSize u32, bytes |
| 12 | ThumbFormat u16 | 14 | ThumbCompressedSize u32 |
| 18 | ThumbPixWidth u32 | 22 | ThumbPixHeight u32 |
| 26 | ImagePixWidth u32 | 30 | ImagePixHeight u32 |
| 34 | ImageBitDepth u32 | 38 | ParentObject u32 |
| 42 | AssociationType u16 | 44 | AssociationDesc u32 |
| 48 | SequenceNumber u32 | 52 | Filename PTP string, then CaptureDate, ModificationDate and Keywords PTP strings |

B101 = Sony RAW (ARW), 3801 = EXIF/JPEG, 3808 = JFIF, B110 = Sony HEIF. 3800 is a generic defined image format, 3000 undefined. For an ambiguous format, inspect suffix case-insensitively and validate the file type (e.g. JPEG SOI and marker structure, TIFF-family ARW metadata or HEIF file-type box). A TIFF signature alone does not uniquely identify ARW. Preserve the original basename and actual extension where possible. A generic file type or unexpected pair order cannot justify silently converting or dropping a file. [ObjectInfo offsets][pack] · [Sony object formats][S3]

## Live View

Wait for D221 = 01. For SDI 3.00, use **1008(FFFFC002) once** at stream startup. Its ObjectCompressedSize is an estimated worst case, useful as an allocation hint. Fetch a frame with **1009(FFFFC002)**. Sony specifies 2009 if Live View is disabled. A too-early frame may come with zero image size and 200F. Recheck status if persistent. In its multi-model implementation libgphoto2 also queries 1008, retries a temporarily invalid handle after 50 ms and backs off 20 ms on access denied. The PTP 2 sequence also shows 1008 followed by 1009. Verify on M3 firmware whether a single initial 1008 suffices for a sustained stream. The preview is polled as a still object. [Sony PTP 2 sequence and dataset pp. 14, 22][S2] · [Sony PTP 3 GetObject/GetObjectInfo pp. 66–67][S3] · [upstream Sony preview][lib]

| Payload offset | SDI 2.00 | SDI 3.00 |
|---:|---|---|
| 0 | u32 JPEG offset relative to start of payload | Same |
| 4 | u32 JPEG byte count | Same |
| 8 | Reserved bytes up to JPEG offset. JPEG occupies the declared range. | u32 focal-frame information offset |
| 12 | No field at this fixed offset | u32 focal-frame information byte count |
| 16 onward | No additional fixed fields | Reserved/padding, JPEG and optional focal-frame data at the specified ranges |

Check `offset <= len` and `size <= len - offset` for each present region. Require a nonempty JPEG region beginning FF D8 at offset ≥8 on v2 or ≥16 on v3. Use its declared span and verify JPEG structure through the outer FF D9 inclusive. Only for a verified variant lacking a usable size field, use a bounded JPEG marker parser from a validated SOI, skipping length-prefixed segments and handling stuffed FF 00/restart markers in scan data. An EXIF thumbnail can contain its own SOI/EOI and Sony’s prefix can contain FF D8. Picking the first SOI and first subsequent EOI in the whole buffer can silently publish the wrong frame. Discard malformed frames. Decode width/height from the JPEG SOF, record negotiated quality (D26A where present) and exclude focal metadata from image bytes. [Sony PTP 2 LiveView Dataset p. 22][S2] · [Sony PTP 3 LiveView Dataset and Image Quality][S3] · [upstream offset fix][lvissue]

Sony specifies a **30 fps ceiling in both profiles**. Schedule at most one outstanding fetch; start with 33.4 ms minimum spacing and adjust upward for transfer/decode time. A 20–30 fps UI target and roughly 1024×680 are **unmeasured for these two USB/ICC combinations**. Quality, aspect ratio and available bandwidth change what arrives. Publish the latest frame in a single replaceable slot, service a due property refresh ahead of the next preview, and stop preview submission as soon as a shutter or file-readiness signal arrives. Resume after a fresh empty queue snapshot. Track completed frames/s, dimensions, p95 inter-frame interval and skipped preview frames. [Sony frame pacing][S3] · [per-camera resolution evidence][lvmodels]

## Errors, recovery and qualification

Proposed states are Discovered → Opening → Negotiating → Ready. Ready owns one exclusive operation at a time, including shutter actions, property reads, draining or preview. An unplug from any state enters Removed. Lost-session or protocol desynchronization enters Recovering. A user disconnect enters Closing and drains or invalidates outstanding work before releasing the attachment. Implement one dispatcher per device. Control releases, removal and transfer completion take precedence over new captures, property edits and preview. Distinguish a result from the camera from an OS error and from a host timeout.

| Result | Meaning and engine policy |
|---|---|
| 2001 OK | Validate the expected dataset/response for the operation. For setting or shutter commands, subsequently verify the observed camera state or queued file. |
| 2019 DeviceBusy | Back off read-only operations with a bounded delay, e.g. 50/100/200/400 ms then 500 ms maximum up to an operation-specific deadline. Drop a stale preview job. Avoid duplicating a press or consuming read when the result is uncertain. |
| 2009 InvalidObjectHandle | Preview: reread D221. Capture: stale event, premature access or queue drained; reread D215. Never substitute card enumeration or DeleteObject to recover a transient handle. |
| 2003 SessionNotOpen / 201E SessionAlreadyOpen | Reconcile the local owner. Release the ICC session or direct handle that belongs to this client. Reopen, renegotiate and refresh. Do not close a different app’s session. |
| 201D InvalidParameter / 2006 ParameterNotSupported / 2005 OperationNotSupported | Stop retrying unchanged bytes. Check profile, parameter count, width, write route, availability and extended option. Disable unsupported controls for that session. |
| 200F AccessDenied | Preview can mean “too soon”; back off. For capture or settings, check camera mode, save destination, lock, access restriction and ownership. Distinguish the PTP code from an NSError or OS permission denial. |
| A101 AuthenticationFailed | Check Sony version/profile, connection mode and phase sequence. One orderly reconnect with a documented compatible profile, then present a diagnostic. |
| Detach, sleep, power-off, stalled callback, unexpected container | Freeze submissions immediately, clear held-state bookkeeping for the retired generation, preserve complete/partial local files and pending bytes. On wake/replug, identify the new attachment, reopen, repeat SDIO, refresh and drain surviving camera files as unattributed. Never replay the old capture or assume resume by pseudo-handle. |

The proposed 50–500 ms read backoff, 1 s AF budget, and 100–500 ms poll intervals are scheduler choices. Base the RAW deadline on measured speed and expected bytes plus margin. A blocked or uncancellable ICC request may require teardown or a replug before reconnect. Bound automatic reconnect attempts, surface persistent failure and keep browsing for device addition. An unplug may lose a PC-only image before a local copy exists. For a camera with a usable card, PC+Camera/Dest.+Camera supplies an independent recovery copy. [PTP result constants][codes] · [Sony transfer/status rules][S3] · [Apple device lifecycle][device]

### Verification before shipping a native adapter

| Environment | Evidence to collect and pass condition |
|---|---|
| Offline Linux and macOS tests | Drive the production session via ScriptedTransport. Decode the M3-shaped one-list and CM2-shaped two-list synthetic payloads, a zero available-set count followed by another record, ranges/strings/arrays and malformed lengths. Exercise all four shutter edges, late C201/C203, unchanged D215 across a pair, lost response after consumption, no-card/AF failures, no-clobber naming, disk-full, removal during RAW and stale callbacks on reconnect. Assert exact outbound frames and final files/state. Generate packet-boundary cases at 512 and 1024 bytes. No external network or personal images. |
| Apple Silicon macOS 13, 14, 15 and each newer supported major, both bodies | Record exact OS build, app signature/entitlements, firmware, lens, USB speed, endpoint descriptors and menu settings. Observe `system_profiler SPUSBDataType`, `ioreg -p IOUSB -l -w0`, and read-only process observations before plugging, after ICC discovery, during open and after close. Test fresh user consent, denial, other importer open and replug without terminating any daemon. Record capability, actual callbacks/errors and data/response lengths. Redact serials, account information and photo contents. |
| Handshake and property validation | On **separate fresh sessions**, record 9202(200), 9202(300) and 9202(300,1), empty-data retries, returned version/code lists and response parameters. Compare 9209() with v3 (0,0)/(0,1) and a delta following a known setting change. Decode the entire buffer, require exact end position, then verify the writable-list order by changing a lens/mode condition. Confirm each supported write via readback and camera display, especially aperture width, exposure notches, D232 semantics if ever exposed, near/far polarity and any firmware-specific options. |
| Capture and throughput | Test physical and host shutter with PC Only and PC+Camera, both RAW+JPEG host filters and both members, AF-S failure/release priority, MF, burst and bracket. Use a disposable card, unique destination and recorded burst count. For every local ARW/JPEG verify completeness, expected dimensions, decoder success and pair sequence. Where an exact matching card original is available, compare file size and SHA-256. Record object readiness and arrival order, RAW download duration and peak RSS for 30–60 MB and the largest supported files. Never infer throughput from the USB link rate. |
| Preview and interruption | Read at least 300 consecutive frames per body/OS/quality, record JPEG offsets/lengths, SOF dimensions and achieved fps, then shutter during preview. Assert no new preview while files drain. Unplug during S1, during S2, mid-RAW and after receipt before publication. Exercise disk-full and reconnect. Explicitly record missing, partial, duplicated and recovered objects. A 30 fps claim needs this measurement. |

**Distribution.** Write PhotoCull’s protocol implementation independently against published wire facts. libgphoto2, INDIGO and sample implementation links are research sources with their own licenses. Sony’s document/sample package has its own terms. Ship neither their source nor the reference PDFs with this design. Review exact versions and transitive licenses for any future objc2/USB crates. Keep all Apple imports, framework linkage and native code behind the Mac target and preserve current Linux/Windows build behavior. After dependency changes cache locked crates, run `node scripts/notices.cjs --refresh`, review metadata/supplements, then run offline `npm run notices` and `node scripts/notices.cjs --check`. Run `npm test`, applicable UI smokes, and in src-tauri run `cargo fmt --check`, `cargo test --locked`, `cargo build --locked`. Signing/packaging changes also require a native Apple Silicon `npm run build` and tests with the signed bundle. [PhotoCull contribution checks](../CONTRIBUTING.md) · [licensing and offline notices](licensing.md) · [macOS build](macos.md) · [Sony Remote Command distribution][Sony]

## Source editions

The legacy profile is specified in **Sony Camera Control PTP 2 Reference, April 2024**, especially pp. 9–14 (sequences), 19 (model support), 22–28 (datasets and operations) and the named properties and controls. For the newer profile see **Sony Camera Control PTP 3 Reference, September 2024**, especially pp. 19–31 (session and acquisition), 52–64 (compatibility), 66–76 (operations and datasets), the named Device Properties/Controls, and pp. 408–409 (events). The August 2025 edition also specifies the two-list layout and extended property flag on pp. 115–117. Sony distributes current references through its Camera Remote Command program. The historical references, hardware observations and pinned implementation sources are linked for reproducibility. [Sony distribution and release notes][Sony] · [April 2024 PTP 2 edition][S2] · [September 2024 PTP 3 edition][S3] · [August 2025 edition][S325] · [USB-IF SIC 1.0 and erratum][USB]

[Sony]: https://support.d-imaging.sony.co.jp/app/cameraremotecommand/en/index.html
[S2]: https://github.com/LyunhoKim/camera-control/blob/1746c8198ab7c4029ed55c55212eeab41f10c7bd/Camera%20Control%20PTP%202%20Reference.pdf
[S3]: https://github.com/rem0g/sonyPTP-MacOS/blob/19646a43192aa1e3cc673ba211c6b4acb192589d/Camera%20Control%20PTP%203%20Reference.pdf
[S325]: https://github.com/jakkuh/sony-alpha-python/blob/d40b7a080617664a4efb107930910bf63347f82e/docs/Camera%20Control%20PTP%203%20Reference.pdf
[USB]: https://www.usb.org/sites/default/files/usb_still_img10.zip
[M3wire]: https://github.com/gphoto/libgphoto2/issues/914#issuecomment-1603623223
[CM2usb]: https://github.com/gphoto/libgphoto2/issues/1304
[CM2dump]: https://github.com/gphoto/libgphoto2/blob/6d5c61ef7687b74fe792e4aeae7fc40f2ad42d88/camlibs/ptp2/cameras/sony-ilce-7cm2.txt
[CM2caps]: https://github.com/UbiquitousBear/shutter-bridge/blob/97d58dee5ec569de98c363daa4aa74aa26076084/Fixtures/a7c2/ptpip/sdio-extdeviceinfo.bin
[bench]: https://github.com/UbiquitousBear/shutter-bridge/blob/97d58dee5ec569de98c363daa4aa74aa26076084/docs/spike-findings.md
[pidm3]: https://github.com/gphoto/gphoto2/issues/588
[hid]: https://github.com/gphoto/libgphoto2/files/2730402/lsusb_a7m3_control.txt
[pidissue]: https://github.com/gphoto/libgphoto2/issues/945
[m3menu]: https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001629775.html
[m3dest]: https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001661953.html
[m3format]: https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001661944.html
[m3power]: https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001653178.html
[cm2menu]: https://helpguide.sony.net/ilc/2360/v1/en/contents/0601_usb_connection.html
[cm2connect]: https://helpguide.sony.net/ilc/2360/v1/en/contents/0903_pc_remote_function.html
[cm2dest]: https://helpguide.sony.net/ilc/2360/v1/en/contents/201h_remote_shoot_setting.html
[cm2power]: https://helpguide.sony.net/ilc/2360/v1/en/contents/0601B_usb_power_supply.html
[cm2format]: https://helpguide.sony.net/ilc/2360/v1/en/contents/0404M_file_format.html
[cm2raw]: https://helpguide.sony.net/ilc/2360/v1/en/contents/0404I_raw_file_type.html
[ICC]: https://developer.apple.com/documentation/imagecapturecore
[send]: https://developer.apple.com/documentation/imagecapturecore/iccameradevice/requestsendptpcommand(_:outdata:completion:)
[device]: https://developer.apple.com/documentation/imagecapturecore/icdevice
[browser]: https://developer.apple.com/documentation/imagecapturecore/icdevicebrowser
[start]: https://developer.apple.com/documentation/imagecapturecore/icdevicebrowser/start()
[auth]: https://developer.apple.com/documentation/imagecapturecore/icdevicebrowser/requestcontrolauthorization(completion:)
[header]: https://github.com/xybp888/iOS-SDKs/blob/4a48e5409f8ea6ac422c44d91b86fa0f8ae010ff/iPhoneOS18.0.sdk/System/Library/Frameworks/ImageCaptureCore.framework/Headers/ICCameraDevice.h
[photosent]: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.photos-library
[usbent]: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.usb
[camkey]: https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription
[cament]: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.camera
[photokey]: https://developer.apple.com/documentation/bundleresources/information-property-list/nsphotolibraryusagedescription
[volkey]: https://developer.apple.com/documentation/bundleresources/information-property-list/nsremovablevolumesusagedescription
[accessory]: https://support.apple.com/en-us/102282
[ICA]: https://github.com/indigo-astronomy/indigo/blob/edf1a44e104b916990ca55cb4b33649c57a6a36a/obsoleted_drivers/ccd_ica/indigo_ica_ptp.m
[ICASony]: https://github.com/indigo-astronomy/indigo/blob/edf1a44e104b916990ca55cb4b33649c57a6a36a/obsoleted_drivers/ccd_ica/indigo_ica_ptp_sony.m
[indigo]: https://github.com/indigo-astronomy/indigo/blob/edf1a44e104b916990ca55cb4b33649c57a6a36a/indigo_drivers/ccd_ptp/indigo_ptp_sony.c
[nusb]: https://github.com/kevinmehall/nusb/blob/c46ccd0183844b6299b5354a4a13d6837d5fcf63/src/platform/macos_iokit/iokit_usb.rs
[nusbclaim]: https://github.com/kevinmehall/nusb/blob/c46ccd0183844b6299b5354a4a13d6837d5fcf63/src/platform/macos_iokit/device.rs
[nusbdevice]: https://github.com/kevinmehall/nusb/blob/c46ccd0183844b6299b5354a4a13d6837d5fcf63/src/device.rs
[libusb]: https://github.com/libusb/libusb/blob/73a6eb8802d388c1150ec34a84a8c5af3fef738a/libusb/os/darwin_usb.c
[libusblic]: https://github.com/libusb/libusb/blob/73a6eb8802d388c1150ec34a84a8c5af3fef738a/COPYING
[contention]: https://github.com/dognotdog/ptpwebcam/blob/ae70834f35ff9fb2bf3e63b905c670d514f94338/PtpWebcamCameraExtension/UsbPtpBridge.m
[dt]: https://github.com/darktable-org/darktable/blob/64051a66a3cc3e41dee057e13c17d5ae0e7f7b9c/src/common/camera_control.c
[c1]: https://support.captureone.com/hc/en-us/articles/360002718118
[sonyfaq]: https://support.d-imaging.sony.co.jp/app/imagingedge/en/faqs/#cnt2-5
[gpusb]: https://github.com/gphoto/libgphoto2/blob/6d5c61ef7687b74fe792e4aeae7fc40f2ad42d88/libgphoto2_port/libusb1/libusb1.c
[wireusb]: https://github.com/gphoto/libgphoto2/blob/6d5c61ef7687b74fe792e4aeae7fc40f2ad42d88/camlibs/ptp2/usb.c
[lib]: https://github.com/gphoto/libgphoto2/blob/6d5c61ef7687b74fe792e4aeae7fc40f2ad42d88/camlibs/ptp2/library.c
[codes]: https://github.com/gphoto/libgphoto2/blob/6d5c61ef7687b74fe792e4aeae7fc40f2ad42d88/camlibs/ptp2/ptp.h
[ptp]: https://github.com/gphoto/libgphoto2/blob/6d5c61ef7687b74fe792e4aeae7fc40f2ad42d88/camlibs/ptp2/ptp.c
[pack]: https://github.com/gphoto/libgphoto2/blob/6d5c61ef7687b74fe792e4aeae7fc40f2ad42d88/camlibs/ptp2/ptp-pack.c
[config]: https://github.com/gphoto/libgphoto2/blob/6d5c61ef7687b74fe792e4aeae7fc40f2ad42d88/camlibs/ptp2/config.c
[p1234]: https://github.com/gphoto/libgphoto2/pull/1234
[p1067]: https://github.com/gphoto/libgphoto2/pull/1067
[i937]: https://github.com/gphoto/libgphoto2/issues/937
[zve1]: https://github.com/gphoto/libgphoto2/issues/1096
[fx]: https://github.com/gphoto/libgphoto2/issues/1073
[m3app]: https://github.com/adub08/SonyCamera2MQTT/blob/6088fb1e173c59424d63c4e42ff0d7b0e4feff95/app/sony_ptp.py
[lvissue]: https://github.com/gphoto/gphoto2/issues/389
[lvmodels]: https://github.com/dognotdog/ptpwebcam/blob/ae70834f35ff9fb2bf3e63b905c670d514f94338/CAMERAS.md

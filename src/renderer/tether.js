// Tethered capture: the Tether workspace (dock, stage bar, aids drawer, inspector histogram), Live View, follow policy and review aids.
// Camera control needs the desktop shell (api.canTether); composition aids work everywhere.
(root => {
  const O = root.PhotoCullOverlays, N = root.PhotoCullNaming, D = root.PhotoCullDevelop;
  const $ = id => document.getElementById(id);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const clone = value => structuredClone(value);
  const GiB = 1024 ** 3;
  const GROUPS = [['wb', 'White balance'], ['light', 'Light'], ['curve', 'Curve'], ['detailColor', 'Detail & color'], ['optics', 'Optics'], ['orientation', 'Orientation']];
  const TOKENS = [['Name', '{Name}'], ['Counter:4', '{Counter:4}'], ['Date', '{Date}'], ['Time', '{Time}'], ['ISO', '{ISO}'], ['Shutter', '{Shutter}'], ['Aperture', '{Aperture}'], ['Subfolder', '{Subfolder}'], ['CameraCounter', '{CameraCounter}'], ['Original', '{Original}']];
  const PROPERTY_ORDER = ['program', 'shutter', 'aperture', 'iso', 'evComp', 'flashMode', 'flashComp', 'felState', 'wbMode', 'kelvin', 'drive', 'focusMode', 'focusArea', 'metering', 'quality', 'rawCompression', 'hostFileTypes', 'hostImageSize', 'saveDestination', 'exposureMeter', 'levelRoll', 'levelPitch'];
  const EV_KEYS = new Set(['evComp', 'flashComp']);
  const propertyText = (key, p) => { const text = p.display ?? (p.value == null ? '—' : String(p.value)); return EV_KEYS.has(key) && p.value != null && !/ev/i.test(text) ? `${text} EV` : text; };
  const CHECKLISTS = {
    a7m3: { note: 'Use USB for α7 III tethered RAW capture. The α7C II also supports Wi-Fi.', steps: ['MENU → Network → Ctrl w/ Smartphone: Off, then Setup → USB Connection: PC Remote.', 'Setup → PC Remote Settings → Still Img. Save Dest.: PC Only or PC+Camera (set this before connecting).', 'Setup → PC Remote Settings → RAW+J PC Save Img: choose RAW & JPEG, JPEG Only or RAW only.', 'Connect a data USB cable directly to this computer, not through a hub.', 'Quit Imaging Edge, Capture One or any app that may hold the camera.'],
      studio: ['Silent Shooting → Off: the electronic shutter disables the hot-shoe trigger.', 'Live View Display → Setting Effect OFF if Live View goes dark under manual strobe exposure.', 'White Balance → Flash or a fixed 5500 K, not AWB, so strobe color stays locked.', 'Keep the shutter at 1/200–1/250 s or slower for non-HSS strobes such as the MS300V.'] },
    a7c2: { steps: ['Disconnect any smartphone session, then MENU → Setup → USB → USB Connection Mode: PC Remote (or Sel. When Connect → Remote Shoot).', 'MENU → Network → Cnct./PC Remote → Remote Shoot Setting → Still Img. Save Dest.: Destination Only, or Dest.+Camera with a card inserted.', 'Remote Shoot Setting → RAW+J Save Image and Save Image Size: Original.', 'Connect USB-C directly with a data cable and quit other apps that may hold the camera.'] },
    'a7c2-wifi': { steps: ['Disconnect any smartphone session first.', 'Studio Wi-Fi: MENU → Network → Wi-Fi → Access Point Set. to join the studio network, then Wi-Fi Connect: On. Put this computer on the same network.', 'Wi-Fi Direct instead: Network → Cnct./PC Remote → PC Remote Function → Wi-Fi Direct Info. Join the DIRECT-…:ILCE-7CM2 network it shows, then Add by IP 192.168.122.1.', 'Network → Cnct./PC Remote → PC Remote Function → PC Remote: On.', 'Access Authen. On (recommended): Network Option → Access Authen. Info shows the SSH username, password and key fingerprint. With it Off, open PC Remote Function → Pairing and approve PhotoCull on the camera.', 'Remote Shoot Setting → Still Img. Save Dest.: Destination Only, or Dest.+Camera with a card inserted.', 'On macOS, allow PhotoCull in System Settings → Privacy & Security → Local Network.'] },
  };
  const CHECK_TABS = [['a7m3', 'tether-check-a7m3'], ['a7c2', 'tether-check-a7c2'], ['a7c2-wifi', 'tether-check-a7c2-wifi']];
  const transportOf = device => /wifi|ptpip/i.test(device?.transport || '') ? 'wifi' : 'usb';
  const TRANSPORT_LABEL = { usb: 'USB', wifi: 'Wi-Fi' };
  const HOST_KEY = ['SSH_HOST_KEY_UNVERIFIED', 'SSH_HOST_KEY_CHANGED'];
  const WIFI_ERRORS = {
    LOCAL_NETWORK_DENIED: 'PhotoCull cannot reach the local network. Allow it in System Settings → Privacy & Security → Local Network, then try again.',
    CAMERA_UNREACHABLE: 'No camera answered at that address. Check that the camera and this computer share a network and PC Remote is On.',
    PAIRING_REFUSED: 'The camera declined. Open PC Remote Function → Pairing on the camera and try again.',
    CAMERA_BUSY: 'The camera is in use by another app or phone. Disconnect it there, then try again.',
    SSH_AUTH_FAILED: 'The camera rejected the username or password. Check Access Authen. Info on the camera.',
    SSH_CREDENTIALS_REQUIRED: 'Enter the SSH username and password shown in Access Authen. Info on the camera.',
    AUTH_MODE_REQUIRED: 'PhotoCull could not detect how this camera signs in. Choose SSH or Plaintext.',
    AUTH_CHOICE_REQUIRED: 'PhotoCull could not detect how this camera signs in. Choose SSH or Plaintext.',
  };
  // A numeric unicast IPv4 address: no names, loopback, multicast or broadcast.
  function cameraAddress(text) {
    const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
    if (!parts) return null;
    const octets = parts.slice(1).map(Number);
    if (parts.slice(1).some(o => o.length > 1 && o.startsWith('0')) || octets.some(o => o > 255) || [0, 127].includes(octets[0]) || octets[0] >= 224) return null;
    return octets.join('.');
  }
  const FOLLOW_LABEL = { whenReady: 'When Ready', immediately: 'Immediately', off: 'Off' };
  const bytesText = n => n >= GiB ? `${Math.round(n / GiB).toLocaleString()} GiB` : `${Math.round(n / 1024 ** 2).toLocaleString()} MiB`;
  function normalizeActions(actions) {
    if (!actions) return {};
    if (Array.isArray(actions)) return Object.fromEntries(actions.filter(a => a?.key).map(a => [a.key, { available: a.available !== false, reason: a.reason || '' }]));
    return Object.fromEntries(Object.entries(actions).map(([key, value]) => [key, typeof value === 'object' && value !== null ? { available: value.available !== false, reason: value.reason || '' } : { available: value !== false, reason: '' }]));
  }

  const FLASH_DEFAULTS = { syncLimit: 200, recycleMs: 0, misfireAlert: true, misfireChime: false };
  const signed = n => n > 0 ? `+${n}` : String(n);
  // Seconds from a camera shutter label such as 1/400, 1/250 s, 0.5", 2", 1"3 or 1.3; null for Bulb or anything unreadable.
  function parseShutterSeconds(label) {
    const text = String(label ?? '').trim().replace(/\s*(s|sec)$/i, '');
    let m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text);
    if (m) return Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
    m = /^(\d+)["″](\d+)$/.exec(text);
    if (m) return Number(`${m[1]}.${m[2]}`);
    m = /^(\d+(?:\.\d+)?)["″]?$/.exec(text);
    return m && Number(m[1]) > 0 ? Number(m[1]) : null;
  }
  // syncLimit is the fastest flash-safe shutter as a denominator (200 → 1/200 s); 0 turns the guard off.
  function isOverSyncLimit(shutterLabel, syncLimit) {
    const seconds = parseShutterSeconds(shutterLabel), limit = Number(syncLimit);
    return limit > 0 && seconds !== null && seconds < 1 / limit - 1e-9;
  }
  const linearLuma = Array.from({ length: 256 }, (_, bin) => {
    const v = bin / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });

  class FlashHistory {
    constructor(exposures = new Set()) { this.baseline = []; this.exposures = exposures; }
    kept(exposureId) { this.exposures.add(exposureId); }
    measure(exposureId, { luma, total }) {
      if (!total || this.exposures.has(exposureId)) return null;
      this.exposures.add(exposureId);
      let mean = 0, linear = 0, p95 = 0, count = 0;
      for (let bin = 0; bin < luma.length; bin++) {
        mean += bin * luma[bin] / total;
        linear += linearLuma[bin] * luma[bin] / total;
        if (count <= total * 0.95 && luma[bin]) p95 = bin;
        count += luma[bin];
      }
      const n = this.baseline.length;
      const baseline = n && this.baseline.reduce((sum, s) => sum + s.linear, 0) / n;
      const highlights = n && this.baseline.reduce((sum, s) => sum + s.p95, 0) / n;
      const dropped = baseline >= 0.03 && linear < baseline * 0.18 && p95 < highlights * 0.55;
      if (dropped || mean < 14 && p95 < 45) {
        const detail = dropped && linear > 0 ? `${Math.log2(baseline / linear).toFixed(1)} stops darker than recent shots` : 'The frame is almost black';
        return { misfire: true, detail };
      }
      this.baseline.push({ linear, p95 });
      if (this.baseline.length > 3) this.baseline.shift();
      return { misfire: false, detail: '' };
    }
  }

  class Tether {
    constructor(host) {
      this.host = host; this.api = host.api;
      this.shoot = null; this.jobName = '';
      this.camera = { state: 'offline', epoch: 0, device: null, properties: new Map(), propRev: 0, actions: {}, capabilities: {}, devices: [], deviceId: null, paused: false, reason: '' };
      // wanted: the user asked for Live View, so a stream the camera restarts after a reconnect is adopted.
      this.live = { enabled: false, wanted: false, streamId: null, retired: new Set(), seq: 0, open: false, docked: false, loupe: false, center: { x: .5, y: .5 }, bitmap: null, fps: 0, frames: [], poll: 0, size: null };
      this.follow = { paused: false, autoPaused: false, pending: 0, latestOrdinal: 0, shownOrdinal: 0, latestId: null, epoch: 0 };
      this.telemetry = { queued: 0, receiving: 0, mbps: null, latency: null };
      this.issues = new Map(); this.checklist = 'a7m3'; this.primarySeq = 0; this.primaryTimer = 0; this.primaryAck = 0; this.primaryPending = null; this.primaryRequest = null; this.developedUrls = new Map();
      this.wifi = { busy: false, pending: null }; this.histogramKey = ''; this.liveHistogramAt = 0;
      this.saveTimer = 0; this.savePatch = {}; this.unsaved = []; this.edits = 0; this.saves = Promise.resolve(); this.asset = null; this.assetName = '';
      this.reviewFrame = null; this.namingTimer = 0; this.namingGeneration = 0; this.hold = null; this.focusRepeat = null;
      // want: the test shot being fetched, so a slower earlier fetch never replaces a newer frame.
      this.test = { active: false, hasShot: false, awaitingShot: false, busy: false, frame: null, want: null, testSeq: null, pairComplete: true, restoreLiveExpanded: false };
      this.recycleUntil = 0; this.recycleTimer = 0; this.wbArmed = false; this.wbBusy = false;
      this.recent = []; this.opening = false; this.openSeq = 0;
      this.misfire = { history: new FlashHistory(), shown: false, detail: '', chain: Promise.resolve() };
      this.build();
      this.layer = new O.OverlayLayer(host.reviewViewport, {
        geometry: () => { const v = host.reviewView, d = v.drawn; return d && v.visible ? { rect: { x: d.left, y: d.top, width: d.width, height: d.height } } : null; },
        pixels: max => this.reviewPixels(max), onMove: (position, done) => this.overlayMoved(position, done), onStatus: text => this.compositionStatus(text),
      });
      this.liveLayer = new O.OverlayLayer($('tether-live-viewport'), { geometry: () => this.liveGeometry(), live: true, onMove: (position, done) => this.overlayMoved(position, done) });
      this.subscribe();
      this.render();
      void this.loadRecent();
    }

    // ---- State and configuration ----
    active() { return !!this.shoot; }
    async hasPendingWork() {
      const shoot = this.shoot;
      if (!shoot) return false;
      const state = await this.api.tetherState(shoot.session);
      const queue = state?.queue;
      return state?.shootId !== shoot.shootId || this.shoot?.shootId !== shoot.shootId ||
        !!this.capturing || this.telemetry.receiving > 0 || this.telemetry.queued > 0 ||
        queue?.receiving > 0 || queue?.pending > 0 || queue?.pendingPairs > 0 || queue?.held > 0 ||
        state.space?.reservedBytes > 0 || this.test.busy || this.test.hasShot || !!this.test.awaitingShot;
    }
    connected() { return ['ready', 'paused', 'busy'].includes(this.camera.state); }
    settings() { return this.host.settings().tether || {}; }
    config() { return this.shoot?.config || this.settings(); }
    composition() { return this.config().composition || {}; }
    stageExpanded() { return this.live.open && !this.live.docked; }
    reviewTools() { return this.active(); }
    studio() { return !!this.host.studio(); }
    defaultJob() { return this.host.session()?.folder.split(/[\\/]/).filter(Boolean).pop() || 'Capture'; }
    actionState(key) { return this.camera.actions?.[key] || { available: true, reason: '' }; }
    canCapture() {
      if (!this.api.canTether) return 'Tethering needs the PhotoCull desktop app.';
      if (!this.shoot) return 'Start a tethered session first.';
      if (!this.connected()) return this.camera.state === 'lost' ? 'Camera connection lost. Reconnecting…' : 'Connect a camera to capture.';
      if (this.camera.paused || this.camera.state === 'paused') return 'Tether is paused. Resume to capture (Shift+T).';
      if (this.cameraOnly()) return 'The camera saves to its card only. Choose a destination that sends files to this computer.';
      const trigger = this.actionState('trigger');
      if (!trigger.available) return trigger.reason || 'This camera does not accept a software shutter. Use the camera’s shutter button.';
      if (this.spaceBlocked()) return 'Not enough free space at the capture location.';
      if (this.recycling()) return 'Strobe recycling. The camera’s own shutter still fires.';
      return '';
    }
    cameraOnly() { const p = this.camera.properties.get('saveDestination'); return !!p && /camera only/i.test(String(p.display ?? p.value ?? '')); }
    spaceBlocked() { const s = this.shoot?.space; return !!s && (s.estimatedShots === 0 || Number.isFinite(s.freeBytes) && s.freeBytes < 512 * 1024 ** 2); }
    enabled(id) {
      const desktop = ['tether-start', 'tether-stop', 'tether-shutter', 'tether-pause', 'tether-live-view', 'tether-af', 'tether-new-shot', 'tether-counter-reset', 'tether-composition'];
      if (desktop.includes(id) && !this.api.canTether) return false;
      switch (id) {
        case 'tether-start': return !this.shoot;
        case 'tether-stop': return !!this.shoot;
        case 'tether-shutter': return !this.canCapture();
        case 'tether-pause': return !!this.shoot && this.connected();
        case 'tether-af': return !!this.shoot && this.connected() && (this.actionState('halfPress').available || this.actionState('af').available);
        case 'tether-live-view': return this.live.open || !!this.shoot && this.connected() && this.actionState('liveView').available;
        case 'tether-new-shot': case 'tether-counter-reset': return !!this.shoot;
        case 'tether-composition': return this.test.active || !!this.shoot && this.connected();
        case 'tether-overlay-toggle': return !!this.asset;
        case 'tether-jump-latest': return !!this.follow.latestId && !!this.host.item(this.follow.latestId);
        case 'tether-pin-reference': { const item = this.host.photo(); return !!item && !item.trashed; }
        default: return true;
      }
    }

    async refreshState(session = this.host.session()?.id) {
      if (!session) return;
      try {
        const value = await this.api.tetherState(session);
        if (value?.shootId) this.setShoot(value);
        else if (this.shoot && this.shoot.session === session) this.setShoot(null);
      } catch (error) { if (this.api.canTether) this.host.toast(error.message); }
    }
    setShoot(value) {
      const changed = value?.shootId !== this.shoot?.shootId;
      if (changed || value?.location?.relative !== this.shoot?.location?.relative) this.resetMisfire(changed);
      this.shoot = value ? { ...value } : null;
      if (changed) {
        this.openSeq++;
        this.telemetry.queued = this.telemetry.receiving = 0;
        this.follow = { paused: false, autoPaused: false, pending: 0, latestOrdinal: 0, shownOrdinal: 0, latestId: null, epoch: 0 };
        const latest = value && (this.host.session()?.items || []).filter(i => i.ordinal).sort((a, b) => b.ordinal - a.ordinal)[0];
        if (latest) { this.follow.latestOrdinal = this.follow.shownOrdinal = latest.ordinal; this.follow.latestId = latest.id; }
        this.issues.clear(); for (const issue of value?.issues || []) this.issues.set(this.issueKey(issue), issue);
        this.jobName = value?.config?.jobName || ''; void this.loadAsset();
        clearTimeout(this.primaryTimer); this.primaryAck = 0; this.primaryPending = null; this.primaryRequest = null;
        this.stopRecycle(); this.resetTest();
      }
      this.composeChanged(); this.render();
    }
    sessionLoaded(session) {
      for (const url of this.developedUrls.values()) URL.revokeObjectURL(url);
      this.developedUrls.clear(); this.reviewFrame = null; if (!this.shoot || this.shoot.session !== session?.id) { this.setShoot(null); } void this.refreshState(session?.id); }

    // Shoot config goes to the ledger; without a shoot the panel edits the defaults for the next shoot.
    update(patch, { delay = 0 } = {}) {
      const target = this.config();
      for (const [key, value] of Object.entries(patch)) target[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...target[key], ...value } : value;
      for (const [key, value] of Object.entries(patch)) this.savePatch[key] = key === 'composition' ? { ...this.savePatch.composition, ...value } : target[key];
      this.edits++; clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), delay);
      if (patch.composition) this.composeChanged();
      this.render();
    }
    save() {
      const patch = this.savePatch; this.savePatch = {};
      if (!Object.keys(patch).length) return this.saves;
      if (patch.composition) patch.composition = Object.fromEntries(Object.keys(patch.composition).map(k => [k, clone(this.composition()[k])]));
      const edits = this.edits, shoot = this.shoot;
      this.unsaved.push(patch);
      this.saves = this.saves.catch(() => {}).then(async () => {
        if (shoot) {
          let result;
          try { result = await this.api.tetherConfig(shoot.shootId, this.shoot.configRev, patch); }
          catch (error) {
            if (error.code !== 'STALE_REV') throw error;
            await this.refreshState(shoot.session); result = await this.api.tetherConfig(shoot.shootId, this.shoot.configRev, patch);
          }
          if (this.shoot?.shootId !== shoot.shootId) return;
          this.shoot.configRev = result.configRev;
          if (edits === this.edits) { this.shoot.config = result.config; this.composeChanged(); }
          this.saveFailed = false;
        } else {
          const { jobName, ...rest } = patch;
          if (this.settings().version !== 1) throw new Error('Tether settings were saved by a newer PhotoCull and are left unchanged.');
          if (Object.keys(rest).length) await this.host.saveSettings({ tether: rest });
          // The reply predates edits still queued behind this save; keep showing those.
          const fresh = this.settings();
          for (const later of [...this.unsaved.slice(this.unsaved.indexOf(patch) + 1), this.savePatch])
            for (const [key, value] of Object.entries(later)) if (key !== 'jobName') fresh[key] = key === 'composition' ? { ...fresh.composition, ...value } : value;
          this.composeChanged();
        }
        this.render();
      }).catch(error => { if (shoot) this.saveFailed = true; this.host.toast(error.message); this.render(); }).finally(() => this.unsaved.splice(this.unsaved.indexOf(patch), 1));
      return this.saves;
    }
    flush() { clearTimeout(this.saveTimer); return this.save(); }
    setComposition(section, patch, delay = 250) { this.update({ composition: { [section]: { ...this.composition()[section], ...patch } } }, { delay }); }
    toggleAid(section) { const shown = !this.composition()[section]?.shown; this.setComposition(section, { shown }, 0); return shown; }

    // ---- Events ----
    subscribe() {
      const api = this.api;
      api.onTetherConfig(event => {
        if (!this.shoot || event.session !== this.shoot.session || event.configRev <= this.shoot.configRev) return;
        if (event.location?.relative !== this.shoot.location?.relative) this.resetMisfire();
        Object.assign(this.shoot, { configRev: event.configRev, location: event.location, counters: event.counters });
        if (!Object.keys(this.savePatch).length) { this.shoot.config = event.config; this.composeChanged(); }
        this.render();
      });
      api.onTetherLibrary(delta => this.receiveDelta(delta));
      api.onTetherConnection(event => { if (this.shoot && event.shootId && event.shootId !== this.shoot.shootId) return; this.applyConnection(event); });
      api.onTetherProperties(event => {
        if (event.epoch !== this.camera.epoch || event.propRev <= this.camera.propRev) return;
        for (const p of event.changed || []) this.camera.properties.set(p.key, p);
        for (const key of event.removed || []) this.camera.properties.delete(key);
        if (event.actions) this.camera.actions = normalizeActions(event.actions);
        if (event.capabilities) this.camera.capabilities = event.capabilities;
        this.camera.propRev = event.propRev; this.render();
      });
      api.onTetherComposition(event => void this.receiveComposition(event));
      api.onTetherTransfer(event => {
        if (this.shoot && event.shootId && event.shootId !== this.shoot.shootId) return;
        Object.assign(this.telemetry, { queued: event.queued ?? this.telemetry.queued, receiving: event.receiving ?? this.telemetry.receiving, mbps: event.mbps ?? this.telemetry.mbps, latency: event.latency ?? this.telemetry.latency });
        if (this.shoot && Number.isFinite(event.freeBytes)) this.shoot.space = { ...this.shoot.space, freeBytes: event.freeBytes, estimatedShots: event.estimatedShots ?? this.shoot.space?.estimatedShots };
        this.renderTelemetry(); this.renderLocation();
      });
      api.onTetherLive(event => {
        if (event.epoch !== this.camera.epoch || this.shoot && event.shootId && event.shootId !== this.shoot.shootId) return;
        if (event.streamId && this.live.retired.has(event.streamId)) return;
        if (event.state === 'streaming' && event.streamId && event.streamId !== this.live.streamId) {
          if (!this.live.wanted) return;
          this.adoptStream(event.streamId);
        } else if (event.streamId && this.live.streamId && event.streamId !== this.live.streamId) return;
        else if (['off', 'stopped', 'closed', 'error'].includes(event.state)) { this.retireStream(); this.live.enabled = false; }
        $('tether-live-status').textContent = event.reason || `Live View ${event.state}`;
        if (Number.isFinite(event.deliveredFps)) this.live.fps = event.deliveredFps;
        this.renderLive();
      });
      api.onTetherIssue(issue => {
        if (this.shoot && issue.shootId && issue.shootId !== this.shoot.shootId) return;
        this.issues.set(this.issueKey(issue), issue); this.renderIssues();
      });
    }
    issueKey(issue) { return `${issue.exposureId || issue.keepId || ''}:${issue.memberId || ''}:${issue.code}`; }

    receiveDelta(delta) {
      if (!this.shoot || delta.shootId && delta.shootId !== this.shoot.shootId || delta.session !== this.host.session()?.id) return;
      const rev = this.shoot.libraryRev ?? 0;
      if (delta.rev <= rev) return;
      if (delta.firstArrival && this.connected()) this.startRecycle();
      if (delta.rev > rev + 1) { void this.resyncLibrary(); return; }
      this.shoot.libraryRev = delta.rev;
      const remap = new Map((delta.remap || []).map(r => [r.from, r.to]));
      if (remap.has(this.follow.latestId)) this.follow.latestId = remap.get(this.follow.latestId);
      this.host.applyDelta(delta);
      if (delta.firstArrival) {
        const exposureId = delta.exposureId || this.host.item(delta.itemId)?.exposureId;
        if (exposureId && this.flash().misfireAlert) this.queueLuma(exposureId, () => this.itemFrame(delta.itemId), this.pendingKeep);
      }
      if (delta.firstArrival && delta.ordinal > this.follow.latestOrdinal) {
        this.follow.latestOrdinal = delta.ordinal; this.follow.latestId = delta.itemId;
        if (this.settings().chime) this.chime();
        this.arrived(delta.itemId, delta.ordinal);
      } else this.renderPill();
      if (delta.firstArrival && delta.ordinal) this.shoot.counters && this.refreshCounters();
    }
    async resyncLibrary() {
      if (!this.shoot) return;
      try {
        const value = await this.api.tetherLibrary(this.shoot.shootId, this.shoot.session);
        this.shoot.libraryRev = value.rev; this.host.replaceLibrary(value.library);
        if (value.latestOrdinal > this.follow.latestOrdinal) {
          const latest = value.library.items.filter(i => i.ordinal === value.latestOrdinal)[0];
          this.follow.latestOrdinal = value.latestOrdinal; this.follow.latestId = latest?.id || this.follow.latestId;
        }
        this.renderPill();
      } catch (error) { this.host.toast(error.message); }
    }
    async refreshCounters() { try { const value = await this.api.tetherState(this.shoot.session); if (value?.shootId === this.shoot?.shootId) { Object.assign(this.shoot, { counters: value.counters, space: value.space, queue: value.queue, configRev: Math.max(this.shoot.configRev, value.configRev) }); this.render(); } } catch {} }

    // ---- Viewer follow ----
    followMode() { return this.config().follow?.mode || 'whenReady'; }
    // Pausing on inspection happens here so a capture arriving mid-zoom never pulls the view away.
    followable() {
      if (this.config().follow?.pauseOnInspect !== false && this.host.inspecting() && !this.follow.paused) { this.follow.paused = true; this.follow.autoPaused = true; }
      return this.followMode() !== 'off' && !this.follow.paused;
    }
    arrived(id, ordinal) {
      const mode = this.followMode(), pinned = this.host.survey().pinned();
      if (!this.followable()) { this.follow.pending++; this.renderPill(); this.render(); return; }
      if (!this.host.visible(id) && !pinned) { this.follow.pending++; this.renderPill(); return; }
      void this.present(id, ordinal, mode);
    }
    // Decoding and deferred retries can outlast a pause, Off or a new inspection, so eligibility is checked again at the moment of display.
    async present(id, ordinal, mode, epoch = this.follow.epoch) {
      const item = this.host.item(id); if (!item) return;
      const developed = this.developedWanted(item) ? this.developedFrame(item) : null;
      let handedOff = false;
      try { handedOff = await this.commit(item, ordinal, mode, epoch, developed); }
      finally { if (developed && !handedOff) void developed.then(frame => frame && URL.revokeObjectURL(frame.url)); }
    }
    // True when the developed frame was handed to the display, which then owns its object URL.
    async commit(item, ordinal, mode, epoch, developed) {
      const id = item.id;
      if (mode === 'whenReady' && !(developed && await developed)) {
        const image = new Image(); image.src = this.host.imageUrl(item, 'preview');
        try { await image.decode(); } catch { this.follow.pending++; this.renderPill(); return false; }
      }
      const stale = () => epoch !== this.follow.epoch || ordinal < this.follow.shownOrdinal || ordinal < this.follow.latestOrdinal && this.follow.latestId !== id;
      if (stale()) return false;
      if (!this.followable()) { this.follow.pending++; this.renderPill(); this.render(); return false; }
      if (this.host.blocked()) { setTimeout(() => { if (epoch === this.follow.epoch) void this.present(this.follow.latestId, this.follow.latestOrdinal, mode, epoch); }, 600); return false; }
      const survey = this.host.survey(), pinned = survey.pinned();
      this.presenting = true;
      try { if (pinned) survey.setCandidate(id); else this.host.show(id); } finally { this.presenting = false; }
      if (pinned ? survey.pinned()?.candidate !== id : this.host.photo()?.id !== id) { this.follow.pending++; this.renderPill(); return false; }
      this.follow.shownOrdinal = ordinal; this.follow.pending = 0;
      this.renderPill();
      if (this.shoot && item.exposureId) void this.api.tetherPresented(this.shoot.shootId, item.exposureId, ordinal, mode === 'whenReady' ? 'settled' : 'quick').catch(() => {});
      if (!developed || pinned) return false;
      void developed.then(frame => this.showDeveloped(id, frame));
      return true;
    }
    developedWanted(item) { return !!this.config().follow?.developedReview && !!item.raw && !item.trashed && !!this.api.canDevelop; }
    // Resolves to a decoded developed frame, or null so the camera preview stays.
    async developedFrame(item) {
      const session = this.host.session()?.id; let url = null;
      try {
        const saved = await this.api.developGet(session, item.id);
        const frame = await this.api.developRender(session, item.id, saved.settings, true);
        url = URL.createObjectURL(frame.blob);
        const probe = new Image(); probe.src = url; await probe.decode();
        if (this.host.session()?.id !== session) throw new Error('Session changed.');
        return { url, width: probe.naturalWidth, height: probe.naturalHeight, wb: saved.settings?.wb || {} };
      } catch { if (url) URL.revokeObjectURL(url); return null; }
    }
    showDeveloped(id, frame) {
      if (!frame) return;
      if (this.host.photo()?.id !== id || !this.host.showDeveloped(id, frame)) { URL.revokeObjectURL(frame.url); return; }
      const old = this.developedUrls.get(id); this.developedUrls.set(id, frame.url);
      if (old) URL.revokeObjectURL(old);
    }
    navigated() { if (!this.presenting) this.follow.epoch++; }
    settingsChanged() { if (!this.shoot) this.composeChanged(); this.render(); }
    jumpLatest() {
      const id = this.follow.latestId; if (!id || !this.host.item(id)) return;
      if (this.stageExpanded()) this.closeStage();
      if (!this.host.visible(id)) this.host.showAll();
      this.follow.epoch++; this.follow.shownOrdinal = Math.max(this.follow.shownOrdinal, this.host.item(id).ordinal || 0); this.follow.pending = 0;
      const survey = this.host.survey(), pinned = survey.pinned();
      if (pinned) { survey.setCandidate(id); survey.activate(pinned.reference === id ? 0 : 1); } else this.host.show(id, { review: true });
      this.renderPill();
    }
    toggleFollowPause() {
      this.follow.paused = !this.follow.paused; this.follow.autoPaused = false;
      if (!this.follow.paused && this.follow.latestOrdinal > this.follow.shownOrdinal && this.followMode() !== 'off') void this.present(this.follow.latestId, this.follow.latestOrdinal, this.followMode());
      this.render(); this.renderPill();
    }
    pinReference(id = this.host.photo()?.id) {
      if (!id) return this.host.toast('Select a photo to pin as the reference.');
      if (!this.host.pin(id)) return this.host.toast('That photo cannot be a reference.');
      const latest = this.follow.latestId;
      if (latest && latest !== id && this.host.item(latest)) this.host.survey().setCandidate(latest);
      this.render();
    }
    renderPill() {
      const pill = $('tether-arrival-pill'), id = this.follow.latestId, item = id && this.host.item(id);
      const outside = !!item && !this.host.visible(id), behind = !!item && this.follow.latestOrdinal > this.follow.shownOrdinal && (this.follow.pending > 0 || outside);
      pill.hidden = !behind;
      if (!behind) return;
      pill.textContent = outside ? 'Latest capture outside filter — Show in All' : `New capture arrived${this.follow.pending > 1 ? ` (${this.follow.pending})` : ''} — Jump to latest (Y)`;
    }

    // ---- Panel ----
    build() {
      $('tether-sidebar-start').onclick = () => this.shoot ? this.openPanel() : this.openStart();
      $('tether-dock-start').onclick = () => this.openStart();
      $('tether-stop').onclick = () => void this.stopSession();
      for (const [key, id] of CHECK_TABS) $(id).onclick = () => { this.checklist = key; this.renderChecklist(); };
      $('tether-check-a7m3').parentElement.addEventListener('keydown', event => {
        const index = CHECK_TABS.findIndex(([key]) => key === this.checklist), last = CHECK_TABS.length - 1;
        const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: last }[event.key]; if (next === undefined) return;
        event.preventDefault(); event.stopPropagation();
        const [key, id] = CHECK_TABS[(next + CHECK_TABS.length) % CHECK_TABS.length]; this.checklist = key; this.renderChecklist(); $(id).focus();
      });
      $('tether-discover').onclick = () => void this.discover();
      // Wi-Fi: discovery is a user action because it can trigger the macOS Local Network prompt.
      $('tether-wifi-discover').onclick = () => void this.discoverWifi();
      $('tether-wifi-add').onclick = () => this.toggleWifiForm();
      $('tether-wifi-cancel').onclick = () => this.toggleWifiForm(false);
      $('tether-wifi-auth').onchange = () => { this.wifi.pending = null; $('tether-wifi-status').textContent = ''; this.renderWifi(); };
      $('tether-wifi-ip').oninput = () => $('tether-wifi-ip').removeAttribute('aria-invalid');
      $('tether-wifi-form').onsubmit = event => { event.preventDefault(); void this.addWifi(); };
      $('tether-wifi-trust').onclick = () => void this.addWifi(this.wifi.pending?.fingerprint);
      $('tether-wifi-trust-cancel').onclick = () => { this.wifi.pending = null; this.clearSecret(); $('tether-wifi-status').textContent = 'Not connected. The camera key was not trusted.'; this.renderWifi(); $('tether-wifi-connect').focus(); };
      $('tether-wifi-form').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.toggleWifiForm(false); } });
      $('tether-reconnect').onclick = () => void this.control('reconnect');
      $('tether-disconnect').onclick = () => void this.control('disconnect');
      $('tether-capture').onclick = () => void this.capture();
      $('tether-fel').onclick = () => void this.control('fel');
      for (const id of ['tether-composition-toggle', 'tether-stage-composition']) $(id).onclick = () => void this.toggleComposition();
      $('tether-composition-keep').onclick = () => void this.resolveTestShot('keep');
      $('tether-composition-discard').onclick = () => void this.resolveTestShot('discard');
      // Studio flash
      $('tether-flash-sync').onchange = () => this.update({ flash: { syncLimit: Number($('tether-flash-sync').value) } });
      $('tether-flash-recycle').onchange = () => { this.update({ flash: { recycleMs: Number($('tether-flash-recycle').value) } }); if (this.recycling()) this.stopRecycle(); };
      $('tether-flash-misfire').onchange = () => { const on = $('tether-flash-misfire').checked; this.update({ flash: { misfireAlert: on } }); if (!on) this.resetMisfire(); };
      $('tether-flash-misfire-chime').onchange = () => this.update({ flash: { misfireChime: $('tether-flash-misfire-chime').checked } });
      $('tether-misfire-dismiss').onclick = () => this.clearMisfire();
      $('tether-live-capture').onclick = () => void this.capture();
      $('tether-pause').onclick = () => void this.togglePause();
      $('tether-live-toggle').onclick = () => void this.toggleLive();
      this.bindHold($('tether-af'));
      // Location
      $('tether-choose-folder').onclick = () => void this.location({ op: 'choose' });
      $('tether-new-shot').onclick = () => this.newShot();
      $('tether-new-shot-cancel').onclick = () => { $('tether-new-shot-form').hidden = true; $('tether-new-shot').focus(); };
      $('tether-new-shot-form').onsubmit = event => { event.preventDefault(); const leaf = $('tether-new-shot-name').value.trim(); if (!leaf) return; void this.location({ op: 'create', parentRel: this.shoot?.location?.relative.split('/').slice(0, -1).join('/') || '', leaf, activate: $('tether-new-shot-activate').checked }).then(done => { if (done) $('tether-new-shot-form').hidden = true; }); };
      $('tether-recent-shots').onchange = () => { const relative = $('tether-recent-shots').value; if (relative) void this.location({ op: 'set', relative, activate: true }); };
      // Naming
      $('tether-tokens').replaceChildren(...TOKENS.map(([label, token]) => { const b = el('button', 'token-pill', '+' + label); b.type = 'button'; b.onclick = () => this.insertToken(token); return b; }));
      $('tether-job-name').oninput = () => { this.jobName = $('tether-job-name').value; if (this.shoot) this.update({ jobName: this.jobName }, { delay: 500 }); this.renderSample(); };
      $('tether-format').oninput = () => { const value = $('tether-format').value, check = N.validateCaptureTemplate(value); if (check.valid) this.update({ namingTemplate: value }, { delay: 500 }); this.renderSample(); };
      $('tether-counter-next').onchange = () => void this.counter('setNext', Number($('tether-counter-next').value));
      $('tether-counter-step').onchange = () => void this.counter('setStep', Number($('tether-counter-step').value));
      $('tether-counter-minus').onclick = () => void this.counter('decrement');
      $('tether-counter-plus').onclick = () => void this.counter('increment');
      $('tether-counter-reset').onclick = () => void this.counter('reset');
      // Adjustments & metadata
      $('tether-groups').append(...GROUPS.map(([key, label]) => { const row = el('label', 'toggle-row'), input = el('input'); input.type = 'checkbox'; input.dataset.group = key; input.onchange = () => this.update({ adjustments: { groups: [...$('tether-groups').querySelectorAll('input:checked')].map(i => i.dataset.group) } }); row.append(input, document.createTextNode(' ' + label)); return row; }));
      $('tether-adjust-mode').onchange = () => { const mode = $('tether-adjust-mode').value; this.update({ adjustments: { mode, ...(mode === 'recipe' && !this.config().adjustments?.recipeId ? { recipeId: $('tether-recipe').value || null } : {}) } }); if (mode === 'recipe') void this.loadRecipes(); this.schedulePrimary(); };
      $('tether-recipe').onchange = () => this.update({ adjustments: { recipeId: $('tether-recipe').value || null } });
      $('tether-entire').onchange = () => this.update({ adjustments: { entireRecipe: $('tether-entire').checked } });
      $('tether-developed').onchange = () => this.update({ follow: { developedReview: $('tether-developed').checked } });
      $('tether-metadata').onchange = () => this.update({ metadataPresetId: $('tether-metadata').value || null });
      $('tether-initial-pick').onchange = () => this.update({ initial: { pick: $('tether-initial-pick').value === '' ? null : $('tether-initial-pick').value === 'true' } });
      $('tether-initial-rating').onchange = () => this.update({ initial: { rating: $('tether-initial-rating').value === '' ? null : Number($('tether-initial-rating').value) } });
      $('tether-initial-color').onchange = () => this.update({ initial: { color: $('tether-initial-color').value || null } });
      // Composition
      const bind = (id, section, key, read = input => input.type === 'checkbox' ? input.checked : input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value, event = 'input') => {
        $(id).addEventListener(event, () => {
          const value = read($(id));
          if (typeof value === 'number' && !Number.isFinite(value)) return;
          this.setComposition(section, { [key]: value }, $(id).type === 'checkbox' || $(id).tagName === 'SELECT' ? 0 : 250);
        });
      };
      bind('tether-grid-shown', 'grid', 'shown', undefined, 'change'); bind('tether-grid-type', 'grid', 'type', undefined, 'change');
      bind('tether-grid-cols', 'grid', 'cols', input => Math.max(1, Math.min(128, Math.round(Number(input.value)))), 'change'); bind('tether-grid-rows', 'grid', 'rows', input => Math.max(1, Math.min(128, Math.round(Number(input.value)))), 'change');
      bind('tether-grid-mirror', 'grid', 'mirror', undefined, 'change'); bind('tether-grid-clockwise', 'grid', 'clockwise', undefined, 'change');
      bind('tether-grid-color', 'grid', 'color'); bind('tether-grid-opacity', 'grid', 'opacity');
      $('tether-guide-x').onclick = () => this.setComposition('grid', { shown: true, guides: [...(this.composition().grid?.guides || []), { axis: 'x', at: 0.5 }].slice(0, 64) }, 0);
      $('tether-guide-y').onclick = () => this.setComposition('grid', { shown: true, guides: [...(this.composition().grid?.guides || []), { axis: 'y', at: 0.5 }].slice(0, 64) }, 0);
      bind('tether-aspect-shown', 'aspect', 'shown', undefined, 'change'); bind('tether-aspect-ratio', 'aspect', 'ratio', undefined, 'change'); bind('tether-aspect-orientation', 'aspect', 'orientation', undefined, 'change'); bind('tether-aspect-matte', 'aspect', 'matte');
      bind('tether-overlay-shown', 'overlay', 'shown', undefined, 'change'); bind('tether-overlay-opacity', 'overlay', 'opacity'); bind('tether-overlay-scale', 'overlay', 'scale');
      bind('tether-overlay-x', 'overlay', 'x', input => Math.max(-1, Math.min(1, Number(input.value))), 'change'); bind('tether-overlay-y', 'overlay', 'y', input => Math.max(-1, Math.min(1, Number(input.value))), 'change');
      bind('tether-overlay-crop', 'overlay', 'followCrop', undefined, 'change');
      $('tether-overlay-file').onclick = () => void this.chooseOverlay('file');
      $('tether-overlay-photo').onclick = () => void this.chooseOverlay('session');
      $('tether-overlay-input').onchange = () => void this.loadOverlayFile($('tether-overlay-input').files[0]);
      $('tether-overlay-move').onclick = () => this.toggleMove();
      $('tether-overlay-clear').onclick = () => this.clearOverlay();
      bind('tether-mask-shown', 'mask', 'shown', undefined, 'change'); bind('tether-mask-color', 'mask', 'color'); bind('tether-mask-opacity', 'mask', 'opacity'); bind('tether-mask-threshold', 'mask', 'threshold');
      bind('tether-warning-shown', 'warning', 'shown', undefined, 'change'); bind('tether-warning-shadows', 'warning', 'shadows', undefined, 'change');
      for (const key of ['high', 'low']) $(`tether-warning-${key}`).addEventListener('change', () => {
        const high = Math.round(Number($('tether-warning-high').value)), low = Math.round(Number($('tether-warning-low').value));
        try { O.validWarning(high, low); this.compositionStatus('', 'validation'); this.setComposition('warning', { high, low }, 0); } catch (error) { this.compositionStatus(error.message, 'validation'); this.renderComposition(); }
      });
      // Stage bar: one-click aids, follow and reference
      $('tether-stage-live').onclick = () => void this.toggleLive();
      $('tether-stage-guides').onclick = () => this.toggleAid('grid');
      $('tether-stage-aspect').onclick = () => this.toggleAid('aspect');
      $('tether-stage-overlay').onclick = () => this.command('tether-overlay-toggle');
      $('tether-stage-mask').onclick = () => this.command('tether-focus-mask');
      $('tether-stage-warning').onclick = () => this.command('tether-exposure-warning');
      $('tether-aids-popover-btn').onclick = () => this.toggleDrawer();
      $('tether-wb-pick').onclick = () => this.toggleWhiteBalancePick();
      // While the eyedropper is armed a click samples the photo instead of zooming or panning it.
      const viewport = this.host.reviewViewport, swallow = event => { if (!this.wbArmed) return false; event.preventDefault(); event.stopImmediatePropagation(); return true; };
      for (const type of ['pointerdown', 'pointerup', 'dblclick']) viewport.addEventListener(type, swallow, true);
      viewport.addEventListener('click', event => { if (swallow(event)) void this.pickWhiteBalance(event); }, true);
      $('tether-aids-close').onclick = () => this.toggleDrawer(false);
      $('tether-aids-drawer').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.toggleDrawer(false); } });
      window.addEventListener('resize', () => { if (!$('tether-aids-drawer').hidden) this.placeDrawer(); });
      $('tether-follow-mode').onchange = () => this.update({ follow: { mode: $('tether-follow-mode').value } });
      $('tether-follow-pause').onclick = () => this.toggleFollowPause();
      $('tether-pin').onclick = () => this.host.survey().pinned() ? this.host.unpin() : this.pinReference();
      $('tether-autopause').onchange = () => this.update({ follow: { pauseOnInspect: $('tether-autopause').checked } });
      $('tether-chime').onclick = () => void this.host.saveSettings({ tether: { chime: !this.settings().chime } }).then(() => this.renderFollow(), error => this.host.toast(error.message));
      $('tether-arrival-pill').onclick = () => this.jumpLatest();
      // Resume, from the dock or the start dialog
      for (const prefix of ['tether-resume', 'tether-start-resume']) {
        $(`${prefix}-last`).onclick = () => void this.resume(this.lastResumable()?.shootId);
        $(`${prefix}-recent`).onchange = () => { const shootId = $(`${prefix}-recent`).value; $(`${prefix}-recent`).value = ''; if (shootId) void this.resume(shootId); };
      }
      // Start dialog
      $('tether-start-cancel').onclick = () => $('tether-start-dialog').close();
      $('tether-start-confirm').onclick = () => void this.start();
      // Live stage
      $('tether-live-close').onclick = () => void this.toggleLive(false);
      $('tether-live-dock').onclick = () => { this.live.docked = !this.live.docked; this.renderLive(); this.host.stageChanged(); };
      $('tether-live-loupe').onclick = () => { this.live.loupe = !this.live.loupe; this.paintLive(); this.renderLive(); };
      $('tether-live-reset').onclick = () => { this.live.center = { x: .5, y: .5 }; this.paintLive(); };
      $('tether-live-peaking').onclick = () => this.toggleAid('peaking');
      $('tether-peaking-color').oninput = () => this.setComposition('peaking', { color: $('tether-peaking-color').value });
      $('tether-peaking-sensitivity').oninput = () => this.setComposition('peaking', { sensitivity: Number($('tether-peaking-sensitivity').value) });
      $('tether-live-zebra').onclick = () => this.toggleAid('warning');
      $('tether-live-histogram-toggle').onclick = () => this.toggleAid('histogram');
      $('tether-live-guides').onclick = () => this.toggleAid('grid');
      $('tether-live-aspect').onclick = () => this.toggleAid('aspect');
      $('tether-live-overlay').onclick = () => this.command('tether-overlay-toggle');
      for (const button of document.querySelectorAll('[data-focus]')) this.bindFocusStep(button);
      this.bindLivePan();
      window.addEventListener('blur', () => this.releaseHold());
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseHold(); });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
        if (this.wbArmed) { event.preventDefault(); event.stopImmediatePropagation(); this.toggleWhiteBalancePick(false); }
        else if (this.stageExpanded()) { event.preventDefault(); event.stopImmediatePropagation(); this.closeStage(); }
        else if (!$('tether-aids-drawer').hidden && event.target === $('tether-aids-popover-btn')) { event.preventDefault(); event.stopImmediatePropagation(); this.toggleDrawer(false); }
      }, true);
      new ResizeObserver(() => this.paintLive()).observe($('tether-live-viewport'));
      new ResizeObserver(() => { if (this.live.open) this.placeStage(); }).observe($('image-stage'));
    }
    openPanel() { this.host.enterStudio(); this.host.revealDock(); }
    // The host calls this whenever the workspace mode changes.
    modeChanged() {
      if (!this.studio()) { this.toggleDrawer(false); return this.renderStatus(); }
      void this.loadRecipes(); this.renderSample(); this.render(); void this.renderHistogram();
    }
    toggleDrawer(open = $('tether-aids-drawer').hidden) {
      const drawer = $('tether-aids-drawer'), button = $('tether-aids-popover-btn'), wasOpen = !drawer.hidden, focused = drawer.contains(document.activeElement);
      if (open === wasOpen) return;
      drawer.hidden = !open; button.setAttribute('aria-expanded', String(open));
      if (open) { this.placeDrawer(); drawer.focus({ preventScroll: true }); }
      else if (focused) button.focus({ preventScroll: true });
    }
    // Hangs below the stage bar, under its toggle where the column allows.
    placeDrawer() {
      const drawer = $('tether-aids-drawer'), button = $('tether-aids-popover-btn'), main = drawer.offsetParent; if (!main) return;
      const b = button.getBoundingClientRect(), m = main.getBoundingClientRect(), width = drawer.offsetWidth;
      drawer.style.top = `${Math.round(b.bottom - m.top + 4)}px`;
      drawer.style.left = `${Math.round(Math.max(8, Math.min(m.width - width - 8, b.left - m.left)))}px`;
    }

    render() {
      this.renderStatus(); this.renderResume(); this.renderCamera(); this.renderWifi(); this.renderLocation(); this.renderNaming(); this.renderAdjustments(); this.renderComposition(); this.renderFollow(); this.renderTelemetry(); this.renderIssues(); this.renderLive(); this.renderPill(); this.renderTest(); this.renderWhiteBalancePick();
    }
    renderStatus() {
      const state = !this.api.canTether ? 'unavailable' : !this.shoot ? 'idle' : this.camera.state === 'offline' ? 'armed' : this.camera.paused ? 'paused' : this.camera.state;
      const labels = { unavailable: 'Desktop only', idle: 'Not tethered', armed: 'No camera', ready: this.camera.device?.model || 'Connected', paused: 'Paused', lost: 'Camera lost', reconnecting: 'Reconnecting…', discovering: 'Searching…', connecting: 'Connecting…', busy: 'Busy', draining: 'Finishing transfers…' };
      for (const id of ['tether-status-pill', 'tether-dock-status']) { const pill = $(id); pill.dataset.state = state; pill.textContent = labels[state] || state; }
      const start = $('tether-sidebar-start');
      start.textContent = this.shoot ? 'Open Tether' : 'Start…';
      start.title = this.shoot ? 'Open the Tether workspace' : this.api.canTether ? 'Start tethered session…' : 'Open the Tether workspace; camera control needs the desktop app';
      $('tether-dock-start').hidden = !!this.shoot || !this.api.canTether;
      $('tether-stop').hidden = !this.shoot || !this.api.canTether;
      const battery = this.battery(); $('tether-battery').hidden = !battery; $('tether-battery').textContent = battery;
      const dot = $('tether-mode-dot'), signal = this.live.enabled ? 'live' : this.connected() ? 'connected' : this.shoot ? 'armed' : '';
      dot.hidden = !signal; dot.dataset.state = signal;
      $('tether-mode').title = `Tether workspace${{ live: ' · Live View on', connected: ` · ${labels.ready} connected`, armed: ' · session running' }[signal] || ''}`;
      $('tether-panel-note').textContent = !this.api.canTether ? 'Camera control needs the PhotoCull desktop app. Composition aids, naming and follow defaults still work here.' : !this.shoot ? 'Editing defaults for the next tethered session.' : '';
    }
    lastResumable() { return this.recent.find(r => r.available) || null; }
    renderResume() {
      const last = this.lastResumable(), others = this.recent.filter(r => r !== last), show = this.api.canTether && !this.shoot && this.recent.length > 0;
      const when = r => new Date(r.stoppedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const where = r => r.shot ? `${r.name} / ${r.shot}` : r.name;
      const signature = JSON.stringify([this.recent, this.opening]);
      for (const prefix of ['tether-resume', 'tether-start-resume']) {
        const box = $(prefix), button = $(`${prefix}-last`), select = $(`${prefix}-recent`);
        box.hidden = !show;
        button.disabled = !last || this.opening; select.disabled = this.opening;
        if (box.dataset.signature === signature) continue;
        box.dataset.signature = signature;
        $(`${prefix}-last-name`).textContent = last ? where(last) : 'Earlier capture folders were moved or deleted';
        $(`${prefix}-last-meta`).textContent = last ? [`Next ${last.next}`, last.camera?.model, when(last)].filter(Boolean).join(' · ') : '';
        button.title = last ? `${last.folder}${last.layout === 'session' ? ' (session folders)' : ''}` : '';
        $(`${prefix}-earlier`).hidden = !others.length;
        const blank = el('option', null, `${others.length} earlier session${others.length === 1 ? '' : 's'}…`); blank.value = '';
        select.replaceChildren(blank, ...others.map(r => {
          const option = el('option', null, `${where(r)} · next ${r.next} · ${when(r)}${r.available ? '' : ' — folder missing'}`);
          option.value = r.shootId; option.disabled = !r.available; option.title = r.folder; return option;
        }));
        select.value = '';
      }
    }
    battery() {
      const p = this.camera.properties.get('battery'), b = this.camera.device?.battery;
      if (p) return p.display ?? (Number.isFinite(p.value) ? `${p.value}%` : '');
      if (!b) return '';
      return Number.isFinite(b.percent) ? `${b.percent}%` : Number.isFinite(b.level) && Number.isFinite(b.levels) ? `${'▮'.repeat(b.level)}${'▯'.repeat(Math.max(0, b.levels - b.level))}` : '';
    }
    renderCamera() {
      const online = this.connected() || ['lost', 'reconnecting', 'paused'].includes(this.camera.state);
      for (const node of document.querySelectorAll('#tether-tool-camera .tether-online')) node.hidden = !online;
      $('tether-offline').hidden = online;
      $('tether-offline-title').textContent = !this.api.canTether ? 'Camera control needs the desktop app' : this.camera.reason || (this.camera.state === 'discovering' ? 'Looking for cameras…' : 'No camera connected');
      $('tether-discover').disabled = !this.api.canTether || this.camera.state === 'discovering';
      $('tether-wifi-discover').disabled = !this.api.canTether || this.wifi.busy;
      $('tether-wifi-discover').title = this.api.canTether ? 'Listen for α7C II cameras on this network for a few seconds' : 'Wi-Fi discovery needs the PhotoCull desktop app';
      this.renderDevices();
      const device = this.camera.device, kind = transportOf(device || this.camera.devices.find(d => d.deviceId === this.camera.deviceId));
      $('tether-camera-model').textContent = device ? `${device.model || 'Camera'}${device.firmware ? ` · ${device.firmware}` : ''}` : '—';
      $('tether-camera-battery').textContent = this.battery() || 'Unavailable';
      const link = `${{ ready: 'Connected', paused: 'Connected', busy: 'Busy', lost: 'Lost', reconnecting: 'Lost' }[this.camera.state] || 'Disconnected'}${device?.speed ? ` · ${device.speed}` : ''}${kind === 'wifi' && device?.auth ? ` · ${device.auth === 'ssh' ? 'SSH' : 'Pairing'}` : ''}`;
      $('tether-camera-usb').replaceChildren(el('span', `tether-transport ${kind}`, TRANSPORT_LABEL[kind]), document.createTextNode(` ${link}`));
      const dest = this.camera.properties.get('saveDestination'), destination = $('tether-camera-destination');
      destination.textContent = dest ? dest.display ?? String(dest.value) : '—'; destination.dataset.level = this.cameraOnly() ? 'warn' : dest ? 'ok' : '';
      $('tether-destination-warning').hidden = !this.cameraOnly();
      const reason = this.canCapture();
      for (const id of ['tether-capture', 'tether-live-capture']) { $(id).disabled = !!reason; $(id).setAttribute('aria-disabled', String(!!reason)); }
      $('tether-capture-reason').textContent = reason;
      this.renderRecycle();
      $('tether-af').disabled = !this.enabled('tether-af');
      $('tether-pause').disabled = !this.enabled('tether-pause');
      $('tether-pause').setAttribute('aria-pressed', String(this.camera.paused)); $('tether-pause').textContent = this.camera.paused ? 'Resume' : 'Pause';
      $('tether-live-toggle').disabled = !this.enabled('tether-live-view'); $('tether-live-toggle').setAttribute('aria-pressed', String(this.live.open));
      $('tether-reconnect').disabled = !this.shoot || !this.camera.deviceId; $('tether-disconnect').disabled = !this.connected();
      for (const span of $('tether-lcd').children) {
        const key = span.dataset.lcd, p = this.camera.properties.get(key), text = p ? String(p.display ?? p.value ?? '—') : '—';
        span.textContent = key === 'iso' && !/iso/i.test(text) ? `ISO ${text}` : key === 'evComp' && p && !/ev/i.test(text) ? `${text} EV` : text;
      }
      this.renderProperties();
      this.renderChecklist();
      this.renderFlash();
    }
    renderDevices() {
      const devices = this.camera.devices.length ? this.camera.devices : this.camera.device ? [this.camera.device] : [], list = $('tether-device');
      const busy = ['connecting', 'discovering'].includes(this.camera.state);
      const signature = JSON.stringify([devices.map(d => [d.deviceId, d.model, d.transport, d.availability]), this.camera.deviceId, this.connected(), !!this.shoot, busy]);
      if (list.dataset.signature !== signature) {
        list.dataset.signature = signature;
        const focused = document.activeElement?.dataset?.deviceId;
        list.replaceChildren(...devices.map(d => {
          const kind = transportOf(d), current = d.deviceId === this.camera.deviceId && this.connected(), item = el('li'), button = el('button', 'tether-device-item');
          button.type = 'button'; button.dataset.deviceId = d.deviceId; button.setAttribute('aria-pressed', String(current));
          const state = current ? 'Connected' : d.availability && d.availability !== 'available' ? d.availability : '';
          button.append(el('span', `tether-transport ${kind}`, TRANSPORT_LABEL[kind]), el('span', 'tether-device-name', d.model || d.name || 'Camera'));
          if (state) button.append(el('span', 'tether-device-state', state));
          button.disabled = !this.api.canTether || !this.shoot || current || busy;
          button.title = !this.shoot ? 'Start a tethered session to connect' : current ? 'Connected' : `Connect over ${TRANSPORT_LABEL[kind]}`;
          button.onclick = () => void this.connect(d.deviceId);
          item.append(button); return item;
        }));
        if (focused) list.querySelector(`[data-device-id="${CSS.escape(focused)}"]`)?.focus();
      }
      const empty = $('tether-device-empty'); empty.hidden = devices.length > 0;
      empty.textContent = !this.api.canTether ? 'Camera discovery needs the desktop app.' : this.camera.state === 'discovering' ? 'Looking for cameras…' : 'No cameras found yet.';
    }
    renderProperties() {
      const host = $('tether-properties'), keys = [...this.camera.properties.keys()].filter(k => k !== 'battery');
      keys.sort((a, b) => (PROPERTY_ORDER.indexOf(a) + 1 || 99) - (PROPERTY_ORDER.indexOf(b) + 1 || 99));
      const signature = JSON.stringify(keys.map(k => this.camera.properties.get(k))) + this.camera.epoch + this.connected();
      if (host.dataset.signature === signature) return; host.dataset.signature = signature;
      const focused = document.activeElement?.dataset?.property;
      host.replaceChildren(...keys.map(key => {
        const p = this.camera.properties.get(key), row = el('div', 'tether-property'), id = `tether-prop-${key}`, label = el('label', null, p.label || key); label.htmlFor = id;
        const writable = p.access === 'rw' && this.connected();
        let control;
        if (p.stepOnly || p.relative) {
          control = el('div', 'tether-stepper');
          const dec = el('button', 'button quiet', '−'); dec.type = 'button'; dec.setAttribute('aria-label', `Decrease ${p.label || key}`); dec.disabled = !writable; dec.onclick = () => void this.setProperty(key, 'dec');
          const out = el('output', 'tabular', propertyText(key, p));
          const inc = el('button', 'button quiet', '+'); inc.type = 'button'; inc.setAttribute('aria-label', `Increase ${p.label || key}`); inc.disabled = !writable; inc.onclick = () => void this.setProperty(key, 'inc');
          control.append(dec, out, inc);
        } else if (p.kind === 'enum') {
          control = el('select'); const choices = p.choices || [];
          control.append(...choices.map(c => { const o = el('option', null, c.label ?? String(c.id ?? c.value)); o.value = String(c.id ?? c.value); return o; }));
          if (!choices.some(c => String(c.id ?? c.value) === String(p.value))) { const o = el('option', null, p.display ?? String(p.value ?? '—')); o.value = String(p.value); control.prepend(o); }
          control.value = String(p.value);
          control.onchange = () => { const choice = choices.find(c => String(c.id ?? c.value) === control.value); void this.setProperty(key, choice ? choice.id ?? choice.value : control.value); };
        } else if (p.kind === 'range') {
          control = el('input'); control.type = 'number'; control.className = 'tabular';
          if (p.range) { control.min = p.range.min; control.max = p.range.max; control.step = p.range.step || 'any'; }
          control.value = p.value ?? ''; control.onchange = () => void this.setProperty(key, Number(control.value));
        } else if (p.kind === 'boolean') {
          control = el('input'); control.type = 'checkbox'; control.checked = !!p.value; control.onchange = () => void this.setProperty(key, control.checked);
        } else { control = el('output', 'tabular', propertyText(key, p)); }
        control.id = id; control.dataset.property = key;
        if (!['OUTPUT', 'DIV'].includes(control.tagName)) control.disabled = !writable;
        row.append(label, control);
        if (!writable && control.tagName !== 'OUTPUT') {
          const why = el('span', 'tether-lock small', p.reason || { ro: 'Read only on this camera', unsupported: 'Not supported by this camera', busy: 'Camera is busy' }[p.access] || 'Unavailable'); why.id = id + '-reason';
          control.setAttribute('aria-describedby', why.id); control.title = why.textContent; row.append(why);
        }
        if (!this.connected() && p.value != null) row.classList.add('last-seen');
        return row;
      }));
      if (focused) document.querySelector(`[data-property="${focused}"]`)?.focus();
    }
    renderChecklist() {
      for (const [key, id] of CHECK_TABS) { const tab = $(id); tab.setAttribute('aria-selected', String(this.checklist === key)); tab.tabIndex = this.checklist === key ? 0 : -1; }
      const panel = $('tether-checklist'), list = CHECKLISTS[this.checklist];
      if (panel.dataset.model === this.checklist) return;
      panel.dataset.model = this.checklist; panel.setAttribute('aria-labelledby', CHECK_TABS.find(([key]) => key === this.checklist)[1]);
      $('tether-checklist-note').hidden = !list.note; $('tether-checklist-note').textContent = list.note || '';
      $('tether-checklist-steps').replaceChildren(...list.steps.map(text => el('li', null, text)));
      $('tether-checklist-studio').hidden = !list.studio;
      $('tether-checklist-studio-steps').replaceChildren(...(list.studio || []).map(text => el('li', null, text)));
    }
    // ---- Wi-Fi cameras ----
    toggleWifiForm(open = $('tether-wifi-form').hidden) {
      $('tether-wifi-form').hidden = !open; $('tether-wifi-add').setAttribute('aria-expanded', String(open));
      if (open) { $('tether-wifi-title').textContent = 'Add Wi-Fi camera'; this.renderWifi(); $('tether-wifi-ip').focus(); return; }
      this.wifi.pending = null; this.clearSecret(); $('tether-wifi-status').textContent = '';
      if ($('tether-wifi-form').contains(document.activeElement) || document.activeElement === document.body) $('tether-wifi-add').focus();
    }
    openWifiForDevice(device, error = null) {
      $('tether-wifi-form').hidden = false; $('tether-wifi-add').setAttribute('aria-expanded', 'true');
      $('tether-wifi-title').textContent = device?.model ? `Connect ${device.model}` : 'Connect Wi-Fi camera';
      if (device?.address) { $('tether-wifi-ip').value = device.address; $('tether-wifi-ip').removeAttribute('aria-invalid'); }
      const wantSsh = error && ['SSH_CREDENTIALS_REQUIRED', 'SSH_AUTH_FAILED', ...HOST_KEY].includes(error.code)
        || device?.auth === 'ssh' || device?.sshAdvertised === true;
      $('tether-wifi-auth').value = wantSsh ? 'ssh' : device?.auth === 'plain' ? 'plain' : 'auto';
      if (device?.username && !$('tether-wifi-user').value.trim()) $('tether-wifi-user').value = device.username;
      if (error?.code === 'SSH_AUTH_FAILED') this.clearSecret();
      if (error && HOST_KEY.includes(error.code) && error.fingerprint) {
        this.wifi.pending = { code: error.code, fingerprint: error.fingerprint };
        $('tether-wifi-status').textContent = '';
      } else {
        this.wifi.pending = null;
        $('tether-wifi-status').textContent = error ? (WIFI_ERRORS[error.code] || error.message)
          : wantSsh ? WIFI_ERRORS.SSH_CREDENTIALS_REQUIRED : WIFI_ERRORS.AUTH_CHOICE_REQUIRED;
      }
      this.renderWifi();
      if (this.wifi.pending) $('tether-wifi-trust').focus();
      else if (wantSsh) ($('tether-wifi-user').value.trim() ? $('tether-wifi-password') : $('tether-wifi-user')).focus();
      else if (device?.address) $('tether-wifi-auth').focus();
      else $('tether-wifi-ip').focus();
    }
    renderWifi() {
      const mode = $('tether-wifi-auth').value, pending = this.wifi.pending;
      $('tether-wifi-ssh-fields').hidden = mode !== 'ssh';
      $('tether-wifi-plain-note').hidden = mode !== 'plain';
      $('tether-wifi-fingerprint').hidden = !pending;
      $('tether-wifi-fingerprint').classList.toggle('changed', pending?.code === 'SSH_HOST_KEY_CHANGED');
      $('tether-wifi-fingerprint-title').textContent = pending?.code === 'SSH_HOST_KEY_CHANGED' ? 'The camera’s key has changed' : 'Check the camera’s key';
      $('tether-wifi-fingerprint-value').textContent = pending?.fingerprint || '';
      $('tether-wifi-fingerprint-help').textContent = pending?.code === 'SSH_HOST_KEY_CHANGED'
        ? 'This camera presented a different key from the one PhotoCull trusted. Connect only if you reset its access authentication and the key matches Network Option → Access Authen. Info.'
        : 'Compare it with MENU → Network → Network Option → Access Authen. Info on the camera. Connect only if they match.';
      $('tether-wifi-connect').disabled = this.wifi.busy || !this.api.canTether || !!pending;
      $('tether-wifi-trust').disabled = $('tether-wifi-trust-cancel').disabled = this.wifi.busy;
      if (!this.api.canTether && !$('tether-wifi-status').textContent) $('tether-wifi-status').textContent = 'Connecting over Wi-Fi needs the PhotoCull desktop app.';
    }
    clearSecret() { $('tether-wifi-password').value = ''; }
    async discoverWifi() {
      if (!this.api.canTether || this.wifi.busy) return;
      this.wifi.busy = true; $('tether-wifi-discover').querySelector('span').textContent = 'Searching…'; this.renderCamera();
      try {
        const result = await this.api.tetherDiscoverWifi();
        if (Array.isArray(result?.devices)) this.camera.devices = result.devices;
        const found = this.camera.devices.filter(d => transportOf(d) === 'wifi').length;
        this.host.toast(found ? `${found} Wi-Fi camera${found === 1 ? '' : 's'} found. Choose one to connect.` : result?.hint || 'No Wi-Fi camera answered. Check PC Remote is On, or use Add by IP….');
      } catch (error) { this.host.toast(WIFI_ERRORS[error.code] || error.message); }
      finally { this.wifi.busy = false; $('tether-wifi-discover').querySelector('span').textContent = 'Find Wi-Fi cameras'; this.render(); }
    }
    async addWifi(acceptFingerprint = null) {
      const status = $('tether-wifi-status'), address = cameraAddress($('tether-wifi-ip').value), authMode = $('tether-wifi-auth').value;
      if (!address) { status.textContent = 'Enter the camera’s numeric IPv4 address, for example 192.168.122.1.'; $('tether-wifi-ip').setAttribute('aria-invalid', 'true'); $('tether-wifi-ip').focus(); return; }
      const username = $('tether-wifi-user').value.trim(), password = $('tether-wifi-password').value;
      if (authMode === 'ssh' && (!username || !password)) { status.textContent = 'Enter the username and password shown in Access Authen. Info.'; (username ? $('tether-wifi-password') : $('tether-wifi-user')).focus(); return; }
      if (!this.api.canTether || this.wifi.busy) return;
      this.wifi.busy = true; status.textContent = authMode === 'plain' ? 'Connecting… approve PhotoCull on the camera if it asks.' : 'Connecting…'; this.renderWifi();
      const open = this.openSeq;
      try {
        const result = await this.api.tetherAddWifi({ address, authMode, ...(authMode === 'ssh' ? { username, password } : {}), ...(acceptFingerprint ? { acceptFingerprint } : {}) });
        // A sign-in begun before the shoot was stopped or changed never touches the later one.
        if (this.openSeq !== open) return;
        this.wifi.pending = null; this.clearSecret();
        if (Array.isArray(result?.devices)) this.camera.devices = result.devices;
        else { try { const listed = await this.api.tetherDevices(); if (this.openSeq !== open) return; this.camera.devices = listed.devices || this.camera.devices; } catch {} }
        if (this.openSeq !== open) return;
        if (!this.shoot) { status.textContent = 'Camera added. Start a tethered session to connect.'; return; }
        const addedId = result?.deviceId || result?.device?.deviceId;
        if (addedId) await this.connect(addedId, this.carriedExpect(addedId));
        if (this.openSeq !== open) return;
        if (this.connected()) { status.textContent = ''; this.toggleWifiForm(false); }
        else status.textContent = this.camera.reason || 'Camera added. Choose it above to connect.';
      } catch (error) {
        if (this.openSeq !== open) return;
        if (HOST_KEY.includes(error.code) && error.fingerprint) { this.wifi.pending = { code: error.code, fingerprint: error.fingerprint }; status.textContent = ''; }
        else {
          this.wifi.pending = null; status.textContent = WIFI_ERRORS[error.code] || error.message;
          if (error.code === 'SSH_AUTH_FAILED') { this.clearSecret(); $('tether-wifi-password').focus(); }
          if (error.code === 'SSH_CREDENTIALS_REQUIRED') { $('tether-wifi-auth').value = 'ssh'; this.renderWifi(); $('tether-wifi-user').focus(); }
          if (['AUTH_MODE_REQUIRED', 'AUTH_CHOICE_REQUIRED'].includes(error.code)) $('tether-wifi-auth').focus();
        }
      } finally {
        this.wifi.busy = false;
        if (this.openSeq === open) { this.render(); if (this.wifi.pending) $('tether-wifi-trust').focus(); }
        else this.renderWifi();
      }
    }
    renderLocation() {
      const shoot = this.shoot, location = shoot?.location;
      $('tether-location-path').textContent = location ? location.display : this.api.canTether ? 'Start a session to choose where captures go.' : 'Capture folders need the desktop app.';
      $('tether-location-path').title = location?.display || '';
      $('tether-shot-chip').hidden = !location?.relative; $('tether-shot-chip').textContent = location?.leaf || '';
      for (const id of ['tether-choose-folder', 'tether-new-shot', 'tether-recent-shots']) $(id).disabled = !shoot;
      const recents = location?.recents || [], select = $('tether-recent-shots');
      const signature = JSON.stringify([recents, location?.relative]);
      if (select.dataset.signature !== signature) {
        select.dataset.signature = signature;
        const blank = el('option', null, recents.length ? 'Choose a recent shot…' : 'No recent shots'); blank.value = '';
        select.replaceChildren(blank, ...recents.slice(0, 12).map(r => { const o = el('option', null, r || '(capture root)'); o.value = r; return o; }));
        select.value = '';
      }
      const space = shoot?.space, disk = $('tether-disk');
      disk.hidden = !space || !Number.isFinite(space.freeBytes);
      if (disk.hidden) return;
      const low = space.freeBytes < 5 * GiB, blocked = this.spaceBlocked();
      disk.dataset.level = blocked ? 'blocked' : low ? 'low' : 'ok';
      $('tether-disk-fill').style.width = `${Math.max(2, Math.min(100, space.freeBytes / (200 * GiB) * 100))}%`;
      $('tether-disk-text').textContent = `${bytesText(space.freeBytes)} free${Number.isFinite(space.estimatedShots) ? ` · ≈${space.estimatedShots.toLocaleString()} shots` : ''}${blocked ? ' · capture blocked' : low ? ' · low space' : ''}`;
    }
    renderNaming() {
      const config = this.config(), focused = document.activeElement;
      if (focused !== $('tether-job-name')) $('tether-job-name').value = this.shoot ? config.jobName || '' : this.jobName || this.defaultJob();
      if (focused !== $('tether-format')) $('tether-format').value = config.namingTemplate || '{Name}-{Counter:4}';
      const counters = this.shoot?.counters;
      if (focused !== $('tether-counter-next')) $('tether-counter-next').value = counters ? counters.next : this.settings().counterStart ?? 1;
      if (focused !== $('tether-counter-step')) $('tether-counter-step').value = counters ? counters.step : this.settings().counterStep ?? 1;
      if (!this.namingRendered) { this.namingRendered = true; this.renderSample(); }
    }
    insertToken(token) {
      const input = $('tether-format'), start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + token + input.value.slice(end);
      input.focus(); input.setSelectionRange(start + token.length, start + token.length);
      input.dispatchEvent(new Event('input'));
    }
    renderSample() {
      clearTimeout(this.namingTimer);
      this.namingTimer = setTimeout(async () => {
        const generation = ++this.namingGeneration, namingTemplate = $('tether-format').value, jobName = $('tether-job-name').value.trim() || this.defaultJob();
        let result;
        try {
          result = this.shoot ? await this.api.tetherNamePreview(this.shoot.shootId, { jobName, namingTemplate })
            : N.renderCaptureName(namingTemplate, { jobName, counter: this.settings().counterStart ?? 1, subfolder: this.defaultJob(), extensions: ['.ARW', '.JPG'] }, { preview: true });
        } catch (error) { result = { valid: false, warning: error.message, filenames: [] }; }
        if (generation !== this.namingGeneration) return;
        const sample = $('tether-sample'); sample.replaceChildren();
        sample.classList.toggle('error', !result.valid); $('tether-format').setAttribute('aria-invalid', String(!result.valid));
        if (!result.valid) { sample.textContent = result.warning || 'Invalid naming format.'; return; }
        sample.append(el('span', 'tether-sample-label', 'Sample '), el('strong', 'tabular', result.filenames.join(' + ')));
        if (result.estimatedTokens?.length) { const b = el('span', 'tether-badge', 'estimated'); b.title = `Estimated until capture: ${result.estimatedTokens.join(', ')}`; sample.append(b); }
        if (result.pendingTokens?.length) { const b = el('span', 'tether-badge', 'pending'); b.title = `Known after transfer: ${result.pendingTokens.join(', ')}`; sample.append(b); }
        if (result.warning) sample.append(el('span', 'tether-sample-warning', ' ' + result.warning));
      }, 120);
    }
    async counter(op, value) {
      if (!this.shoot) {
        const s = this.settings(), start = s.counterStart ?? 1, step = s.counterStep ?? 1;
        const patch = op === 'setNext' ? { counterStart: Math.round(value) } : op === 'setStep' ? { counterStep: Math.round(value) || 1 } : op === 'increment' ? { counterStart: start + step } : op === 'decrement' ? { counterStart: start - step } : { counterStart: 1 };
        try { await this.host.saveSettings({ tether: patch }); } catch (error) { this.host.toast(error.message); }
        this.namingRendered = false; this.render(); return;
      }
      try {
        const result = await this.api.tetherCounter(this.shoot.shootId, this.shoot.configRev, op, value);
        Object.assign(this.shoot, { configRev: result.configRev, counters: { ...this.shoot.counters, next: result.next, resetTo: result.resetTo, step: result.step } });
      } catch (error) { this.host.toast(error.message); if (error.code === 'STALE_REV') await this.refreshState(); }
      this.render(); this.renderSample();
    }
    renderAdjustments() {
      const a = this.config().adjustments || {}, settings = this.host.settings(), focused = document.activeElement;
      $('tether-adjust-mode').value = a.mode || 'last';
      $('tether-recipe-row').hidden = a.mode !== 'recipe'; $('tether-entire-row').hidden = a.mode !== 'recipe';
      $('tether-entire').checked = a.entireRecipe !== false;
      if (this.recipes && $('tether-recipe').dataset.loaded !== '1') { $('tether-recipe').dataset.loaded = '1'; $('tether-recipe').replaceChildren(...this.recipes.map(r => { const o = el('option', null, r.name); o.value = r.id; return o; })); }
      if (a.recipeId) $('tether-recipe').value = a.recipeId;
      const lockedGroups = a.mode === 'recipe' && a.entireRecipe !== false || a.mode === 'default';
      for (const input of $('tether-groups').querySelectorAll('input')) { input.checked = (a.groups || []).includes(input.dataset.group); input.disabled = lockedGroups; }
      $('tether-groups').title = lockedGroups ? 'Not used: the whole recipe is applied' : '';
      $('tether-developed').checked = !!this.config().follow?.developedReview;
      const meta = $('tether-metadata'), signature = JSON.stringify(settings.presets?.map(p => [p.id, p.name]));
      if (meta.dataset.signature !== signature) { meta.dataset.signature = signature; const none = el('option', null, 'None'); none.value = ''; meta.replaceChildren(none, ...(settings.presets || []).map(p => { const o = el('option', null, p.name); o.value = p.id; return o; })); }
      meta.value = this.config().metadataPresetId || '';
      const colors = $('tether-initial-color'), colorSignature = JSON.stringify(settings.colors?.map(c => [c.id, c.name]));
      if (colors.dataset.signature !== colorSignature) { colors.dataset.signature = colorSignature; const keep = el('option', null, 'Unchanged'); keep.value = ''; colors.replaceChildren(keep, ...(settings.colors || []).filter(c => /^[1-8]$/.test(c.id)).map(c => { const o = el('option', null, c.name); o.value = c.id; return o; })); }
      const initial = this.config().initial || {};
      if (focused !== $('tether-initial-pick')) $('tether-initial-pick').value = initial.pick === null || initial.pick === undefined ? '' : String(initial.pick);
      $('tether-initial-rating').value = initial.rating === null || initial.rating === undefined ? '' : String(initial.rating);
      colors.value = initial.color || '';
      const photo = this.host.photo(), recipe = this.recipes?.find(r => r.id === a.recipeId), fallback = this.recipes?.find(r => r.id === settings.defaultRecipe);
      $('tether-adjust-source').textContent = a.mode === 'last' ? `Next capture copies from the last RAW${this.follow.latestId && this.host.item(this.follow.latestId) ? ` · ${this.host.item(this.follow.latestId).name}` : ' · default for the first capture'}`
        : a.mode === 'primary' ? (photo?.raw ? `Copy from Primary · ${photo.name}` : 'Copy from Primary · select a RAW photo') : a.mode === 'recipe' ? `Recipe · ${recipe?.name || 'choose a recipe'}${a.entireRecipe !== false ? ' (entire)' : ''}` : `Default · ${fallback?.name || settings.defaultRecipe || 'Neutral'}`;
    }
    async loadRecipes() {
      if (this.recipes || this.recipesLoading) return; this.recipesLoading = true;
      try { this.recipes = (await this.api.recipes()).recipes; this.renderAdjustments(); } catch { this.recipes = []; } finally { this.recipesLoading = false; }
    }
    renderComposition() {
      const c = this.composition(), focused = document.activeElement;
      const set = (id, value) => { const input = $(id); if (input === focused && input.type !== 'checkbox') return; if (input.type === 'checkbox') input.checked = !!value; else input.value = value ?? ''; };
      const g = c.grid || {};
      set('tether-grid-shown', g.shown); set('tether-grid-type', g.type || 'thirds'); set('tether-grid-cols', g.cols ?? 3); set('tether-grid-rows', g.rows ?? 3);
      set('tether-grid-mirror', g.mirror); set('tether-grid-clockwise', g.clockwise !== false); set('tether-grid-color', g.color || '#ffffff'); set('tether-grid-opacity', g.opacity ?? 0.5);
      $('tether-grid-custom').hidden = g.type !== 'custom'; $('tether-grid-spiral').hidden = g.type !== 'goldenSpiral';
      const guides = g.guides || [], list = $('tether-guides');
      if (list.dataset.signature !== JSON.stringify(guides)) {
        list.dataset.signature = JSON.stringify(guides);
        list.replaceChildren(...guides.map((guide, index) => {
          const row = el('li', 'tether-guide'), input = el('input'); input.type = 'number'; input.min = 0; input.max = 100; input.step = 1; input.className = 'tabular'; input.value = Math.round(guide.at * 1000) / 10;
          input.setAttribute('aria-label', `${guide.axis === 'x' ? 'Vertical' : 'Horizontal'} guide position, percent`);
          input.onchange = () => { const at = Math.max(0, Math.min(100, Number(input.value))) / 100; if (!Number.isFinite(at)) return; this.setComposition('grid', { guides: guides.map((x, i) => i === index ? { ...x, at } : x) }, 0); };
          const remove = el('button', 'button quiet', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove guide'); remove.onclick = () => this.setComposition('grid', { guides: guides.filter((_, i) => i !== index) }, 0);
          row.append(el('span', null, guide.axis === 'x' ? 'Vertical' : 'Horizontal'), input, el('span', 'subtle', '%'), remove); return row;
        }));
      }
      const a = c.aspect || {}; set('tether-aspect-shown', a.shown); set('tether-aspect-ratio', a.ratio || '2:3'); set('tether-aspect-orientation', a.orientation || 'portrait'); set('tether-aspect-matte', a.matte ?? 0.65);
      const o = c.overlay || {}; set('tether-overlay-shown', o.shown); set('tether-overlay-opacity', o.opacity ?? 0.5); set('tether-overlay-scale', o.scale ?? 1); set('tether-overlay-x', o.x ?? 0); set('tether-overlay-y', o.y ?? 0); set('tether-overlay-crop', o.followCrop !== false);
      $('tether-overlay-name').textContent = this.asset ? `${this.assetName || 'Overlay image'} · ${this.asset.width} × ${this.asset.height}` : 'No overlay image';
      for (const id of ['tether-overlay-shown', 'tether-overlay-move', 'tether-overlay-clear']) $(id).disabled = !this.asset;
      $('tether-overlay-photo').disabled = !this.host.photo();
      $('tether-overlay-move').setAttribute('aria-pressed', String(this.layer?.moving || this.liveLayer?.moving || false));
      const m = c.mask || {}; set('tether-mask-shown', m.shown); set('tether-mask-color', m.color || '#00ff00'); set('tether-mask-opacity', m.opacity ?? 0.55); set('tether-mask-threshold', m.threshold ?? 0.03);
      const w = c.warning || {}; set('tether-warning-shown', w.shown); set('tether-warning-high', w.high ?? 250); set('tether-warning-low', w.low ?? 5); set('tether-warning-shadows', w.shadows);
      set('tether-peaking-color', c.peaking?.color || '#ffff00'); set('tether-peaking-sensitivity', c.peaking?.sensitivity ?? 0.5);
      for (const [id, on] of [['tether-live-peaking', c.peaking?.shown], ['tether-live-zebra', c.warning?.shown], ['tether-live-histogram-toggle', c.histogram?.shown], ['tether-live-guides', c.grid?.shown], ['tether-live-aspect', c.aspect?.shown], ['tether-live-overlay', c.overlay?.shown && this.asset],
        ['tether-stage-guides', c.grid?.shown], ['tether-stage-aspect', c.aspect?.shown], ['tether-stage-overlay', c.overlay?.shown && this.asset], ['tether-stage-mask', c.mask?.shown], ['tether-stage-warning', c.warning?.shown]]) $(id).setAttribute('aria-pressed', String(!!on));
      $('tether-stage-overlay').title = this.asset ? 'Overlay image (O)' : 'Overlay image (O) · choose an image under Configure aids';
      $('tether-live-overlay').disabled = !this.asset;
    }
    composeChanged() {
      if (!this.layer) return;
      const c = this.composition();
      this.layer.setConfig(c); this.liveLayer.setConfig(c);
      this.renderComposition();
    }
    // Validation messages stay until the next accepted edit; analysis status comes and goes with the photo.
    compositionStatus(text, source = 'analysis') {
      this.statusText = { ...this.statusText, [source]: text };
      $('tether-composition-status').textContent = this.statusText.validation || this.statusText.analysis || '';
      if (source === 'validation') return;
      // A clear only removes a status message, never a toast that replaced it.
      if (text) { clearTimeout(this.toastTimer); $('overlay-status').hidden = false; $('overlay-status').textContent = text; } else if (this.statusShown) $('overlay-status').hidden = true;
      this.statusShown = !!text;
    }
    renderFollow() {
      const follow = this.config().follow || {};
      if (document.activeElement !== $('tether-follow-mode')) $('tether-follow-mode').value = follow.mode || 'whenReady';
      const pause = $('tether-follow-pause'), label = this.follow.paused ? `Resume following${this.follow.autoPaused ? ' (paused while inspecting)' : ''}` : 'Pause following';
      pause.setAttribute('aria-pressed', String(this.follow.paused)); pause.setAttribute('aria-label', label); pause.title = label;
      pause.disabled = follow.mode === 'off';
      $('tether-autopause').checked = follow.pauseOnInspect !== false;
      $('tether-chime').setAttribute('aria-pressed', String(!!this.settings().chime));
      const pinned = this.host.survey().pinned(), pin = $('tether-pin');
      pin.setAttribute('aria-pressed', String(!!pinned)); pin.querySelector('span').textContent = pinned ? 'Unpin reference' : 'Pin reference';
      pin.disabled = !pinned && !this.enabled('tether-pin-reference');
    }
    renderTelemetry() {
      const t = this.telemetry, queue = this.shoot?.queue;
      const receiving = t.receiving || queue?.receiving || 0, parts = [`Queue ${t.queued || queue?.pending || 0}`];
      if (receiving) parts.push(`Receiving ${receiving}`);
      parts.push(`${Number.isFinite(t.mbps) ? t.mbps.toFixed(1) : '0'} MB/s`);
      if (Number.isFinite(t.latency)) parts.push(`${(t.latency / 1000).toFixed(1)} s`);
      $('tether-telemetry').textContent = parts.join(' · ');
      $('tether-telemetry').title = `Transfer queue and speed · Follow: ${FOLLOW_LABEL[this.followMode()]}${this.follow.paused ? ' (paused)' : ''}`;
    }
    renderIssues() {
      $('tether-tool-issues').hidden = !this.issues.size;
      const host = $('tether-issues'), ACTIONS = { retry: 'Retry', finishSingle: 'Finish as single', saveSeparate: 'Save separately', repairName: 'Repair name' };
      host.replaceChildren(...[...this.issues.entries()].map(([key, issue]) => {
        const card = el('article', 'tether-issue'); card.setAttribute('aria-label', `Capture issue: ${issue.message}`);
        card.append(el('strong', null, issue.code?.replaceAll('_', ' ').toLowerCase() || 'Issue'), el('p', 'small', issue.message));
        const actions = el('div', 'tether-row');
        for (const op of issue.actions || []) {
          const b = el('button', 'button quiet', ACTIONS[op] || op); b.type = 'button';
          b.onclick = async () => {
            let name;
            if (op === 'repairName') { name = prompt('New file name (without folder)'); if (!name) return; }
            b.disabled = true;
            try { const result = await this.api.tetherRecover({ shootId: this.shoot.shootId, exposureId: issue.exposureId, memberId: issue.memberId, op, ...(name ? { name } : {}) }); if (result?.issue) this.issues.set(key, result.issue); else this.issues.delete(key); }
            catch (error) { this.host.toast(error.message); }
            this.renderIssues();
          };
          b.disabled = !this.shoot || !this.api.canTether; actions.append(b);
        }
        const dismiss = el('button', 'button quiet', 'Dismiss'); dismiss.type = 'button'; dismiss.onclick = () => { this.issues.delete(key); this.renderIssues(); }; actions.append(dismiss);
        card.append(actions); return card;
      }));
    }

    // ---- Session and camera ----
    openStart() {
      if (this.host.blocked()) return;
      this.openPanel();
      if (!this.api.canTether) return this.host.toast('Tethering needs the PhotoCull desktop app. Composition aids, naming and follow defaults still work here.');
      if (document.querySelector('dialog[open]')) return;
      const session = this.host.session();
      $('tether-start-open').disabled = !session || session.removable;
      $('tether-start-open-path').textContent = session ? ` · ${session.folder}` : '';
      (session && !session.removable ? $('tether-start-open') : $('tether-start-choose')).checked = true;
      void this.loadRecent();
      const layout = this.settings().layout || 'single';
      for (const radio of document.querySelectorAll('input[name="tether-start-layout"]')) radio.checked = radio.value === layout;
      $('tether-start-status').textContent = ''; $('tether-start-dialog').showModal();
    }
    // Start and Resume share one open at a time; the shell refuses a second bind as well.
    beginOpening() {
      if (this.opening) return false;
      this.opening = true; $('tether-start-confirm').disabled = true; this.renderResume();
      return true;
    }
    endOpening() { this.opening = false; $('tether-start-confirm').disabled = false; this.renderResume(); }
    async start() {
      if (this.shoot || !this.beginOpening()) return;
      const useOpenFolder = document.querySelector('input[name="tether-start-root"]:checked')?.value === 'open';
      const layout = document.querySelector('input[name="tether-start-layout"]:checked')?.value || 'single';
      $('tether-start-status').textContent = 'Preparing capture folder…';
      try {
        await this.host.flushDevelop();
        const result = await this.api.tetherOpen({ session: useOpenFolder ? this.host.session()?.id ?? null : null, useOpenFolder, layout, includeShots: $('tether-start-shots').checked });
        if (!result) { $('tether-start-status').textContent = ''; return; }
        $('tether-start-dialog').close();
        await this.opened(result);
        this.openPanel(); void this.discover(true);
      } catch (error) { $('tether-start-status').textContent = error.message; }
      finally { this.endOpening(); }
    }
    // Interrupted Keeps replay while the shoot opens, before it is adopted here: their photos and
    // any Keep that could not finish arrive with the result rather than as events.
    async opened(result) {
      if (result.session && result.session.id !== this.host.session()?.id) this.host.loadSession(result.session);
      const value = await this.api.tetherState(result.session?.id ?? this.host.session()?.id);
      this.setShoot(value?.shootId ? value : { shootId: result.shootId, session: result.session?.id, configRev: result.configRev, libraryRev: result.libraryRev, config: clone(this.settings()), counters: null });
      if (!this.shoot) return;
      for (const issue of result.issues || []) this.issues.set(this.issueKey(issue), issue);
      this.renderIssues();
      if ((this.shoot.libraryRev ?? 0) !== (result.libraryRev ?? 0)) await this.resyncLibrary();
    }
    async loadRecent() {
      if (!this.api.canTether) return;
      try { this.recent = await this.api.tetherShoots() || []; } catch { this.recent = []; }
      this.renderResume();
    }
    // Reopens a stopped shoot where it left off: its folder, shot folder, counter, settings and camera.
    async resume(shootId) {
      const entry = this.recent.find(r => r.shootId === shootId), dialog = $('tether-start-dialog');
      if (!entry || this.shoot || this.opening || !this.api.canTether || !dialog.open && this.host.blocked()) return;
      const report = message => { if (dialog.open) $('tether-start-status').textContent = message; else if (message) this.host.toast(message); };
      this.beginOpening();
      if (dialog.open) $('tether-start-status').textContent = `Reopening ${entry.name}…`;
      try {
        await this.host.flushDevelop();
        const result = await this.api.tetherOpen({ session: this.host.session()?.id ?? null, resume: entry.shootId });
        if (!result) { report(''); return; }
        if (dialog.open) dialog.close();
        await this.opened(result);
        this.openPanel();
        const location = this.shoot?.location;
        this.host.toast(entry.relative && location && location.relative !== entry.relative
          ? `Shot folder “${entry.shot}” is gone; capturing into ${location.leaf}. Next ${this.shoot.counters?.next ?? entry.next}.`
          : `Resumed ${location?.leaf || entry.name} · next ${this.shoot?.counters?.next ?? entry.next}`);
        void this.discover(true, entry.camera);
      } catch (error) { report(error.message); void this.loadRecent(); }
      finally { this.endOpening(); }
    }
    // The shoot's own camera: the same device, or with a verifiable body the only one of its model.
    // The shell checks the body after opening, so another camera is never adopted.
    preferredDevice(available, camera) {
      if (!camera?.deviceId || !camera.model) return null;
      const same = camera.bodyKey ? available.filter(d => d.model === camera.model) : [];
      return available.find(d => d.deviceId === camera.deviceId) || (same.length === 1 ? same[0] : null);
    }
    async discover(autoConnect = false, camera = null) {
      if (!this.api.canTether) return;
      const open = this.openSeq;
      this.camera.state = this.connected() ? this.camera.state : 'discovering'; this.camera.reason = ''; this.render();
      try {
        const result = await this.api.tetherDevices();
        this.camera.devices = result.devices || [];
        if (!this.connected()) this.camera.state = 'offline';
        const pending = autoConnect && !!this.shoot && this.openSeq === open && !this.connected();
        const available = this.camera.devices.filter(d => !d.availability || d.availability === 'available'), usb = available.filter(d => transportOf(d) === 'usb');
        const preferred = pending ? this.preferredDevice(available, camera) : null;
        if (!this.camera.devices.length) this.camera.reason = 'No camera found. Check the setup steps below, then retry.';
        else if (preferred) await this.connect(preferred.deviceId, { deviceId: camera.deviceId, model: camera.model, bodyKey: camera.bodyKey ?? null });
        else if (pending && !camera && usb.length === 1 && available.length === 1) await this.connect(usb[0].deviceId);
        else if (pending && camera && available.length && !this.connected()) this.camera.reason = `The ${camera.model || 'camera'} this shoot used was not found. Choose a camera to continue.`;
        else if (available.length > 1 && !this.connected()) this.camera.reason = 'Several cameras found. Choose one above.';
      } catch (error) { if (this.openSeq === open) { this.camera.state = 'offline'; this.camera.reason = error.message; } }
      this.render();
    }
    async connect(deviceId, expect = null) {
      if (!this.shoot || !deviceId) return;
      const open = this.openSeq;
      const device = this.camera.devices.find(d => d.deviceId === deviceId);
      if (device && transportOf(device) === 'wifi' && (device.needsCredentials || device.auth === 'unknown' && device.address)) {
        this.camera.deviceId = deviceId; this.camera.reason = ''; this.carryExpect(deviceId, expect); this.openWifiForDevice(device); return;
      }
      this.camera.state = 'connecting'; this.camera.deviceId = deviceId; this.render();
      try {
        const snapshot = await this.api.tetherConnect(this.shoot.shootId, deviceId, expect);
        if (this.openSeq !== open) return;
        this.applyConnection(snapshot);
      } catch (error) {
        if (this.openSeq !== open) return;
        this.camera.state = 'offline'; this.camera.reason = error.message; this.render();
        if (device && transportOf(device) === 'wifi' && ['SSH_CREDENTIALS_REQUIRED', 'SSH_AUTH_FAILED', 'AUTH_CHOICE_REQUIRED', 'AUTH_MODE_REQUIRED', ...HOST_KEY].includes(error.code)) {
          this.carryExpect(deviceId, expect); this.openWifiForDevice(device, error);
        }
      }
    }
    // A resumed shoot's body check survives the Wi-Fi sign-in it needs, for that camera and open only.
    carryExpect(deviceId, expect) { this.wifi.expect = expect && { open: this.openSeq, deviceId, expect }; }
    carriedExpect(deviceId) {
      const carried = this.wifi.expect;
      return carried && carried.open === this.openSeq && carried.deviceId === deviceId ? carried.expect : null;
    }
    // Non-destructive property resync; never tears down the active camera session.
    async resyncCamera() {
      if (!this.shoot || !this.connected()) return;
      try {
        const snapshot = await this.api.tetherControl(this.shoot.shootId, this.camera.epoch, 'refresh');
        if (snapshot?.properties) this.applyConnection(snapshot);
      } catch {}
    }
    applyConnection(snapshot) {
      const epochChanged = snapshot.epoch !== this.camera.epoch;
      Object.assign(this.camera, { epoch: snapshot.epoch ?? this.camera.epoch, device: snapshot.device || this.camera.device, actions: normalizeActions(snapshot.actions), capabilities: snapshot.capabilities || {}, propRev: snapshot.propRev ?? snapshot.properties?.[0]?.propRev ?? 0, reason: snapshot.reason || '' });
      const state = snapshot.connection?.state || snapshot.state || 'ready';
      this.camera.state = state; this.camera.paused = state === 'paused';
      if (snapshot.device?.deviceId) this.camera.deviceId = snapshot.device.deviceId;
      if (snapshot.properties) this.camera.properties = new Map(snapshot.properties.map(p => [p.key, p]));
      if (epochChanged || !this.connected()) { this.stopRecycle(); this.releaseHold(); if (this.live.enabled) { this.retireStream(); this.live.enabled = false; } }
      this.render();
    }
    async control(op) {
      if (!this.shoot) return;
      try {
        const result = await this.api.tetherControl(this.shoot.shootId, this.camera.epoch, op);
        if (op === 'disconnect') { this.stopRecycle(); this.releaseHold(); if (this.live.open) this.closeStage(); this.camera.state = 'offline'; this.camera.properties.clear(); this.camera.device = null; this.camera.capabilities = {}; }
        if (result?.state) { this.camera.state = result.state; this.camera.paused = result.state === 'paused'; }
        if (Number.isFinite(result?.epoch)) this.camera.epoch = result.epoch;
      } catch (error) { this.host.toast(error.message); }
      this.render();
    }
    // Ends the shoot; the folder stays open as an ordinary session.
    async stopSession({ requireIdle = false } = {}) {
      const shoot = this.shoot;
      if (!shoot) return null;
      let result;
      try {
        this.releaseHold();
        if (this.live.open || this.live.enabled) await this.toggleLive(false);
        await this.flush();
        if (requireIdle && await this.hasPendingWork()) {
          this.host.toast('Wait for pending tethered captures to finish before installing an update.');
          return null;
        }
        if (this.shoot?.shootId !== shoot.shootId) return null;
        result = await this.api.tetherControl(shoot.shootId, this.camera.epoch, 'stop');
      } catch (error) { this.host.toast(error.message || String(error)); return null; }
      if (this.shoot?.shootId === shoot.shootId) this.setShoot(null);
      Object.assign(this.camera, { state: 'offline', device: null, paused: false, reason: '', actions: {}, capabilities: {} }); this.camera.properties.clear();
      this.render(); this.host.toast(result?.cleanupWarning || 'Tethered session stopped');
      void this.loadRecent();
      return result;
    }
    async togglePause() {
      const resume = this.camera.paused;
      if (!resume) { this.releaseHold(); if (this.live.enabled) await this.stopLive(); }
      await this.control(resume ? 'resume' : 'pause');
      if (!resume && this.camera.state === 'paused') $('tether-capture-reason').textContent = 'Paused · body captures still received';
    }
    async setProperty(key, value) {
      const p = this.camera.properties.get(key); if (!p || !this.shoot) return;
      try {
        const result = await this.api.tetherSetProperty(this.shoot.shootId, this.camera.epoch, key, value, p.propRev ?? this.camera.propRev);
        for (const changed of result.properties || []) this.camera.properties.set(changed.key, changed);
        if (Number.isFinite(result.propRev)) this.camera.propRev = Math.max(this.camera.propRev, result.propRev);
      } catch (error) {
        this.host.toast(error.message);
        if (['STALE_REV', 'CONTROL_LOCKED', 'CAMERA_BUSY'].includes(error.code)) await this.resyncCamera();
      }
      $('tether-properties').dataset.signature = ''; this.render();
    }
    async capture(event) {
      if (event?.repeat) return;
      const reason = this.canCapture(); if (reason) return this.host.toast(reason);
      if (!N.validateCaptureTemplate($('tether-format').value).valid || $('tether-format').getAttribute('aria-invalid') === 'true') return this.host.toast('Fix the naming format before capturing.');
      if (this.capturing) return; this.capturing = true;
      try {
        // Node freezes naming, adjustments and metadata at trigger time, so every pending edit must reach it first.
        await this.host.flushDevelop();
        await this.flush();
        if (this.saveFailed || Object.keys(this.savePatch).length) { this.saveFailed = false; await this.refreshState(); throw new Error('Capture settings could not be saved, so no shot was taken. Check them, then capture again.'); }
        const primarySeq = await this.flushPrimary();
        const blocked = this.canCapture();
        if (blocked) return this.host.toast(blocked);
        const shootId = this.shoot.shootId, epoch = this.camera.epoch, active = this.test.active, previousTestSeq = this.test.testSeq;
        const result = await this.api.tetherTrigger(shootId, epoch, crypto.randomUUID(), primarySeq);
        if (this.shoot?.shootId !== shootId || this.camera.epoch !== epoch || active !== this.test.active || !this.connected()) return;
        if (result?.status === 'released') {
          if (active && previousTestSeq === this.test.testSeq) this.test.awaitingShot = true;
          this.startRecycle();
        }
        else if (result?.state === 'outcomeUnknown') this.host.toast(result.reason || 'Shutter outcome uncertain — check the camera before firing again.');
        else if (result?.state && !['confirmed', 'requested', 'dispatched'].includes(result.state)) this.host.toast(`Capture ${result.state}`);
        else if (['confirmed', 'requested', 'dispatched'].includes(result?.state)) this.startRecycle();
      } catch (error) { this.host.toast(error.message); }
      finally { this.capturing = false; }
    }
    async location(args) {
      if (!this.shoot) return false;
      try {
        const result = await this.api.tetherLocation({ shootId: this.shoot.shootId, expectedConfigRev: this.shoot.configRev, ...args });
        if (!result) return false;
        if ((result.location ?? this.shoot.location)?.relative !== this.shoot.location?.relative) this.resetMisfire();
        Object.assign(this.shoot, { configRev: result.configRev ?? this.shoot.configRev, location: result.location ?? this.shoot.location, space: result.space ?? this.shoot.space });
        this.render(); this.renderSample(); return true;
      } catch (error) { this.host.toast(error.message); if (error.code === 'STALE_REV') await this.refreshState(); return false; }
    }
    newShot() { if (!this.shoot) return; $('tether-new-shot-form').hidden = false; $('tether-new-shot-name').value = ''; $('tether-new-shot-name').focus(); }

    // AF-On is momentary: release on pointer/key up, blur, cancel, disconnect or pause.
    bindHold(button) {
      const press = event => { if (event.type === 'keydown' && (event.repeat || ![' ', 'Enter'].includes(event.key))) return; event.preventDefault(); void this.pressHold(); };
      button.addEventListener('pointerdown', event => { if (event.button === 0) { button.setPointerCapture(event.pointerId); press(event); } });
      button.addEventListener('keydown', press);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) button.addEventListener(type, () => this.releaseHold());
      button.addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) this.releaseHold(); });
      button.addEventListener('click', event => event.preventDefault());
    }
    async pressHold() {
      if (this.hold || !this.enabled('tether-af')) return;
      const hold = this.hold = { id: crypto.randomUUID(), epoch: this.camera.epoch, shootId: this.shoot.shootId };
      $('tether-af').setAttribute('aria-pressed', 'true');
      try { await this.api.tetherFocus({ shootId: hold.shootId, epoch: hold.epoch, action: 'press', holdId: hold.id }); }
      catch (error) { this.host.toast(error.message); this.releaseHold(); }
    }
    releaseHold() {
      const hold = this.hold; if (!hold) return; this.hold = null;
      $('tether-af').setAttribute('aria-pressed', 'false');
      void this.api.tetherFocus({ shootId: hold.shootId, epoch: hold.epoch, action: 'release', holdId: hold.id }).catch(() => {});
    }
    async afPulse() {
      if (!this.enabled('tether-af')) return;
      try { await this.api.tetherFocus({ shootId: this.shoot.shootId, epoch: this.camera.epoch, action: 'pulse' }); } catch (error) { this.host.toast(error.message); }
    }
    // A click steps once; holding repeats after 350 ms at up to 6 steps a second with one request outstanding.
    bindFocusStep(button) {
      const step = async () => {
        if (!this.shoot || !this.connected()) return false;
        if (button.dataset.focus === 'af') { await this.afPulse(); return false; }
        try { await this.api.tetherFocus({ shootId: this.shoot.shootId, epoch: this.camera.epoch, action: 'step', direction: button.dataset.focus, size: Number(button.dataset.size) }); return true; }
        catch (error) { this.host.toast(error.message); return false; }
      };
      const stop = () => { if (this.focusRepeat?.button === button) { clearTimeout(this.focusRepeat.timer); this.focusRepeat = null; } };
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0) return; event.preventDefault(); button.setPointerCapture(event.pointerId);
        const repeat = this.focusRepeat = { button, timer: 0 };
        const loop = async () => { if (this.focusRepeat !== repeat) return; const started = performance.now(); const ok = await step(); if (!ok || this.focusRepeat !== repeat) return stop(); repeat.timer = setTimeout(loop, Math.max(0, 1000 / 6 - (performance.now() - started))); };
        void step(); repeat.timer = setTimeout(loop, 350);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) button.addEventListener(type, stop);
      button.addEventListener('keydown', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!event.repeat || !this.focusPending) { this.focusPending = true; void step().finally(() => { this.focusPending = false; }); } } });
      button.addEventListener('click', event => event.preventDefault());
    }

    // ---- Live View ----
    async toggleLive(open = !this.live.open) {
      if (!open) { await this.stopLive(); this.closeStage(); return; }
      if (!this.enabled('tether-live-view')) return this.host.toast(this.api.canTether ? 'Connect a camera that offers Live View.' : 'Live View needs the PhotoCull desktop app.');
      this.live.wanted = true;
      try {
        const result = await this.api.tetherLive(this.shoot.shootId, this.camera.epoch, true);
        if (!this.live.wanted) { if (this.shoot) void this.api.tetherLive(this.shoot.shootId, this.camera.epoch, false).catch(() => {}); return; }
        this.adoptStream(result.streamId);
        $('tether-live-status').textContent = `Live View ${result.state || 'starting'}`;
      } catch (error) { this.live.wanted = false; this.host.toast(error.message); }
    }
    // One stream at a time: a new one (started here or restarted by the camera after a reconnect) retires the previous stream's poll and frame.
    adoptStream(streamId) {
      if (this.live.enabled && this.live.streamId === streamId) return;
      this.retireStream();
      Object.assign(this.live, { enabled: true, streamId, seq: 0, frames: [] });
      if (!this.live.open) this.openStage(); else this.renderLive();
      void this.pollLive(streamId);
    }
    retireStream() {
      const { retired, streamId } = this.live;
      if (streamId) { retired.add(streamId); if (retired.size > 32) retired.delete(retired.values().next().value); }
      this.live.poll++; this.live.streamId = null; this.live.seq = 0; this.live.frames = [];
      this.live.bitmap?.close?.(); this.live.bitmap = null;
    }
    async stopLive() {
      const { streamId } = this.live; this.live.wanted = false; this.retireStream(); this.live.enabled = false; this.histogramKey = ''; void this.renderHistogram();
      if (streamId && this.shoot) await this.api.tetherLive(this.shoot.shootId, this.camera.epoch, false).catch(() => {});
      this.renderLive();
    }
    openStage() { this.live.open = true; this.dockForTestShot(); this.stageFocus = document.activeElement; this.renderLive(); this.host.stageChanged(); requestAnimationFrame(() => { $('tether-live-viewport').focus({ preventScroll: true }); this.paintLive(); }); }
    closeStage() {
      if (!this.live.open) return;
      if (this.test.restoreLiveExpanded) { this.test.restoreLiveExpanded = false; this.live.docked = false; }
      this.live.open = false; if (this.live.enabled || this.live.wanted) void this.stopLive();
      this.live.bitmap?.close?.(); this.live.bitmap = null; this.renderLive(); this.host.stageChanged();
      if (this.stageFocus?.isConnected) this.stageFocus.focus({ preventScroll: true });
    }
    async pollLive(streamId) {
      const poll = ++this.live.poll, epoch = this.camera.epoch, shootId = this.shoot?.shootId; let failures = 0;
      const current = () => this.live.enabled && this.live.streamId === streamId && poll === this.live.poll && this.camera.epoch === epoch && this.shoot?.shootId === shootId;
      while (current()) {
        let frame;
        try { frame = await this.api.tetherLiveFrame(shootId, epoch, streamId, this.live.seq); failures = 0; }
        catch (error) {
          // A rejection from a retired stream must never stop the stream that replaced it.
          if (!current()) return;
          if (error.code === 'STREAM_CLOSED' || ++failures > 5) { this.retireStream(); this.live.enabled = false; $('tether-live-status').textContent = error.message; this.renderLive(); return; }
          await new Promise(resolve => setTimeout(resolve, 500)); continue;
        }
        if (!current()) return;
        if (!frame.jpegBytes || frame.seq <= this.live.seq || frame.streamId && frame.streamId !== streamId) continue;
        let bitmap;
        try { bitmap = await createImageBitmap(frame.blob); } catch { continue; }
        if (!current()) { bitmap.close(); return; }
        this.live.seq = frame.seq; this.live.bitmap?.close?.(); this.live.bitmap = bitmap; this.live.size = { width: bitmap.width, height: bitmap.height };
        const now = performance.now(); this.live.frames = [...this.live.frames.filter(t => now - t < 1000), now];
        requestAnimationFrame(() => this.paintLive(true));
        await new Promise(resolve => setTimeout(resolve, 1000 / 30));
      }
    }
    liveGeometry() {
      const viewport = $('tether-live-viewport'), size = this.live.size; if (!size || !this.live.open) return null;
      const w = viewport.clientWidth, h = viewport.clientHeight, dpr = window.devicePixelRatio || 1;
      const scale = this.live.loupe ? 1 / dpr : Math.min(w / size.width, h / size.height);
      const width = size.width * scale, height = size.height * scale;
      let x = (w - width) / 2, y = (h - height) / 2;
      if (this.live.loupe) { x = w / 2 - this.live.center.x * width; y = h / 2 - this.live.center.y * height; if (width > w) x = Math.min(0, Math.max(w - width, x)); else x = (w - width) / 2; if (height > h) y = Math.min(0, Math.max(h - height, y)); else y = (h - height) / 2; }
      return { rect: { x, y, width, height } };
    }
    paintLive(fresh = false) {
      const canvas = $('tether-live-canvas'), viewport = $('tether-live-viewport'), dpr = window.devicePixelRatio || 1;
      const w = viewport.clientWidth, h = viewport.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; }
      const ctx = canvas.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      $('tether-live-empty').hidden = !!this.live.bitmap;
      const g = this.liveGeometry(); if (!g || !this.live.bitmap) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = !this.live.loupe;
      ctx.drawImage(this.live.bitmap, g.rect.x, g.rect.y, g.rect.width, g.rect.height);
      $('tether-live-fps').textContent = `${this.live.frames.length} fps · ${this.live.size.width} × ${this.live.size.height}`;
      if (fresh) this.analyzeLive();
      this.liveLayer.invalidate();
    }
    analyzeLive() {
      const c = this.composition(), now = performance.now(), inspector = this.studio() && !this.testShown() && this.host.inspectorVisible() && now - this.liveHistogramAt > 200;
      const need = c.peaking?.shown || c.warning?.shown || c.histogram?.shown || inspector;
      if (!need || !this.live.bitmap) { $('tether-live-histogram').hidden = !c.histogram?.shown; return; }
      const scale = Math.min(1, 960 / Math.max(this.live.size.width, this.live.size.height)), w = Math.max(1, Math.round(this.live.size.width * scale)), h = Math.max(1, Math.round(this.live.size.height * scale));
      const scratch = this.liveScratch ||= document.createElement('canvas'); scratch.width = w; scratch.height = h;
      const ctx = scratch.getContext('2d', { willReadFrequently: true }); ctx.drawImage(this.live.bitmap, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      if (c.peaking?.shown || c.warning?.shown) this.liveLayer.setFrame({ key: String(this.live.seq), width: w, height: h, data });
      $('tether-live-histogram').hidden = !c.histogram?.shown;
      if (!c.histogram?.shown && !inspector) return;
      const hist = O.computeHistogram(data, w, h);
      if (c.histogram?.shown) this.drawHistogram($('tether-live-histogram'), hist, c.histogram.mode);
      if (inspector) { this.liveHistogramAt = now; this.histogramKey = 'live'; this.paintInspectorHistogram(hist, 'Live View'); }
    }
    drawHistogram(canvas, hist, mode = 'rgb+luma') {
      const ctx = canvas.getContext('2d'), { heights } = PhotoCullDevelopLogic.histogramData(hist), W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
      const channels = [[0, 'rgba(220,220,220,.55)', mode !== 'rgb'], [1, 'rgba(255,80,80,.6)', mode !== 'luma'], [2, 'rgba(80,220,110,.6)', mode !== 'luma'], [3, 'rgba(90,140,255,.6)', mode !== 'luma']];
      for (const [index, color, on] of channels) {
        if (!on) continue; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, H);
        heights[index].forEach((v, i) => ctx.lineTo(i / 255 * W, H - v * H)); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    async renderHistogram() {
      if (!this.studio() || this.live.enabled && this.live.bitmap && !this.testShown()) return;
      const item = this.host.photo(), session = this.host.session(), test = this.testShown() && this.test.frame;
      const key = test ? `test:${test.key}` : item && session ? `${session.id}:${item.id}:${item.contentRev || 0}:${item.developRevision || 0}:${this.host.original()}` : '';
      if (key === this.histogramKey) return;
      this.histogramKey = key;
      if (!key) return this.paintInspectorHistogram(null, '');
      const name = test ? 'Test shot · not saved' : item.name;
      try {
        const frame = await this.reviewPixels(1600);
        if (key === this.histogramKey && frame) this.paintInspectorHistogram(O.computeHistogram(frame.data, frame.width, frame.height), name);
      } catch { if (key === this.histogramKey) { this.paintInspectorHistogram(null, name); $('tether-histogram-clip').textContent = 'Histogram unavailable for this photo.'; } }
    }
    paintInspectorHistogram(hist, source) {
      const canvas = $('tether-inspector-histogram');
      $('tether-histogram-source').textContent = source; $('tether-histogram-source').title = source;
      if (!hist?.total) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); $('tether-histogram-clip').textContent = ''; return; }
      this.drawHistogram(canvas, hist);
      const w = this.composition().warning || {}, high = w.high ?? 250, low = w.low ?? 5;
      let over = 0, under = 0; for (let i = 0; i < 256; i++) { if (i >= high) over += hist.luma[i]; if (i <= low) under += hist.luma[i]; }
      const pct = n => !n ? '0%' : n / hist.total < 0.001 ? '<0.1%' : `${(n / hist.total * 100).toFixed(1)}%`;
      $('tether-histogram-clip').textContent = `Highlights ${pct(over)} · Shadows ${pct(under)}`;
    }
    bindLivePan() {
      const viewport = $('tether-live-viewport'); let drag = null;
      viewport.addEventListener('pointerdown', event => { if (!this.live.loupe || event.button !== 0 || event.target !== $('tether-live-canvas')) return; drag = { x: event.clientX, y: event.clientY, center: { ...this.live.center } }; viewport.setPointerCapture(event.pointerId); });
      viewport.addEventListener('pointermove', event => {
        if (!drag) return; const g = this.liveGeometry(); if (!g) return;
        this.live.center = { x: Math.max(0, Math.min(1, drag.center.x - (event.clientX - drag.x) / g.rect.width)), y: Math.max(0, Math.min(1, drag.center.y - (event.clientY - drag.y) / g.rect.height)) };
        this.paintLive();
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(type, () => { drag = null; });
      viewport.addEventListener('keydown', event => {
        if (!this.live.loupe) return; const d = { ArrowLeft: [-.05, 0], ArrowRight: [.05, 0], ArrowUp: [0, -.05], ArrowDown: [0, .05] }[event.key]; if (!d) return;
        event.preventDefault(); event.stopPropagation(); this.live.center = { x: Math.max(0, Math.min(1, this.live.center.x + d[0])), y: Math.max(0, Math.min(1, this.live.center.y + d[1])) }; this.paintLive();
      });
      viewport.addEventListener('dblclick', () => { this.live.loupe = !this.live.loupe; this.renderLive(); this.paintLive(); });
    }
    renderLive() {
      const stage = $('tether-live-stage');
      stage.hidden = !this.live.open; stage.classList.toggle('docked', this.live.docked);
      document.body.classList.toggle('tether-stage-open', this.stageExpanded());
      this.placeStage();
      $('tether-live-dock').disabled = this.live.docked && this.test.active && this.test.hasShot;
      $('tether-live-dock').setAttribute('aria-pressed', String(this.live.docked)); $('tether-live-dock').textContent = this.live.docked ? 'Expand' : 'Dock';
      $('tether-live-loupe').setAttribute('aria-pressed', String(this.live.loupe)); $('tether-live-reset').disabled = !this.live.loupe;
      $('tether-live-toggle')?.setAttribute('aria-pressed', String(this.live.open));
      $('tether-stage-live').setAttribute('aria-pressed', String(this.live.open)); $('tether-stage-live').disabled = !this.enabled('tether-live-view');
      if (!this.live.enabled && this.live.open && !$('tether-live-status').textContent) $('tether-live-status').textContent = 'Live View stopped';
      for (const button of document.querySelectorAll('[data-focus]')) {
        const size = button.dataset.size, dir = button.dataset.focus;
        const action = dir === 'af' ? (this.actionState('halfPress').available ? this.actionState('halfPress') : this.actionState('af')) : this.actionState(`focus${dir === 'near' ? 'Near' : 'Far'}${size}`);
        button.disabled = !this.connected() || !action.available;
        if (!action.available && action.reason) button.title = action.reason;
      }
    }

    // Expanded Live View covers the photo stage only, so the filmstrip and decision bar stay usable; the controls it hides leave the tab order.
    placeStage() {
      const stage = $('tether-live-stage'), image = $('image-stage'), expanded = this.stageExpanded();
      image.inert = expanded;
      const over = expanded && image.offsetParent && stage.offsetParent;
      stage.classList.toggle('over-image', !!over);
      if (!over) { stage.style.top = stage.style.left = stage.style.width = stage.style.height = ''; return; }
      const r = image.getBoundingClientRect(), m = stage.offsetParent.getBoundingClientRect();
      Object.assign(stage.style, { top: `${r.top - m.top}px`, left: `${r.left - m.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    }

    // ---- Review aids ----
    selectionChanged() {
      const item = this.host.photo(), key = this.testShown() ? `test:${this.test.frame.key}` : item ? `${item.id}:${item.contentRev || 0}:${this.host.original()}` : '';
      if (key !== this.reviewKey) { this.reviewKey = key; this.layer.imageChanged(); this.toggleWhiteBalancePick(false); }
      this.renderWhiteBalancePick();
      this.layer.setEnabled(['review', 'tether'].includes(this.host.mode()));
      this.schedulePrimary();
      if (this.studio()) { this.renderAdjustments(); $('tether-overlay-photo').disabled = !item; this.renderFollow(); void this.renderHistogram(); }
    }
    async reviewPixels(max) {
      if (this.testShown()) {
        const test = this.test.frame, key = `test:${test.key}`;
        if (this.reviewFrame?.key === key) return this.reviewFrame;
        const frame = await this.rasterize(test.blob, max);
        return this.test.frame === test ? this.reviewFrame = { key, ...frame } : null;
      }
      const item = this.host.photo(), session = this.host.session(); if (!item || !session) return null;
      const key = `${session.id}:${item.id}:${item.contentRev || 0}:${this.host.original()}`;
      if (this.reviewFrame?.key === key) return this.reviewFrame;
      const frame = await this.rasterize(await this.previewBlob(item, session.id, this.host.original()), max);
      if (this.host.photo()?.id !== item.id) return null;
      return this.reviewFrame = { key, ...frame };
    }
    async previewBlob(item, session, original) {
      if (this.api.canTether) return (await this.api.tetherReviewFrame({ session, id: item.id, kind: 'preview', original, contentRev: item.contentRev || 0 })).blob;
      const response = await fetch(this.host.imageUrl(item, 'preview'));
      if (!response.ok) throw new Error(`preview ${response.status}`);
      return response.blob();
    }
    async rasterize(source, max) {
      const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height)), width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0, width, height);
      if (source instanceof Blob) bitmap.close?.();
      return { width, height, data: ctx.getImageData(0, 0, width, height).data };
    }
    async loadAsset() {
      const asset = this.shoot?.overlayAsset;
      if (!asset?.assetId || !this.api.canTether) { if (this.shoot) this.setAsset(null); return; }
      try { const bitmap = await createImageBitmap(await this.api.tetherOverlayImage(this.shoot.shootId, asset.assetId)); this.setAsset({ image: bitmap, width: bitmap.width, height: bitmap.height }, asset.name || 'Overlay image'); }
      catch (error) { this.setAsset(null); this.compositionStatus(`Overlay image unavailable: ${error.message}`); }
    }
    setAsset(asset, name = '') {
      if (this.asset?.image !== asset?.image) this.asset?.image?.close?.();
      this.asset = asset; this.assetName = name;
      this.layer.setAsset(asset); this.liveLayer.setAsset(asset);
      if (!asset) { this.layer.setMoving(false); this.liveLayer.setMoving(false); }
      this.renderComposition();
    }
    async chooseOverlay(source) {
      try {
        if (this.shoot && this.api.canTether) {
          const item = this.host.photo();
          const result = await this.api.tetherOverlayPick({ shootId: this.shoot.shootId, source, ...(source === 'session' ? { session: this.host.session().id, id: item?.id } : {}) });
          if (!result) return;
          this.shoot.overlayAsset = { ...result, name: source === 'session' ? item?.name : 'Overlay image' };
          await this.loadAsset();
        } else if (source === 'file') { $('tether-overlay-input').value = ''; $('tether-overlay-input').click(); return; }
        else {
          const item = this.host.photo(); if (!item) return;
          const blob = await fetch(this.host.imageUrl(item, 'preview')).then(r => { if (!r.ok) throw new Error(`preview ${r.status}`); return r.blob(); });
          const bitmap = await createImageBitmap(blob); this.setAsset({ image: bitmap, width: bitmap.width, height: bitmap.height }, item.name);
        }
        if (!this.composition().overlay?.shown) this.setComposition('overlay', { shown: true }, 0);
      } catch (error) { this.host.toast(error.message); }
    }
    async loadOverlayFile(file) {
      if (!file) return;
      try { const bitmap = await createImageBitmap(file); this.setAsset({ image: bitmap, width: bitmap.width, height: bitmap.height }, file.name); if (!this.composition().overlay?.shown) this.setComposition('overlay', { shown: true }, 0); }
      catch { this.host.toast('That file could not be read as an image.'); }
    }
    clearOverlay() {
      this.setAsset(null); this.setComposition('overlay', { shown: false }, 0);
      if (this.shoot) {
        this.shoot.overlayAsset = null;
        if (this.api.canTether) void this.api.tetherOverlayPick({ shootId: this.shoot.shootId, source: 'clear' }).catch(error => this.host.toast(error.message));
      }
    }
    toggleMove() {
      const layer = this.stageExpanded() ? this.liveLayer : this.layer;
      const on = layer.setMoving(!layer.moving);
      if (on) layer.canvas.focus(); else if (!on && !this.asset) this.host.toast('Choose an overlay image first.');
      this.renderComposition();
    }
    overlayMoved(position, done) { this.setComposition('overlay', { x: position.x, y: position.y }, done ? 0 : 300); if (done) this.renderComposition(); }

    // ---- Primary publishing ----
    primaryUsed() { return !!this.shoot && ['primary', 'last'].includes(this.config().adjustments?.mode); }
    schedulePrimary(draft = null) {
      if (!this.primaryUsed()) return;
      this.primaryPending = { draft: draft ?? this.primaryPending?.draft ?? null };
      clearTimeout(this.primaryTimer);
      this.primaryTimer = setTimeout(() => void this.publishPrimary().catch(() => {}), 150);
    }
    publishPrimary() {
      clearTimeout(this.primaryTimer);
      const pending = this.primaryPending, shoot = this.shoot; this.primaryPending = null;
      if (!pending || !shoot) return this.primaryRequest || Promise.resolve(this.primaryAck);
      const item = this.host.photo(), draft = pending.draft, seq = ++this.primarySeq;
      const input = { seq, id: item?.raw && !item.trashed ? item.id : null, ...(draft && draft.id === item?.id ? { settings: draft.settings, recipe: draft.recipe } : {}) };
      const request = this.primaryRequest = this.api.tetherPrimary(shoot.shootId, shoot.session, input).then(result => {
        if (this.shoot?.shootId === shoot.shootId) this.primaryAck = Math.max(this.primaryAck, result?.acceptedSeq ?? seq);
        return this.primaryAck;
      }, error => { if (error.code !== 'STALE_REV') this.host.toast(error.message); throw error; })
        .finally(() => { if (this.primaryRequest === request) this.primaryRequest = null; });
      return request;
    }
    // The shutter carries the newest Primary that Node has acknowledged, publishing the current one first.
    async flushPrimary() {
      if (this.primaryUsed() && !this.primaryAck && !this.primaryPending && !this.primaryRequest) this.primaryPending = { draft: null };
      if (this.primaryPending) await this.publishPrimary();
      else if (this.primaryRequest) await this.primaryRequest;
      return this.primaryAck;
    }
    draftChanged(draft) { if (draft?.session === this.shoot?.session) this.schedulePrimary(draft); }

    chime() { this.tones([[880, 0], [1320, 0.09]], 'sine', 0.12, 0.18); }
    alarm() { this.tones([[392, 0], [262, 0.22]], 'triangle', 0.2, 0.3); }
    tones(notes, type, peak, length) {
      try {
        const ctx = this.audio ||= new (window.AudioContext || window.webkitAudioContext)(), now = ctx.currentTime;
        for (const [freq, at] of notes) {
          const osc = ctx.createOscillator(), gain = ctx.createGain(); osc.frequency.value = freq; osc.type = type;
          gain.gain.setValueAtTime(0.0001, now + at); gain.gain.exponentialRampToValueAtTime(peak, now + at + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, now + at + length);
          osc.connect(gain).connect(ctx.destination); osc.start(now + at); osc.stop(now + at + length + 0.02);
        }
      } catch {}
    }

    // ---- Studio flash ----
    flash() { return { ...FLASH_DEFAULTS, ...this.config().flash }; }
    // Bodies report FEL as a capability or, from the camera shell, as an action.
    fel() {
      const cap = this.camera.capabilities?.fel;
      if (cap) return { supported: !!cap.supported, enabled: !!cap.supported && cap.enabled !== false, reason: cap.reason || '' };
      const action = this.camera.actions?.fel;
      return action ? { supported: true, enabled: action.available, reason: action.reason } : { supported: false, enabled: false, reason: '' };
    }
    felLocked() { const p = this.camera.properties.get('felState'), text = String(p?.display ?? p?.value ?? ''); return p?.value === true || /locked/i.test(text) && !/unlocked/i.test(text); }
    renderFlash() {
      const f = this.flash();
      for (const [id, value, label] of [['tether-flash-sync', f.syncLimit, `1/${f.syncLimit}`], ['tether-flash-recycle', f.recycleMs, `${f.recycleMs / 1000} s`]]) {
        const select = $(id);
        if (![...select.options].some(option => option.value === String(value))) select.add(new Option(label, String(value)));
        select.value = String(value);
      }
      $('tether-flash-misfire').checked = f.misfireAlert !== false;
      $('tether-flash-misfire-chime').checked = !!f.misfireChime; $('tether-flash-misfire-chime').disabled = f.misfireAlert === false;
      const p = this.camera.properties.get('shutter'), shutter = p ? String(p.display ?? p.value ?? '') : '', over = this.connected() && isOverSyncLimit(shutter, f.syncLimit);
      const text = over ? `Shutter ${shutter.replace(/\s*s$/i, '')} exceeds 1/${f.syncLimit} sync limit — curtain band risk` : '';
      for (const id of ['tether-sync-warning', 'tether-stage-sync-warning']) { $(id).hidden = !over; $(id).textContent = text; }
      $('tether-prop-shutter')?.closest('.tether-property')?.classList.toggle('is-sync-warn', over);
      $('tether-lcd').querySelector('[data-lcd="shutter"]').classList.toggle('is-sync-warn', over);
      const fel = this.fel(), locked = this.felLocked(), button = $('tether-fel');
      button.hidden = !fel.supported; button.disabled = !fel.enabled || !this.shoot || !this.connected();
      button.setAttribute('aria-pressed', String(locked));
      button.title = !fel.enabled && fel.reason ? fel.reason : locked ? 'Flash exposure locked. Press to release.' : 'Fire a pre-flash and lock flash exposure (FEL)';
      this.renderMisfire();
    }
    // The cooldown guards the software shutter only; body captures always arrive.
    recycling() { return Math.max(0, this.recycleUntil - performance.now()); }
    startRecycle() {
      const ms = Number(this.flash().recycleMs); if (!(ms > 0)) return;
      this.recycleUntil = performance.now() + ms; clearInterval(this.recycleTimer);
      this.recycleTimer = setInterval(() => { if (this.recycling()) this.renderRecycle(); else this.stopRecycle(); }, 100);
      this.renderCamera();
    }
    stopRecycle() { clearInterval(this.recycleTimer); this.recycleTimer = 0; this.recycleUntil = 0; this.renderCamera(); }
    renderRecycle() {
      const left = this.recycling(), text = left ? `Recycling ${(left / 1000).toFixed(1)} s` : '';
      for (const id of ['tether-capture', 'tether-live-capture']) { const button = $(id); button.classList.toggle('is-recycling', !!left); button.querySelector('.tether-recycle').textContent = text; }
    }
    resetMisfire(newShoot = false) {
      const history = new FlashHistory(newShoot ? undefined : this.misfire.history.exposures);
      Object.assign(this.misfire, { history, chain: Promise.resolve(), shown: false, detail: '' });
      this.renderMisfire();
    }
    clearMisfire() { this.misfire.shown = false; this.renderMisfire(); }
    // Frames are measured in arrival order so the baseline is always the newest three normal frames.
    queueLuma(exposureId, read, pendingKeep) {
      const m = this.misfire, history = m.history;
      m.chain = m.chain.then(async () => {
        // Keep can publish the library delta before it replies with the promoted exposure ID.
        if (pendingKeep) await pendingKeep.catch(() => {});
        if (history !== m.history || history.exposures.has(exposureId)) return;
        const frame = await read();
        if (!frame || history !== m.history) return;
        const result = history.measure(exposureId, O.computeHistogram(frame.data, frame.width, frame.height));
        if (!result) return;
        m.shown = result.misfire; m.detail = result.detail;
        if (m.shown && this.flash().misfireChime) this.alarm();
        this.renderMisfire();
      }).catch(() => {});
    }
    async itemFrame(id) {
      const item = this.host.item(id), session = this.host.session()?.id;
      return item && session ? this.rasterize(await this.previewBlob(item, session, false), 256) : null;
    }
    renderMisfire() {
      $('tether-misfire-pill').hidden = !this.misfire.shown || this.flash().misfireAlert === false;
      $('tether-misfire-detail').textContent = this.misfire.detail;
      this.renderStageAlerts();
    }
    renderStageAlerts() { const alerts = $('tether-stage-alerts'); alerts.hidden = [...alerts.children].every(node => node.hidden); }

    // ---- Test Shot (Composition) Mode: frames preview on the stage without joining the session ----
    testShown() { return this.test.active && !!this.test.frame && this.host.mode() === 'tether'; }
    async toggleComposition(on = !this.test.active) {
      if (!this.shoot || this.test.busy) return;
      if (on && !this.connected()) return this.host.toast('Connect a camera to take test shots.');
      this.test.busy = true; this.renderTest();
      try {
        const shootId = this.shoot.shootId;
        await this.api.tetherControl(shootId, this.camera.epoch, on ? 'composition-on' : 'composition-off');
        if (shootId !== this.shoot?.shootId) return;
        this.setTestActive(on);
        this.host.toast(on ? 'Test Shot Mode on · shots are not saved' : 'Test Shot Mode off');
      } catch (error) { this.host.toast(error.message); }
      finally { this.test.busy = false; this.render(); }
    }
    setTestActive(active) {
      if (active !== this.test.active) { this.stopRecycle(); this.resetMisfire(); }
      this.test.active = active;
      if (!active) this.clearTestShot();
    }
    resetTest() { this.test.active = false; this.clearTestShot(); }
    dockForTestShot() {
      if (!this.test.hasShot || !this.stageExpanded()) return;
      this.test.restoreLiveExpanded = true; this.live.docked = true;
      this.renderLive();
    }
    async receiveComposition(event) {
      if (!this.shoot || event.shootId && event.shootId !== this.shoot.shootId) return;
      this.setTestActive(!!event.active);
      if (event.active && event.hasShot) {
        const t = this.test, seq = event.testSeq, rev = event.previewRev ?? 0;
        if (t.hasShot && (seq < t.testSeq || seq === t.testSeq && rev < t.previewRev)) return;
        const newShot = t.testSeq !== seq;
        Object.assign(t, { hasShot: true, awaitingShot: false, testSeq: seq, previewRev: rev, pairComplete: event.pairComplete !== false, meta: event.meta });
        if (newShot && this.connected()) this.startRecycle();
        this.dockForTestShot();
        if (newShot) this.host.stageChanged();
        this.renderTest();
        const key = `${seq}:${rev}`;
        if (key !== t.frame?.key && key !== t.want) await this.loadTestShot(event, key);
        else if (key === t.frame?.key && event.meta) {
          t.frame.meta = event.meta; this.host.showTestShot(t.frame);
        }
      } else if (event.active) this.clearTestShot();
      this.render();
    }
    async loadTestShot(event, key) {
      const shootId = this.shoot.shootId, seq = event.testSeq, current = () => this.test.want === key && this.test.active && this.shoot?.shootId === shootId;
      const history = this.misfire.history;
      this.test.want = key;
      let url = null;
      try {
        const { blob } = await this.api.tetherCompositionFrame(shootId, seq, event.previewRev ?? 0);
        if (!current()) return;
        url = URL.createObjectURL(blob);
        const probe = new Image(); probe.src = url; await probe.decode();
        if (!current()) return;
        const old = this.test.frame;
        this.test.frame = { seq, key, url, blob, width: probe.naturalWidth, height: probe.naturalHeight, meta: this.test.meta || null }; url = null;
        this.host.showTestShot(this.test.frame);
        if (old) URL.revokeObjectURL(old.url);
        if (history === this.misfire.history && this.flash().misfireAlert) this.queueLuma(`test:${seq}`, () => this.rasterize(blob, 256));
      } catch (error) { if (current()) this.host.toast(`Test shot unavailable: ${error.message}`); }
      finally { if (current()) this.test.want = null; if (url) URL.revokeObjectURL(url); }
    }
    clearTestShot() {
      const t = this.test, frame = t.frame, hadShot = t.hasShot;
      Object.assign(t, { frame: null, hasShot: false, awaitingShot: false, testSeq: null, want: null, pairComplete: true });
      if (t.restoreLiveExpanded) {
        t.restoreLiveExpanded = false; this.live.docked = false; this.renderLive();
      }
      if (frame) { this.host.showTestShot(null); URL.revokeObjectURL(frame.url); }
      else if (hadShot) this.host.stageChanged();
    }
    async resolveTestShot(op) {
      const t = this.test, shootId = this.shoot?.shootId, seq = t.frame?.seq;
      if (!shootId || !t.hasShot || seq !== t.testSeq || !t.pairComplete || t.busy) return;
      t.busy = true; this.renderTest();
      try {
        const request = this.api.tetherControl(shootId, this.camera.epoch, `composition-${op}`, { testSeq: seq });
        if (op === 'keep') this.pendingKeep = request;
        const reply = await request;
        if (shootId !== this.shoot?.shootId) return;
        if (op === 'keep' && reply.exposureId) this.misfire.history.kept(reply.exposureId);
        if (reply.testSeq === seq && t.testSeq === seq) this.clearTestShot();
        this.host.toast(op === 'keep' ? 'Test shot kept · it joins the shoot like a capture' : 'Test shot discarded');
      } catch (error) {
        if (error.code === 'PAIR_PENDING') {
          this.host.toast('Waiting for the RAW companion. Retry when it arrives.');
        } else if (error.code === 'STALE_SHOT') this.host.toast('A newer test shot is available. Review it before continuing.');
        else this.host.toast(error.message);
      } finally { if (op === 'keep') this.pendingKeep = null; t.busy = false; this.render(); }
    }
    renderTest() {
      const t = this.test, enabled = this.enabled('tether-composition') && !t.busy, meta = t.frame?.meta;
      for (const id of ['tether-composition-toggle', 'tether-stage-composition']) { $(id).setAttribute('aria-pressed', String(t.active)); $(id).disabled = !enabled; }
      $('tether-composition-banner').hidden = !t.active;
      $('tether-composition-keep').disabled = $('tether-composition-discard').disabled = !t.hasShot || t.frame?.seq !== t.testSeq || !t.pairComplete || t.busy;
      $('tether-composition-meta').textContent = [meta?.shutter, meta?.aperture, meta?.iso && `ISO ${meta.iso}`, meta?.focalLength, meta?.flash, t.hasShot && !t.pairComplete && 'Waiting for RAW…'].filter(Boolean).join(' · ');
      this.renderStageAlerts();
    }

    // ---- White balance eyedropper ----
    canPickWhiteBalance() {
      const item = this.host.photo();
      return this.host.mode() === 'tether' && !!this.api.canDevelop && !!item?.raw && !item.trashed && !item.externalEdit && !this.test.hasShot && !this.stageExpanded();
    }
    toggleWhiteBalancePick(on = !this.wbArmed) {
      on = !!on && this.canPickWhiteBalance();
      if (on === this.wbArmed) return;
      this.wbArmed = on;
      this.releasePickImage();
      this.renderWhiteBalancePick();
      if (!on) return;
      const stage = this.host.displayedReview();
      if (stage && this.needsReadableImage(stage)) void this.preparePickImage(stage);
      this.toast('Click a neutral gray or white area · Esc cancels');
    }
    needsReadableImage({ rep }) {
      const url = new URL(rep.url, document.baseURI);
      return url.protocol !== 'blob:' && url.protocol !== 'data:' && url.origin !== location.origin;
    }
    releasePickImage() {
      const pending = this.pickImage; this.pickImage = null;
      if (!pending?.url) return;
      if (pending.image.src === pending.url) pending.image.src = pending.rep.url;
      URL.revokeObjectURL(pending.url);
    }
    // The desktop loopback rendition cannot be read by a canvas. Display its bridge-provided pixels before accepting a click.
    async preparePickImage(stage) {
      this.releasePickImage();
      const pending = this.pickImage = { ...stage };
      const item = this.host.photo(), session = this.host.session()?.id;
      try {
        const { blob } = await this.api.tetherReviewFrame({ session, id: item.id, kind: stage.rep.kind === 'full' ? 'full' : 'preview', original: this.host.original(), contentRev: item.contentRev || 0 });
        if (this.pickImage !== pending) return;
        if (this.host.displayedReview()?.rep !== stage.rep) { this.releasePickImage(); return; }
        pending.url = URL.createObjectURL(blob); stage.image.src = pending.url;
        await stage.image.decode();
      } catch (error) {
        if (this.pickImage === pending) { this.toggleWhiteBalancePick(false); this.host.toast(error.message); }
      }
    }
    renderWhiteBalancePick() {
      if (this.wbArmed && !this.canPickWhiteBalance()) { this.wbArmed = false; this.releasePickImage(); }
      const button = $('tether-wb-pick');
      button.disabled = this.wbBusy || !this.canPickWhiteBalance(); button.setAttribute('aria-pressed', String(this.wbArmed));
      this.host.reviewViewport.classList.toggle('is-wb-pick', this.wbArmed);
    }
    async pickWhiteBalance(event) {
      const item = this.host.photo(), session = this.host.session()?.id, stage = this.host.displayedReview();
      if (!stage || !session || this.wbBusy || !this.canPickWhiteBalance()) return;
      const { rep, image } = stage;
      if (this.needsReadableImage(stage) && !(this.pickImage?.rep === rep && this.pickImage.url && image.src === this.pickImage.url)) {
        if (this.pickImage?.rep !== rep || this.pickImage.url) void this.preparePickImage(stage);
        return this.toast('Wait for the preview, then pick White Balance.');
      }
      const displayedUrl = this.pickImage?.rep === rep ? this.pickImage.url : rep.url;
      if (!image.complete || !image.naturalWidth || image.currentSrc !== displayedUrl || image.src !== displayedUrl) return;
      this.wbBusy = true; this.renderWhiteBalancePick();
      try {
        const sample = D.sampleImagePatch(image, event.clientX, event.clientY);
        if (!sample) return;
        await this.host.flushDevelop();
        const [saved, info] = await Promise.all([this.api.developGet(session, item.id), this.api.developInfo(session, item.id)]);
        if (!this.wbArmed || !this.canPickWhiteBalance() || this.host.session()?.id !== session || this.host.photo()?.id !== item.id || this.host.displayedReview()?.rep !== rep) return;
        const current = D.frameWhiteBalance(rep.wb || { mode: 'asShot' }, info);
        const wb = D.solveWhiteBalance(sample.r, sample.g, sample.b, current.temp, current.tint);
        if (wb.error) return this.host.toast(wb.error);
        const recipe = saved.recipe ?? null, settings = { ...clone(saved.settings || {}), wb: { ...saved.settings?.wb, mode: 'custom', temp: wb.temp, tint: wb.tint } };
        const result = await this.api.developSet(session, [item.id], { recipe, settings });
        this.host.updateItems(session, result?.items || []);
        if (this.host.session()?.id !== session || this.host.photo()?.id !== item.id) return;
        this.toggleWhiteBalancePick(false);
        this.schedulePrimary({ session, id: item.id, recipe, settings });
        const a = this.config().adjustments || {}, copied = ['last', 'primary'].includes(a.mode || 'last') && (a.groups || []).includes('wb');
        this.host.toast(`WB set to ${wb.temp} K · Tint ${signed(wb.tint)}${copied ? ' (copied to next captures)' : ' — enable Copy from Last (WB) to lock for next shots'}`);
        this.showDeveloped(item.id, await this.developedFrame(this.host.item(item.id) || item));
      } catch (error) { this.host.toast(error.message); }
      finally { this.wbBusy = false; this.renderWhiteBalancePick(); }
    }

    // ---- Commands ----
    command(id, event = {}) {
      switch (id) {
        case 'tether-start': return this.openStart();
        case 'tether-stop': return this.stopSession();
        case 'tether-aids': this.openPanel(); return this.toggleDrawer(true);
        case 'tether-shutter': return this.capture(event);
        case 'tether-pause': if (!event.repeat) return this.togglePause(); return;
        case 'tether-live-view': if (!event.repeat) return this.toggleLive(); return;
        case 'tether-af': return this.afPulse();
        case 'tether-overlay-toggle': if (!this.asset) return this.host.toast('Choose an overlay image under Configure aids first.'); return void this.toggleAid('overlay');
        case 'tether-focus-mask': if (!event.repeat) this.toast(this.toggleAid('mask') ? 'Focus mask on' : 'Focus mask off'); return;
        case 'tether-exposure-warning': if (!event.repeat) this.toast(this.toggleAid('warning') ? 'Exposure warning on' : 'Exposure warning off'); return;
        case 'tether-guides-toggle': return void this.toggleAid('grid');
        case 'tether-aspect-toggle': return void this.toggleAid('aspect');
        case 'tether-jump-latest': return this.jumpLatest();
        case 'tether-follow-pause': return this.toggleFollowPause();
        case 'tether-pin-reference': return this.pinReference();
        case 'tether-new-shot': this.openPanel(); return this.newShot();
        case 'tether-counter-reset': return this.counter('reset');
        case 'tether-composition': if (!event.repeat) return this.toggleComposition(); return;
      }
    }
    toast(text) { this.statusShown = false; $('overlay-status').hidden = false; $('overlay-status').textContent = text; clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { $('overlay-status').hidden = true; }, 1400); }
  }
  const api = { create: host => new Tether(host), parseShutterSeconds, isOverSyncLimit, FlashHistory };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.PhotoCullTether = api;
})(globalThis);

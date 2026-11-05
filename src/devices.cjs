const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { DOMParser } = require('@xmldom/xmldom');
const { SUPPORTED } = require('./library.cjs');

const WINDOWS_QUERY = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in @(2,3) } | Select-Object DeviceID,VolumeName,VolumeSerialNumber,DriveType) | ConvertTo-Json -Compress`;
function windowsRoots(value, wsl = false) {
  return (Array.isArray(value) ? value : value ? [value] : []).filter(d => /^[A-Za-z]:$/.test(d.DeviceID)).map(d => ({
    root: wsl ? `/mnt/${d.DeviceID[0].toLowerCase()}` : d.DeviceID + '\\',
    label: d.VolumeName || d.DeviceID, removable: Number(d.DriveType) === 2, identity: d.VolumeSerialNumber || d.DeviceID,
  }));
}
function linuxRoots(value) {
  const output = [];
  function visit(device, removable = false) {
    removable ||= !!device.rm || !!device.hotplug || ['usb', 'mmc'].includes(device.tran);
    if (removable) for (const root of device.mountpoints || [device.mountpoint]) if (root) output.push({ root, label: device.label || path.basename(root), removable: true, identity: device.uuid || root });
    for (const child of device.children || []) visit(child, removable);
  }
  for (const device of value.blockdevices || []) visit(device);
  return output;
}
function parseDiskInfo(plist) {
  // Read only top-level scalar fields; XML decoding also handles Unicode volume names.
  if (/<!ENTITY/i.test(plist)) throw new Error('Invalid disk information.');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(plist, 'application/xml');
  const dict = [...(doc.documentElement?.childNodes || [])].find(node => node.nodeType === 1 && node.localName === 'dict');
  const nodes = [...(dict?.childNodes || [])].filter(node => node.nodeType === 1), info = {};
  const allowed = new Set(['Mounted','MountPoint','Internal','DiskImage','BusProtocol','VolumeName','VolumeUUID','MediaUUID','DeviceIdentifier']);
  for (let i = 0; i + 1 < nodes.length; i += 2) {
    const key = nodes[i], value = nodes[i + 1];
    if (key.localName !== 'key' || !allowed.has(key.textContent)) continue;
    if (value.localName === 'true' || value.localName === 'false') info[key.textContent] = value.localName === 'true';
    else if (value.localName === 'string' || value.localName === 'integer') info[key.textContent] = value.textContent;
  }
  return info;
}
async function macRoots({ execute: run = execute, volumeRoot = '/Volumes', readDirectory = fs.readdir } = {}) {
  // Only mounted volumes are considered. diskutil identifies card replacement at the same path.
  const entries = await readDirectory(volumeRoot, { withFileTypes: true });
  const candidates = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  const result = [];
  for (const entry of candidates) {
    const root = path.join(volumeRoot, entry.name);
    try {
      const { stdout } = await run('/usr/sbin/diskutil', ['info', '-plist', root], { timeout: 4000, maxBuffer: 1024 * 1024 });
      const info = parseDiskInfo(stdout);
      if (info.Mounted === false || info.MountPoint !== root || info.Internal === true || info.DiskImage === true || info.BusProtocol === 'Disk Image') continue;
      result.push({ root, label: info.VolumeName || entry.name, removable: true, identity: info.VolumeUUID || info.MediaUUID || info.DeviceIdentifier || root });
    } catch { /* Unavailable/unreadable volumes do not block discovery of other cards. */ }
  }
  return result;
}
async function discoverDevices(config = {}) {
  const opts = { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 };
  let roots = [];
  if (process.platform === 'win32') {
    const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], opts);
    roots = windowsRoots(JSON.parse(result.stdout.replace(/^\uFEFF/, '') || '[]'));
  } else if (process.platform === 'darwin') {
    roots = await macRoots();
  } else if (process.platform === 'linux') {
    const result = await execute('lsblk', ['-J', '-o', 'NAME,RM,HOTPLUG,TRAN,MOUNTPOINTS,LABEL,UUID,TYPE'], opts);
    roots = linuxRoots(JSON.parse(result.stdout));
    if (process.env.WSL_DISTRO_NAME) {
      try {
        const result = await execute('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], opts);
        roots.push(...windowsRoots(JSON.parse(result.stdout.replace(/^\uFEFF/, '') || '[]'), true));
      } catch { /* WSL may not expose Windows removable drives. */ }
    }
  }
  return inspectRoots([...roots,...(config.manualCards || []).map(root=>({root,label:path.basename(root),removable:true,identity:'manual:'+root,manual:true}))],config);
}
async function inspectRoots(roots, { cardFolders = ['DCIM'] } = {}) {
  const unique = new Map();
  for (const device of roots) {
    try {
      const entries = await fs.readdir(device.root, { withFileTypes: true });
      let cameraFolder = null;
      for(const layout of cardFolders) {
        let folder=device.root,found=true;
        for(const part of layout.split(/[\\/]/)) {
          const children=await fs.readdir(folder,{withFileTypes:true});
          const entry=children.find(e=>e.isDirectory()&&e.name.toLowerCase()===part.toLowerCase());
          if(!entry){found=false;break;}folder=path.join(folder,entry.name);
        }
        if(found){cameraFolder=folder;break;}
      }
      const dcim = cameraFolder;
      const camera = !!device.manual || !!dcim || entries.some(e => e.isFile() && SUPPORTED.has(path.extname(e.name).toLowerCase()));
      if (!device.removable && !dcim) continue;
      const root = await fs.realpath(device.root);
      if(device.manual && unique.has(root))continue;
      unique.set(root, { id: `${root}:${device.identity}`, identity: String(device.identity), manual: !!device.manual, root, label: device.label, camera,
        photoRoot: dcim || root });
    } catch { /* Empty readers, locked volumes, and unmounted drives are not cards. */ }
  }
  return [...unique.values()].sort((a, b) => a.root.localeCompare(b.root));
}
class DeviceMonitor {
  constructor({ discover = discoverDevices, onChange = () => {}, intervalMs = 5000 } = {}) {
    this.discover = discover; this.onChange = onChange; this.intervalMs = intervalMs;
    this.devices = []; this.error = ''; this.busy = null; this.stopped = false;
  }
  async refresh() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      try {
        const devices = await this.discover();
        if (this.stopped) return this.snapshot();
        const changed = JSON.stringify(devices) !== JSON.stringify(this.devices) || this.error;
        this.devices = devices; this.error = '';
        if (changed) this.onChange(this.snapshot());
      } catch { if (!this.stopped) { this.error = 'Card detection unavailable. You can still open a folder.'; this.onChange(this.snapshot()); } }
      finally { this.busy = null; }
      return this.snapshot();
    })();
    return this.busy;
  }
  snapshot() { return { devices: this.devices, error: this.error }; }
  start() { void this.refresh(); this.timer = setInterval(() => void this.refresh(), this.intervalMs); this.timer.unref(); }
  async close() { this.stopped = true; clearInterval(this.timer); await this.busy; }
}
module.exports = { discoverDevices, inspectRoots, windowsRoots, linuxRoots, DeviceMonitor, macRoots, parseDiskInfo };

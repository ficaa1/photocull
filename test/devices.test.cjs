const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { windowsRoots, linuxRoots, inspectRoots, DeviceMonitor } = require('../src/devices.cjs');
test('Windows volumes and nested Linux removable partitions map to card roots', () => {
  assert.deepEqual(windowsRoots({ DeviceID: 'F:', VolumeName: 'SONY', VolumeSerialNumber: 'ABC', DriveType: 2 }), [{ root: 'F:\\', label: 'SONY', removable: true, identity: 'ABC' }]);
  assert.equal(windowsRoots([{ DeviceID: 'F:', DriveType: 2 }], true)[0].root, '/mnt/f');
  assert.deepEqual(windowsRoots([{ DeviceID: 'invalid', DriveType: 2 }]), []);
  assert.equal(linuxRoots({ blockdevices: [{ rm: false, tran: 'usb', children: [{ mountpoints: ['/media/card'], uuid: 'ABC', label: 'SONY' }] }] })[0].root, '/media/card');
});
test('camera discovery finds DCIM case-insensitively, ignores internal folders and empty readers', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'photocull-device-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const folder of ['card/dcim/100SONY', 'internal', 'usb']) await fs.mkdir(path.join(root, folder), { recursive: true });
  await fs.writeFile(path.join(root, 'internal', 'photo.JPG'), 'not a card');
  const roots = ['card', 'internal', 'usb', 'empty-reader'].map(label => ({ root: path.join(root, label), label, identity: label, removable: ['card', 'usb'].includes(label) }));
  const devices = await inspectRoots(roots);
  assert.equal(devices.length, 2);
  const card = devices.find(d => d.label === 'card'); assert.ok(card.camera); assert.equal(card.photoRoot, path.join(root, 'card', 'dcim'));
  assert.equal(devices.find(d => d.label === 'usb').camera, false);
});
test('monitor detects insertion, replacement and removal without overlapping discovery', async () => {
  let value = [], count = 0, release;
  const events = []; const monitor = new DeviceMonitor({ onChange: e => events.push(e), discover: async () => { count++; return value; } });
  await monitor.refresh(); assert.equal(events.length, 0);
  value = [{ id: 'card-a' }]; await monitor.refresh(); assert.equal(events.length, 1);
  await monitor.refresh(); assert.equal(events.length, 1);
  value = [{ id: 'card-b' }]; await monitor.refresh(); assert.equal(events.length, 2);
  value = []; await monitor.refresh(); assert.equal(events.length, 3);
  monitor.discover = () => new Promise(resolve => { count++; release = resolve; });
  const before = count, first = monitor.refresh(), duplicate = monitor.refresh();
  release([]); await Promise.all([first, duplicate]); assert.equal(count, before + 1);
  await monitor.close();
});

// macRoots builds POSIX paths, so this only runs where path is POSIX.
test('macOS cards are found under /Volumes and internal/disk-image volumes are ignored', { skip: process.platform === 'win32' }, async () => {
  const {macRoots,parseDiskInfo}=require('../src/devices.cjs');
  const plist=(values)=>'<?xml version="1.0"?><plist><dict>'+Object.entries(values).map(([k,v])=>`<key>${k}</key>${typeof v==='boolean'?`<${v}/>`:`<string>${v}</string>`}`).join('')+'</dict></plist>';
  assert.equal(parseDiskInfo(plist({VolumeName:'Camera &amp; card',Internal:false})).VolumeName,'Camera & card');
  assert.equal(parseDiskInfo(plist({VolumeName:'Camera &#x2603;'})).VolumeName,'Camera ☃');
  const volumes={Camera:{Mounted:true,Internal:false,MountPoint:'/Volumes/Camera',VolumeName:'SONY',VolumeUUID:'ABC'},Internal:{Mounted:true,Internal:true,MountPoint:'/Volumes/Internal'},Installer:{Mounted:true,Internal:false,MountPoint:'/Volumes/Installer',BusProtocol:'Disk Image'}};
  const result=await macRoots({readDirectory:async()=>[...Object.keys(volumes).map(name=>({name,isDirectory:()=>true})),{name:'Macintosh HD',isDirectory:()=>false}],execute:async(_command,args)=>({stdout:plist(volumes[path.basename(args.at(-1))])})});
  assert.deepEqual(result,[{root:'/Volumes/Camera',label:'SONY',removable:true,identity:'ABC'}]);
});

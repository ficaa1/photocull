const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const commands = require('../src/renderer/commands.js');

const renderer = file => fs.readFileSync(require.resolve('../src/renderer/' + file), 'utf8');
const bridge = renderer('bridge.js');
// Load the controller declaration without starting the rest of the photo workspace.
const initUpdater = vm.compileFunction('return initUpdater;\n' + renderer('app.js'))();
// Exercise the tether controller with its normal state, omitting the camera workspace DOM.
const createTether = vm.runInNewContext(renderer('tether.js').replace('this.build();', 'return;') + '\nPhotoCullTether.create', { clearTimeout });
const html = renderer('index.html');
const available = { status: 'available', version: '0.9.4', body: 'Camera fixes.\nFaster previews.' };

function fixture() {
  const elements = {};
  for (const match of html.matchAll(/<[^<>]*\bid="([^"]+)"[^<>]*>/g)) {
    elements[match[1]] = { hidden: /\bhidden\b/.test(match[0]), textContent: '', removeAttribute(name) { delete this[name]; } };
  }
  elements['settings-update-status'].offsetParent = null;
  const $ = id => elements[id], messages = [], events = {}, prompts = [];
  const api = {
    checkForUpdates: async () => available,
    onCheckUpdates: fn => { events.menu = fn; }, onUpdateProgress: fn => { events.progress = fn; },
  };
  const toast = text => messages.push(text), confirmation = { accept: false }, workspace = { busy: false };
  const tether = createTether({ api, toast });
  tether.render = () => {};
  tether.setShoot = shoot => { tether.shoot = shoot; };
  const updater = initUpdater({ $, api, toast, getTether: () => tether,
    isBusy: () => workspace.busy, setBusy: value => { workspace.busy = value; },
    confirmInstall: text => { prompts.push(text); return confirmation.accept; } });
  return { $, api, events, messages, tether, prompts, confirmation, workspace, updater };
}

test('desktop bridge invokes the updater and delivers native menu and progress events', async () => {
  const calls = [], listeners = {}, received = [];
  const window = { __PHOTOCULL__: { platform: 'darwin' }, __TAURI__: {
    core: { invoke: async (name, args) => { calls.push([name, { ...args }]); return name === 'update_check' ? available : null; } },
    event: { listen: (name, fn) => { listeners[name] = fn; } },
  } };
  vm.runInNewContext(bridge, { window });
  const api = window.photocull;
  assert.equal(api.desktop, true);
  assert.equal(await api.checkForUpdates(), available);
  await api.installUpdate();
  await api.installUpdate('0.9.4');
  assert.deepEqual(calls, [['update_check', {}], ['update_install', {}], ['update_install', { expectedVersion: '0.9.4' }]]);
  api.onCheckUpdates(() => received.push('check'));
  const unsubscribe = api.onUpdateProgress(event => received.push(event));
  const payload = { phase: 'downloading', percent: 42 };
  listeners['check-updates-shortcut']({});
  listeners['update-progress']({ payload });
  unsubscribe();
  listeners['update-progress']({ payload });
  assert.deepEqual(received, ['check', payload]);
});

test('browser bridge reports updates as unsupported', async () => {
  const window = {};
  vm.runInNewContext(bridge, { window, location: { search: '', origin: 'http://localhost' }, URLSearchParams,
    EventSource: class { addEventListener() {} }, document: { addEventListener() {} } });
  assert.equal(window.photocull.desktop, false);
  assert.equal((await window.photocull.checkForUpdates()).status, 'unsupported');
  await assert.rejects(window.photocull.installUpdate(), /only available in the desktop app/);
});

test('Check for updates is a desktop application command in every workspace with no assigned keys', () => {
  const row = commands.table.find(command => command.id === 'check-updates');
  assert.equal(row.title, 'Check for updates…');
  assert.equal(row.category, 'Application');
  assert.equal(row.desktopOnly, true);
  for (const mode of ['review', 'develop', 'grid', 'tether', 'compare', 'stage']) assert.ok(commands.active(row, mode));
  for (const keys of Object.values(row.shortcuts)) assert.deepEqual(keys, []);
});

test('background checks keep offline studios quiet and honor dismissal for that version', async () => {
  const { $, api, updater, messages } = fixture();
  for (const response of [{ status: 'error', message: 'Offline' }, new Error('Offline'), { status: 'unsupported' }, { status: 'up-to-date' }]) {
    api.checkForUpdates = async () => { if (response instanceof Error) throw response; return response; };
    await updater.check(false);
    assert.equal($('settings-update-status').textContent, '');
    assert.equal($('update-banner').hidden, true);
  }
  api.checkForUpdates = async () => available;
  await updater.check(false);
  assert.equal($('update-banner-text').textContent, 'Update 0.9.4');
  assert.equal($('update-banner').hidden, false);
  $('update-banner-dismiss').onclick();
  await updater.check(false);
  assert.equal($('update-banner').hidden, true);
  assert.equal($('settings-install-update').hidden, false);
  api.checkForUpdates = async () => ({ ...available, version: '0.9.5' });
  await updater.check(false);
  assert.equal($('update-banner').hidden, false);
  assert.equal($('update-banner-text').textContent, 'Update 0.9.5');
  assert.deepEqual(messages, []);
});

test('a manual check joins a pending startup check and reports release notes, current version or errors', async () => {
  const { $, api, updater, events, messages } = fixture();
  let calls = 0;
  api.checkForUpdates = async () => { calls++; return available; };
  await updater.check(false);
  $('update-banner-dismiss').onclick();
  const background = updater.check(false);
  events.menu();
  assert.equal($('settings-update-status').textContent, 'Checking for updates…');
  await background;
  assert.equal(calls, 2);
  assert.equal($('update-banner').hidden, false);
  assert.equal($('settings-update-status').textContent, 'PhotoCull 0.9.4 is available · Camera fixes. Faster previews.');
  assert.deepEqual(messages, ['Checking for updates…', 'PhotoCull 0.9.4 is available']);
  $('settings-dialog').open = true;
  $('settings-update-status').offsetParent = $('settings-updates');
  api.checkForUpdates = async () => ({ status: 'up-to-date', currentVersion: '0.9.4' });
  await $('settings-check-updates').onclick();
  assert.equal($('settings-update-status').textContent, 'PhotoCull 0.9.4 is up to date');
  assert.equal(messages.length, 2);
  assert.equal($('settings-install-update').hidden, true);
  assert.equal($('update-banner').hidden, true);
  $('settings-update-status').offsetParent = null; // Settings stays open on a different tab.
  await events.menu();
  assert.deepEqual(messages.slice(-2), ['Checking for updates…', 'PhotoCull 0.9.4 is up to date']);
  api.checkForUpdates = async () => ({ status: 'error', message: 'Offline' });
  await events.menu();
  assert.match(messages.at(-1), /Couldn’t check for updates.*Offline/);
  assert.equal($('settings-update-status').textContent, messages.at(-1));
});

test('installation tracks known and unknown progress and recovers from a failed download', async () => {
  const { $, api, events, updater, messages, workspace } = fixture();
  const progress = $('settings-update-progress'), status = $('settings-update-status'), bannerText = $('update-banner-text');
  let attempts = 0;
  const pending = Promise.withResolvers();
  api.installUpdate = () => { attempts++; return pending.promise; };
  await updater.check(false);
  const install = $('update-banner-install').onclick();
  await $('settings-install-update').onclick();
  assert.equal(attempts, 1);
  assert.equal($('settings-install-update').disabled, true);
  assert.equal($('update-banner-install').disabled, true);
  for (const [payload, label, value] of [
    [{ phase: 'downloading', downloaded: 42, total: null }, 'Downloading…', undefined],
    [{ phase: 'downloading', downloaded: 21, total: 50 }, 'Downloading 42%…', 42],
    [{ phase: 'downloading', percent: 73.9 }, 'Downloading 74%…', 74],
    [{ phase: 'installing' }, 'Installing…', undefined],
  ]) {
    events.progress(payload);
    assert.equal(progress.hidden, false);
    assert.equal(progress.value, value);
    assert.equal(status.textContent, label);
    assert.equal(bannerText.textContent, label);
  }
  events.progress({ phase: 'error', message: 'Download interrupted' });
  assert.equal(workspace.busy, true);
  assert.equal(status.textContent, 'Download interrupted');
  assert.equal($('update-banner-install').disabled, true);
  pending.reject('Download interrupted');
  await install;
  assert.equal(workspace.busy, false);
  assert.deepEqual(messages, ['Download interrupted']);
  assert.equal(progress.hidden, true);
  assert.equal($('update-banner-install').disabled, false);
  api.installUpdate = async () => { throw new Error('Installer busy'); };
  await $('settings-install-update').onclick();
  assert.equal(status.textContent, 'Installer busy');
  assert.equal(bannerText.textContent, 'Update 0.9.4');
  assert.equal($('settings-check-updates').disabled, false);
  assert.equal($('settings-install-update').disabled, false);
});

test('a changed release needs a new click and a withdrawn release clears the offer', async () => {
  const { $, api, updater, messages, workspace } = fixture();
  const versions = [], progress = $('settings-update-progress'), status = $('settings-update-status');
  api.installUpdate = async version => {
    assert.equal(workspace.busy, true);
    versions.push(version);
    return versions.length === 1 ? { status: 'changed', version: '0.9.5', body: 'New release notes' }
      : { status: 'up-to-date', currentVersion: '0.9.3' };
  };
  await updater.check(false);
  $('update-banner-dismiss').onclick();
  await $('settings-install-update').onclick();
  assert.deepEqual(versions, ['0.9.4']);
  assert.equal($('update-banner').hidden, false);
  assert.equal($('update-banner-text').textContent, 'Update 0.9.5');
  assert.equal(status.textContent, 'PhotoCull 0.9.5 is available · New release notes');
  assert.equal(messages.at(-1), 'PhotoCull 0.9.5 is now available — click Install to confirm.');
  assert.equal(progress.hidden, true);
  assert.equal(workspace.busy, false);
  for (const id of ['settings-check-updates', 'settings-install-update', 'update-banner-install']) assert.equal($(id).disabled, false);
  await $('update-banner-install').onclick();
  assert.deepEqual(versions, ['0.9.4', '0.9.5']);
  assert.equal(status.textContent, 'PhotoCull 0.9.3 is up to date');
  assert.equal(messages.at(-1), status.textContent);
  assert.equal($('update-banner').hidden, true);
  assert.equal($('settings-install-update').hidden, true);
  assert.equal(progress.hidden, true);
  assert.equal($('settings-check-updates').disabled, false);
  assert.equal(workspace.busy, false);
});

test('an active workspace operation keeps its lock and its tether session', async () => {
  const { $, api, updater, tether, workspace, messages, prompts } = fixture();
  await updater.check(false);
  workspace.busy = true;
  tether.shoot = { shootId: 'studio' };
  api.installUpdate = assert.fail;
  await $('settings-install-update').onclick();
  assert.deepEqual(prompts, []);
  assert.equal(messages.at(-1), 'Finish the active operation before installing an update.');
  assert.equal(workspace.busy, true);
});

test('installation waits for captures, confirmation and a clean tether stop', async () => {
  const { $, api, updater, tether, prompts, confirmation, messages, workspace } = fixture();
  const calls = [], shoot = { shootId: 'studio', session: 'photos' };
  api.installUpdate = async version => { calls.push(version); };
  tether.shoot = shoot;
  const ledger = { ...shoot, queue: {}, space: {} };
  api.tetherState = async () => ledger;
  api.tetherControl = async (_shootId, _epoch, op) => { calls.push(op); throw new Error('Camera busy'); };
  await updater.check(false);
  for (const [source, key, value] of [
    [tether.telemetry, 'receiving', 1], [tether.telemetry, 'queued', 2], [tether, 'capturing', true],
    [ledger.queue, 'pending', 1], [ledger.queue, 'pendingPairs', 1], [ledger.queue, 'held', 1],
    [ledger.space, 'reservedBytes', 1024], [tether.test, 'busy', true], [tether.test, 'hasShot', true], [tether.test, 'awaitingShot', true],
  ]) {
    source[key] = value;
    await $('settings-install-update').onclick();
    assert.deepEqual(prompts, [], key);
    assert.deepEqual(calls, [], key);
    assert.equal(messages.at(-1), 'Wait for pending tethered captures to finish before installing an update.', key);
    source[key] = 0;
  }
  await $('update-banner-install').onclick();
  assert.deepEqual(prompts, ['Stop the active tethered session and restart PhotoCull to install update 0.9.4?']);
  assert.deepEqual(calls, []);
  confirmation.accept = true;
  let reads = 0;
  api.tetherState = async () => ++reads === 1 ? ledger : { ...ledger, queue: { pendingPairs: 1 } };
  await $('settings-install-update').onclick();
  assert.equal(messages.at(-1), 'Wait for pending tethered captures to finish before installing an update.');
  assert.deepEqual(calls, []);
  api.tetherState = async () => ledger;
  await $('settings-install-update').onclick();
  assert.deepEqual(calls, ['stop']);
  assert.equal(workspace.busy, false);
  for (const pending of [1, [{ exposureId: 'capture' }]]) {
    tether.shoot = shoot;
    api.tetherControl = async () => ({ pending });
    await $('settings-install-update').onclick();
    assert.deepEqual(calls, ['stop']);
    assert.match(messages.at(-1), /unrecovered captures/i);
    assert.equal(workspace.busy, false);
  }
  tether.shoot = shoot;
  const stopped = Promise.withResolvers();
  const stopping = Promise.withResolvers();
  api.tetherControl = async () => { calls.push('stop'); stopping.resolve(); await stopped.promise; return { pending: [] }; };
  const installing = $('update-banner-install').onclick();
  await $('settings-install-update').onclick();
  await stopping.promise;
  assert.deepEqual(calls, ['stop', 'stop']);
  assert.equal(workspace.busy, true);
  stopped.resolve();
  await installing;
  assert.deepEqual(calls, ['stop', 'stop', '0.9.4']);
  assert.equal(workspace.busy, false);
});

'use strict';
const $ = s => document.querySelector(s);
const STORE = 'buds-air7pro-map-v1';
const COMMANDS = [
  { id: 'anc_on', group: 'Anc', label: 'ANC' },
  { id: 'transparency', group: 'Anc', label: 'Transparency' },
  { id: 'anc_off', group: 'Anc', label: 'Off' },
  { id: 'eq_balanced', group: 'Sound', label: 'Balanced', set: 'eq' },
  { id: 'eq_bass', group: 'Sound', label: 'Bass boost', set: 'eq' },
  { id: 'eq_bright', group: 'Sound', label: 'Bright', set: 'eq' },
  { id: 'game_on', group: 'Sound', label: 'Game mode', set: 'game' },
  { id: 'game_off', group: 'Sound', label: 'Game off', set: 'game' },
  { id: 'find', group: 'Sound', label: 'Find buds' },
];
const STD = { battery: 0x180f, battLevel: 0x2a19, devInfo: 0x180a, model: 0x2a24, fw: 0x2a26 };
const SPP = '00001101-0000-1000-8000-00805f9b34fb';

let device, server, writeCh, notifyCh, port, reader, writer, capture;
let map = load();

/* ---------- storage ---------- */
function blank() { return { cmds: {}, writeChar: '', notifyChar: '', transport: 'ble', extra: '' }; }
function load() { try { return Object.assign(blank(), JSON.parse(localStorage.getItem(STORE)) || {}); } catch (e) { return blank(); } }
function persist() { try { localStorage.setItem(STORE, JSON.stringify(map)); } catch (e) {} }

/* ---------- helpers ---------- */
function log(msg, cls = '') {
  const el = $('#log'), line = document.createElement('div');
  line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString([], { hour12: false })}  ${msg}`;
  el.appendChild(line); el.scrollTop = el.scrollHeight;
}
const toHex = v => Array.from(new Uint8Array(v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v), b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
function fromHex(s) {
  const clean = s.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (!clean || clean.length % 2) throw new Error('Hex needs an even number of digits');
  return new Uint8Array(clean.match(/../g).map(h => parseInt(h, 16)));
}
function normUuid(u) {
  u = (u || '').trim().toLowerCase(); if (!u) return null;
  if (/^(0x)?[0-9a-f]{1,4}$/.test(u)) return parseInt(u.replace('0x', ''), 16);
  return u;
}
const short = u => (u.length > 8 ? u.slice(4, 8) : u);
function setState(text, kind) { $('#stateText').textContent = text; $('#dot').className = 'dot ' + (kind || ''); }
function btn(text, fn, cls = 'small') {
  const b = document.createElement('button'); b.className = cls; b.textContent = text;
  b.onclick = async () => { try { await fn(); } catch (e) { log(e.message, 'er'); } };
  return b;
}

/* ---------- platform ---------- */
(function platform() {
  const ua = navigator.userAgent, note = $('#platformNote');
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const hasBle = 'bluetooth' in navigator;
  if (!window.isSecureContext) {
    note.textContent = 'Bluetooth needs HTTPS. Open this page from its https:// address.';
  } else if (ios && !hasBle) {
    note.textContent = 'On iPhone, open this page in the Bluefy app (free on the App Store). Safari and Chrome on iPhone can’t use Bluetooth. You can still load a capture file here.';
  } else if (!hasBle) {
    note.textContent = 'This browser has no Web Bluetooth. Use Chrome or Edge on Windows, macOS or Android, or Bluefy on iPhone.';
  }
  note.hidden = !note.textContent;
  if (!hasBle) $('#btnConnect').disabled = true;
  if (!('serial' in navigator)) { $('#btnSpp').disabled = true; if (ios) $('#btnSpp').textContent = 'Not available on iPhone'; }
})();

/* ---------- UI build ---------- */
function buildPads() {
  for (const g of ['Anc', 'Sound']) {
    const wrap = $('#pads' + g); wrap.innerHTML = '';
    COMMANDS.filter(c => c.group === g).forEach(c => {
      const b = document.createElement('button'); b.id = 'pad_' + c.id;
      const mapped = !!(map.cmds[c.id] || '').trim();
      b.innerHTML = `<span>${c.label}</span><small>${mapped ? 'mapped' : 'not mapped'}</small>`;
      b.onclick = () => sendCommand(c);
      wrap.appendChild(b);
    });
  }
}
function buildMap() {
  $('#writeChar').value = map.writeChar; $('#notifyChar').value = map.notifyChar;
  $('#transport').value = map.transport; $('#extraSvcs').value = map.extra;
  const rows = $('#mapRows'); rows.innerHTML = '';
  COMMANDS.forEach(c => {
    const l = document.createElement('label'); l.textContent = c.label + ' (hex)';
    const i = document.createElement('input'); i.className = 'mono'; i.id = 'map_' + c.id;
    i.value = map.cmds[c.id] || ''; i.placeholder = 'captured bytes';
    l.appendChild(i); rows.appendChild(l);
  });
}
function readMapForm() {
  map.writeChar = $('#writeChar').value.trim(); map.notifyChar = $('#notifyChar').value.trim();
  map.transport = $('#transport').value; map.extra = $('#extraSvcs').value.trim();
  COMMANDS.forEach(c => (map.cmds[c.id] = $('#map_' + c.id).value.trim()));
}
function refreshAll() { buildMap(); buildPads(); if (capture) renderCapture(); }

document.querySelectorAll('[role=tab]').forEach(t => (t.onclick = () => {
  document.querySelectorAll('[role=tab]').forEach(x => x.setAttribute('aria-selected', x === t));
  document.querySelectorAll('[data-panel]').forEach(p => (p.hidden = p.dataset.panel !== t.dataset.tab));
}));

$('#btnSaveMap').onclick = async () => { readMapForm(); persist(); buildPads(); log('Command map saved'); if (server?.connected) await bindChars(); };
$('#btnExport').onclick = async () => {
  readMapForm(); const txt = JSON.stringify(map, null, 1);
  try { await navigator.clipboard.writeText(txt); log('Map JSON copied'); }
  catch (e) { const box = $('#importBox'); box.hidden = false; box.value = txt; box.select(); log('Clipboard blocked. The JSON is in the box; copy it from there.'); }
};
$('#btnImport').onclick = () => {
  const box = $('#importBox');
  if (box.hidden || !box.value.trim()) { box.hidden = false; box.value = ''; box.focus(); return; }
  try { map = Object.assign(blank(), JSON.parse(box.value)); persist(); refreshAll(); box.hidden = true; log('Map imported'); }
  catch (e) { log('Import failed: ' + e.message, 'er'); }
};
$('#btnClear').onclick = () => ($('#log').innerHTML = '');

/* ---------- capture import ---------- */
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => e.dataTransfer.files[0] && loadCapture(e.dataTransfer.files[0]));
$('#capFile').onchange = e => e.target.files[0] && loadCapture(e.target.files[0]);
$('#capRepeatOnly').onchange = () => renderCapture();

async function loadCapture(file) {
  try {
    capture = BudsCapture.parse(await file.arrayBuffer());
    log(`Loaded ${file.name}: ${capture.commands.length} distinct commands`, 'rx');
    if (!capture.events.length) log('No BLE writes or SPP data found. Make sure the capture ran while you used realme Link.', 'er');
    renderCapture();
  } catch (e) { log('Could not read that file: ' + e.message, 'er'); }
}

function renderCapture() {
  $('#capResult').hidden = false;
  $('#capFormat').textContent = capture.format === 'pklg' ? 'PacketLogger' : 'btsnoop';
  $('#capPackets').textContent = capture.packets;
  $('#capCmds').textContent = capture.commands.length;
  const list = $('#capList'); list.innerHTML = '';
  const only = $('#capRepeatOnly').checked;
  const cmds = capture.commands.filter(c => !only || c.times.length > 1);
  if (!cmds.length) { list.innerHTML = '<p class="muted">Nothing to show with this filter.</p>'; return; }
  for (const c of cmds) {
    const el = document.createElement('div'); el.className = 'cmd';
    const where = c.kind === 'ble' ? (c.uuid ? 'char ' + short(c.uuid) : 'handle 0x' + c.handle.toString(16).padStart(4, '0')) : 'SPP channel ' + c.channel;
    const assigned = COMMANDS.find(x => map.cmds[x.id] && map.cmds[x.id].replace(/\s/g, '').toUpperCase() === c.hex.replace(/\s/g, ''));
    el.innerHTML = `<div class="meta"><span class="chip">${c.kind === 'ble' ? 'BLE' : 'SPP'}</span><span>${where}</span>
      <span class="chip ${c.times.length > 1 ? 'rep' : ''}">×${c.times.length}</span>
      <span>at ${c.times.map(t => t.toFixed(1) + 's').join(', ')}</span></div>
      <div class="hexv">${c.hex}</div>`;
    const row = document.createElement('div'); row.className = 'row';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">Assign to button…</option>' + COMMANDS.map(x => `<option value="${x.id}">${x.label}</option>`).join('');
    if (assigned) sel.value = assigned.id;
    sel.onchange = () => assign(c, sel.value);
    row.append(sel, btn('Send now', () => sendRaw(c.hex, c.kind === 'ble' ? 'ble' : 'spp', 'capture')));
    el.append(row); list.append(el);
  }
}

function assign(c, id) {
  if (!id) return;
  readMapForm();
  map.cmds[id] = c.hex;
  map.transport = c.kind === 'ble' ? 'ble' : 'spp';
  if (c.kind === 'ble') {
    if (c.uuid) map.writeChar = c.uuid;
    else log(`This capture didn't include service discovery, so pick the write characteristic for handle 0x${c.handle.toString(16)} in GATT explorer.`);
    if (c.service) {
      const list = map.extra.split(',').map(s => s.trim()).filter(Boolean);
      if (!list.includes(c.service)) { list.push(c.service); map.extra = list.join(', '); log('Added service ' + short(c.service) + ' to the connect list. Reconnect to use it.'); }
    }
  }
  persist(); refreshAll();
  log(`Mapped ${COMMANDS.find(x => x.id === id).label} → ${c.hex}`, 'tx');
  if (server?.connected) bindChars();
}

/* ---------- BLE ---------- */
$('#btnConnect').onclick = async () => {
  readMapForm(); persist();
  const extra = map.extra.split(',').map(normUuid).filter(Boolean);
  try {
    setState('Choosing device…');
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [STD.battery, STD.devInfo, 0xfe2c, ...extra] });
    device.addEventListener('gattserverdisconnected', onDisconnected);
    setState('Connecting to ' + (device.name || 'device') + '…');
    server = await device.gatt.connect();
    setState('Connected', 'ok');
    $('#devInfo').textContent = device.name || 'Unnamed device';
    $('#btnDisconnect').disabled = false;
    log('Connected to ' + (device.name || device.id), 'rx');
    await readStandard(); await explore(); await bindChars();
  } catch (e) {
    const cancelled = e.name === 'NotFoundError';
    setState(cancelled ? 'Not connected' : 'Connection failed', cancelled ? '' : 'err');
    if (!cancelled) log(e.message, 'er');
  }
};
$('#btnDisconnect').onclick = () => device?.gatt?.connected && device.gatt.disconnect();
function onDisconnected() { setState('Disconnected'); $('#btnDisconnect').disabled = true; writeCh = notifyCh = null; log('Disconnected', 'er'); }

async function readStandard() {
  try {
    const c = await (await server.getPrimaryService(STD.battery)).getCharacteristic(STD.battLevel);
    const show = v => ($('#battMain').textContent = v.getUint8(0) + '%');
    show(await c.readValue());
    try { await c.startNotifications(); c.addEventListener('characteristicvaluechanged', e => show(e.target.value)); } catch (e) {}
  } catch (e) { log('The buds don’t share battery over the standard service'); }
  try {
    const s = await server.getPrimaryService(STD.devInfo), dec = new TextDecoder();
    for (const [key, id] of [['model', STD.model], ['fw', STD.fw]]) {
      try { $('#' + key).textContent = dec.decode(await (await s.getCharacteristic(id)).readValue()).trim() || '—'; } catch (e) {}
    }
  } catch (e) { log('No device-information service'); }
}

async function explore() {
  const tree = $('#tree'); tree.innerHTML = '';
  let services = [];
  try { services = await server.getPrimaryServices(); }
  catch (e) { tree.innerHTML = '<p class="muted">No accessible services. Add vendor service UUIDs above and reconnect.</p>'; return; }
  for (const s of services) {
    const box = document.createElement('div'); box.className = 'svc';
    box.innerHTML = `<span class="eyebrow">Service</span><span class="uuid">${s.uuid}</span>`;
    let chars = []; try { chars = await s.getCharacteristics(); } catch (e) {}
    for (const c of chars) {
      const p = c.properties;
      const ids = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter(k => p[k]);
      const el = document.createElement('div'); el.className = 'chr';
      el.innerHTML = `<span class="uuid">${c.uuid}</span><span class="muted" style="font-size:.8rem">${ids.join(' · ')}</span>`;
      const row = document.createElement('div'); row.className = 'row';
      if (p.read) row.append(btn('Read', async () => log(`R ${short(c.uuid)}  ${toHex(await c.readValue())}`, 'rx')));
      if (p.notify || p.indicate) {
        row.append(btn('Listen', async () => { await c.startNotifications(); c.addEventListener('characteristicvaluechanged', e => log(`N ${short(c.uuid)}  ${toHex(e.target.value)}`, 'rx')); log('Listening on ' + short(c.uuid)); }));
        row.append(btn('Use for responses', () => { map.notifyChar = c.uuid; persist(); buildMap(); bindChars(); }));
      }
      if (p.write || p.writeWithoutResponse) {
        row.append(btn('Use for commands', () => { map.writeChar = c.uuid; persist(); buildMap(); bindChars(); log('Write characteristic set to ' + short(c.uuid)); }));
        const inp = document.createElement('input'); inp.className = 'mono'; inp.placeholder = 'hex to write'; inp.style.flex = '1 1 160px';
        row.append(inp, btn('Write', async () => { const d = fromHex(inp.value); p.write ? await c.writeValueWithResponse(d) : await c.writeValueWithoutResponse(d); log(`W ${short(c.uuid)}  ${toHex(d)}`, 'tx'); }));
      }
      el.append(row); box.append(el);
    }
    tree.append(box);
  }
}

async function findChar(uuid) {
  uuid = normUuid(uuid); if (!uuid || !server?.connected) return null;
  for (const s of await server.getPrimaryServices()) { try { return await s.getCharacteristic(uuid); } catch (e) {} }
  return null;
}
async function bindChars() {
  writeCh = await findChar(map.writeChar);
  const n = await findChar(map.notifyChar);
  if (n && n !== notifyCh) {
    notifyCh = n;
    try { await n.startNotifications(); n.addEventListener('characteristicvaluechanged', e => log('← ' + toHex(e.target.value), 'rx')); }
    catch (e) { log('Could not listen: ' + e.message, 'er'); }
  }
  if (map.writeChar && !writeCh) log('Write characteristic not found. Reconnect so its service is requested, or pick one in GATT explorer.', 'er');
}

/* ---------- send ---------- */
async function sendRaw(hex, transport, label) {
  const data = fromHex(hex);
  if (transport === 'spp') {
    if (!writer) throw new Error('Open the SPP port first (desktop Chrome or Edge)');
    await writer.write(data);
  } else {
    if (!writeCh) throw new Error('Connect the buds and set a write characteristic first');
    writeCh.properties.write ? await writeCh.writeValueWithResponse(data) : await writeCh.writeValueWithoutResponse(data);
  }
  log(`→ ${label}  ${toHex(data)}`, 'tx');
}
async function sendCommand(c) {
  const hex = (map.cmds[c.id] || '').trim();
  if (!hex) { log(`${c.label} isn't mapped yet. Load a capture in Import capture.`, 'er'); return; }
  try {
    await sendRaw(hex, map.transport, c.label);
    const peers = COMMANDS.filter(x => x.group === c.group && (c.group === 'Anc' || (x.set && x.set === c.set)));
    if (c.id !== 'find') peers.forEach(x => $('#pad_' + x.id).classList.toggle('on', x.id === c.id));
  } catch (e) { log(c.label + ' failed: ' + e.message, 'er'); }
}

/* ---------- SPP via Web Serial ---------- */
$('#btnSpp').onclick = async () => {
  try {
    port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP], filters: [{ bluetoothServiceClassId: SPP }] });
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    $('#btnSppSend').disabled = false; $('#btnSppClose').disabled = false;
    log('SPP port open', 'rx'); readLoop();
  } catch (e) { if (e.name !== 'NotFoundError') log('SPP: ' + e.message + '. Pair the buds in system Bluetooth settings first.', 'er'); }
};
async function readLoop() {
  reader = port.readable.getReader();
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; log('← ' + toHex(value), 'rx'); } }
  catch (e) { log('SPP read stopped: ' + e.message, 'er'); }
  finally { reader.releaseLock(); }
}
$('#btnSppSend').onclick = async () => { try { await sendRaw($('#sppHex').value, 'spp', 'SPP'); } catch (e) { log(e.message, 'er'); } };
$('#btnSppClose').onclick = async () => {
  try { await reader?.cancel(); writer?.releaseLock(); await port?.close(); } catch (e) {}
  writer = null; $('#btnSppSend').disabled = true; $('#btnSppClose').disabled = true; log('SPP port closed');
};

buildMap(); buildPads();
log('Ready. Connect the buds, or load a capture to map the buttons.');

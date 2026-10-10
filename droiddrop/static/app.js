const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const HOME = '/sdcard';
const PLACES = [
  ['🏠', 'Internal storage', '/sdcard'], ['⬇', 'Download', '/sdcard/Download'], ['📷', 'Camera', '/sdcard/DCIM/Camera'],
  ['🖼', 'Pictures', '/sdcard/Pictures'], ['📄', 'Documents', '/sdcard/Documents'], ['🎵', 'Music', '/sdcard/Music'],
  ['🎬', 'Movies', '/sdcard/Movies'], ['💬', 'WhatsApp', '/sdcard/Android/media/com.whatsapp/WhatsApp/Media'],
];

const state = {
  adb: true, devices: [], serial: null, path: HOME, entries: [], selected: new Set(),
  sort: { key: 'name', dir: 1 }, filter: '', loading: false,
};

// ---------- helpers ----------
async function api(url, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ error: 'Unexpected server response' }));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const qs = (o) => new URLSearchParams(o).toString();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const join = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const parent = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
}
function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t * 1000), now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
    + (sameYear ? ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
}
function fileIcon(e) {
  if (e.dir) return '📁';
  const ext = e.name.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg'].includes(ext)) return '🖼';
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', '3gp'].includes(ext)) return '🎬';
  if (['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'].includes(ext)) return '🎵';
  if (['pdf'].includes(ext)) return '📕';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜';
  if (['apk', 'apks', 'xapk'].includes(ext)) return '📦';
  if (['doc', 'docx', 'txt', 'md', 'rtf', 'odt'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  return '📄';
}
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', err ? 4500 : 2500);
}
function setMsg(el, text, ok) { el.textContent = text; el.className = 'msg ' + (ok === undefined ? '' : ok ? 'ok' : 'err'); }
async function withBusy(btn, fn) {
  const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + btn.textContent;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
}
const current = () => state.devices.find((d) => d.serial === state.serial);

// ---------- devices ----------
async function refreshDevices() {
  try {
    const data = await api('/api/status');
    state.adb = data.adb;
    const before = JSON.stringify(state.devices);
    state.devices = data.devices;
    $('#pollDot').style.color = 'var(--accent)';
    if (before !== JSON.stringify(state.devices)) onDevicesChanged();
  } catch {
    $('#pollDot').style.color = 'var(--danger)';
  }
  $('#noAdb').classList.toggle('hidden', state.adb);
}

function onDevicesChanged() {
  const cur = current();
  if (state.serial && (!cur || cur.state !== 'device')) {
    if (!cur) toast('Phone disconnected', true);
    state.serial = null;
  }
  if (!state.serial) {
    const ready = state.devices.find((d) => d.state === 'device');
    if (ready) selectDevice(ready.serial);
  }
  renderDevices(); renderUsbList(); renderView();
}

function renderDevices() {
  const el = $('#devices');
  if (!state.devices.length) {
    el.innerHTML = `<div class="empty-devices">No phones found yet.<br>Plug one in with USB, or connect via Wi-Fi.</div>`;
    return;
  }
  el.innerHTML = state.devices.map((d) => {
    const ready = d.state === 'device';
    const status = d.state === 'unauthorized' ? '<span class="badge warn">Tap "Allow" on phone</span>'
      : d.state === 'offline' ? '<span class="badge warn">Offline</span>' : '';
    const actions = [
      ready && d.transport === 'usb' ? `<button class="small" data-act="tcpip" data-serial="${esc(d.serial)}">📶 Switch to Wi-Fi</button>` : '',
      d.transport === 'wifi' ? `<button class="small" data-act="disconnect" data-serial="${esc(d.serial)}">Disconnect</button>` : '',
    ].join('');
    return `<div class="device ${d.serial === state.serial ? 'active' : ''}" data-serial="${esc(d.serial)}">
      <div class="ico">${d.transport === 'wifi' ? '📶' : '🔌'}</div>
      <div style="min-width:0">
        <div class="name">${esc(d.model || 'Android device')}<span class="badge ${d.transport}">${d.transport === 'wifi' ? 'Wi-Fi' : 'USB'}</span></div>
        <div class="sub">${esc(d.serial)}</div>
        ${status ? `<div style="margin-top:4px">${status}</div>` : ''}
        ${actions ? `<div class="actions">${actions}</div>` : ''}
      </div></div>`;
  }).join('');
}

$('#devices').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    e.stopPropagation();
    const serial = btn.dataset.serial;
    if (btn.dataset.act === 'disconnect') {
      await api('/api/disconnect', { serial }).catch((err) => toast(err.message, true));
      if (state.serial === serial) state.serial = null;
      refreshDevices();
    } else if (btn.dataset.act === 'tcpip') {
      await switchToWifi(serial, btn);
    }
    return;
  }
  const dev = e.target.closest('.device');
  if (!dev) return;
  const d = state.devices.find((x) => x.serial === dev.dataset.serial);
  if (d?.state === 'device') selectDevice(d.serial);
  else if (d?.state === 'unauthorized') toast('Unlock your phone and tap "Allow" on the USB debugging popup', true);
});

async function switchToWifi(serial, btn) {
  await withBusy(btn, async () => {
    try {
      const r = await api('/api/tcpip', { serial });
      toast('Connected over Wi-Fi — you can unplug the cable now');
      setMsg($('#usbMsg'), `Connected to ${r.serial}. You can unplug the cable.`, true);
      state.serial = r.serial;
      await refreshDevices();
      selectDevice(r.serial);
    } catch (err) {
      toast(err.message, true); setMsg($('#usbMsg'), err.message, false);
    }
  });
}

async function selectDevice(serial) {
  const changed = state.serial !== serial;
  state.serial = serial;
  renderDevices(); renderView();
  if (changed) { state.path = HOME; loadInfo(); }
  loadDir(state.path);
}

async function loadInfo() {
  const serial = state.serial;
  const d = current();
  $('#devTitle').textContent = d?.model || 'Android device';
  $('#devMeta').textContent = (d?.transport === 'wifi' ? 'Wi-Fi' : 'USB') + ' · ' + serial;
  $('#storage').innerHTML = '';
  try {
    const info = await api('/api/info?' + qs({ serial }));
    if (serial !== state.serial) return;
    $('#devTitle').textContent = [info.manufacturer && info.manufacturer[0].toUpperCase() + info.manufacturer.slice(1), info.model].filter(Boolean).join(' ') || d?.model;
    $('#devMeta').textContent = `Android ${info.android} · ` + $('#devMeta').textContent;
    if (info.total) {
      const used = info.total - info.free;
      $('#storage').innerHTML = `${fmtSize(info.free)} free of ${fmtSize(info.total)}<div class="bar"><div style="width:${(used / info.total * 100).toFixed(1)}%"></div></div>`;
    }
  } catch { /* info is optional */ }
}

function renderView() {
  const connected = !!state.serial;
  $('#welcome').classList.toggle('hidden', connected);
  $('#browser').classList.toggle('hidden', !connected);
}

// ---------- file browser ----------
async function loadDir(path) {
  const serial = state.serial;
  if (!serial) return;
  state.loading = true;
  $('#files').innerHTML = `<tr><td colspan="5" class="placeholder"><span class="spin"></span> Loading…</td></tr>`;
  try {
    const data = await api('/api/ls?' + qs({ serial, path }));
    if (serial !== state.serial) return;
    state.path = path; state.entries = data.entries; state.selected.clear();
  } catch (err) {
    toast(err.message, true);
    if (path !== HOME && state.path === path) return loadDir(HOME);
  } finally {
    state.loading = false;
  }
  renderCrumbs(); renderFiles();
}

function renderCrumbs() {
  const parts = state.path.split('/').filter(Boolean);
  let acc = '';
  const crumbs = [`<button data-path="/">/</button>`];
  parts.forEach((p, i) => {
    acc += '/' + p;
    const label = acc === HOME ? 'Internal storage' : p;
    crumbs.push((i ? '<span class="sep">›</span>' : '') + `<button data-path="${esc(acc)}">${esc(label)}</button>`);
  });
  $('#crumbs').innerHTML = crumbs.join('');
  $('#upBtn').disabled = state.path === '/';
  $$('#places button').forEach((b) => b.classList.toggle('primary', b.dataset.path === state.path));
}

function visibleEntries() {
  const f = state.filter.toLowerCase();
  const { key, dir } = state.sort;
  return state.entries
    .filter((e) => !f || e.name.toLowerCase().includes(f))
    .sort((a, b) => (b.dir - a.dir) || (key === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a[key] - b[key]) * dir);
}

// ---------- file kinds, thumbnails ----------
const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'heic', 'heif'],
  video: ['mp4', 'webm', 'mkv', 'mov', '3gp', 'avi'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'log', 'json', 'csv', 'xml', 'html', 'htm', 'js', 'css', 'py', 'java', 'kt', 'sh', 'yml', 'yaml', 'ini', 'conf', 'srt', 'vtt'],
};
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
function kindOf(e) {
  if (e.dir) return 'dir';
  const x = extOf(e.name);
  return Object.keys(KINDS).find((k) => KINDS[k].includes(x)) || 'other';
}
const canPreview = (e) => kindOf(e) !== 'dir' && kindOf(e) !== 'other';
const needsConversion = (e) => ['heic', 'heif'].includes(extOf(e.name));  // browsers (except Safari) can't show HEIC
const hasThumb = (e) => (kindOf(e) === 'image' && extOf(e.name) !== 'svg') || kindOf(e) === 'video';
// Thumbnails load from the "other" loopback name so they get their own browser connection pool
// and a grid full of thumbnails never blocks clicks, folder loads or previews.
const THUMB_ORIGIN = `http://${location.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}:${location.port}`;
const thumbUrl = (path, e, px = 360) => THUMB_ORIGIN + '/api/thumb?' + qs({ serial: state.serial, path, v: `${e.mtime}-${e.size}`, px });
const rawUrl = (path) => '/api/raw?' + qs({ serial: state.serial, path });

let view = 'list';
try { view = localStorage.getItem('droiddrop-view') || 'list'; } catch {}
function setView(v) {
  view = v;
  try { localStorage.setItem('droiddrop-view', v); } catch {}
  $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('.files-wrap table').classList.toggle('hidden', v !== 'list');
  $('#grid').classList.toggle('hidden', v !== 'grid');
  renderFiles();
}
$$('.seg button').forEach((b) => b.onclick = () => setView(b.dataset.view));

function renderGrid(rows) {
  const grid = $('#grid');
  grid.classList.toggle('selecting', state.selected.size > 0);
  if (!rows.length) {
    grid.innerHTML = `<div class="placeholder">${state.filter ? 'No matching files' : 'This folder is empty.<br>Drag files or folders here, or click Upload.'}</div>`;
    return;
  }
  grid.innerHTML = rows.map((e) => {
    const p = join(state.path, e.name);
    const sel = state.selected.has(e.name);
    const k = kindOf(e);
    const thumb = hasThumb(e) ? `<img loading="lazy" decoding="async" alt="" src="${esc(thumbUrl(p, e))}">`
      : k === 'image' ? `<img loading="lazy" alt="" src="${esc(rawUrl(p))}">`
      : `<span class="big-ico">${fileIcon(e)}</span>`;
    return `<div class="tile ${sel ? 'selected' : ''}" data-name="${esc(e.name)}" title="${esc(e.name)}">
      <input type="checkbox" class="tcheck" ${sel ? 'checked' : ''}>
      <div class="tactions">
        <button class="small" data-act="download" title="${e.dir ? 'Download as zip' : 'Download'}">⬇</button>
        <button class="small" data-act="rename" title="Rename">✎</button>
        <button class="small danger" data-act="delete" title="Delete">🗑</button>
      </div>
      <div class="thumb">${thumb}${k === 'video' ? '<span class="play">▶</span>' : ''}</div>
      <div class="tname">${esc(e.name)}</div>
      <div class="tmeta">${e.dir ? 'Folder' : fmtSize(e.size)} · ${fmtDate(e.mtime)}</div>
    </div>`;
  }).join('');
}
// A failed thumbnail falls back to the file-type icon.
$('#grid').addEventListener('error', (e) => {
  if (e.target.tagName !== 'IMG') return;
  const tile = e.target.closest('.tile');
  const entry = tile && state.entries.find((x) => x.name === tile.dataset.name);
  const span = document.createElement('span');
  span.className = 'big-ico'; span.textContent = entry ? fileIcon(entry) : '📄';
  e.target.replaceWith(span);
}, true);

function renderFiles() {
  const rows = visibleEntries();
  if (view === 'grid') { renderGrid(rows); renderBulk(); return; }
  const tbody = $('#files');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="placeholder">${state.filter ? 'No matching files' : 'This folder is empty.<br>Drag files or folders here, or click Upload.'}</td></tr>`;
  } else {
    tbody.innerHTML = rows.map((e) => {
      const p = join(state.path, e.name);
      const sel = state.selected.has(e.name);
      return `<tr class="${e.dir ? 'dir' : ''} ${sel ? 'selected' : ''}" data-name="${esc(e.name)}">
        <td class="check"><input type="checkbox" ${sel ? 'checked' : ''}></td>
        <td class="name"><span class="fi">${fileIcon(e)}</span><a ${e.dir ? '' : `href="${downloadUrl(p)}"`} class="${canPreview(e) ? 'preview' : ''}" data-open title="${esc(e.name)}">${esc(e.name)}</a></td>
        <td class="size">${e.dir ? '—' : fmtSize(e.size)}</td>
        <td class="date">${fmtDate(e.mtime)}</td>
        <td class="row-actions">
          <button class="small ghost" data-act="download" title="${e.dir ? 'Download as zip' : 'Download'}">⬇</button>
          <button class="small ghost" data-act="rename" title="Rename">✎</button>
          <button class="small ghost danger" data-act="delete" title="Delete">🗑</button>
        </td></tr>`;
    }).join('');
  }
  renderBulk();
}

function renderBulk() {
  const n = state.selected.size;
  $('#bulk').classList.toggle('show', n > 0);
  $('#bulkCount').textContent = `${n} selected`;
  const vis = visibleEntries();
  $('#checkAll').checked = vis.length > 0 && vis.every((e) => state.selected.has(e.name));
}

const downloadUrl = (path) => '/api/download?' + qs({ serial: state.serial, path });
function download(path) {
  const a = document.createElement('a');
  a.href = downloadUrl(path); a.download = ''; document.body.appendChild(a); a.click(); a.remove();
}
// Folders (or several items) come down as one zip, built on the fly by the server.
function downloadZip(names) {
  const a = document.createElement('a');
  a.href = '/api/download-zip?' + qs({ serial: state.serial, path: state.path, names: JSON.stringify(names) });
  a.download = ''; document.body.appendChild(a); a.click(); a.remove();
  toast(`Downloading ${names.length === 1 ? `"${names[0]}"` : names.length + ' items'} as a zip (total size shows once it finishes)`);
}

function onItemClick(e) {
  const item = e.target.closest('[data-name]');
  if (!item || !item.isConnected) return;
  const name = item.dataset.name;
  const entry = state.entries.find((x) => x.name === name);
  const path = join(state.path, name);
  if (e.target.matches('input[type=checkbox]')) {
    e.target.checked ? state.selected.add(name) : state.selected.delete(name);
    item.classList.toggle('selected', e.target.checked);
    $('#grid').classList.toggle('selecting', state.selected.size > 0);
    return renderBulk();
  }
  const act = e.target.closest('button[data-act]')?.dataset.act;
  if (act === 'download') return entry?.dir ? downloadZip([name]) : download(path);
  if (act === 'rename') return renameEntry(path, name);
  if (act === 'delete') return deleteEntries([name]);
  if (!entry) return;
  // List view opens only from the name link; grid view opens from anywhere on the tile.
  const isTile = item.classList.contains('tile');
  if (!isTile && !e.target.closest('[data-open]')) return;
  // While picking items in grid view, clicking a tile toggles it instead of opening it.
  if (isTile && state.selected.size > 0) {
    const box = $('.tcheck', item); box.checked = !box.checked;
    return onItemClick({ target: box });
  }
  e.preventDefault?.();
  if (entry.dir) loadDir(path);
  else if (canPreview(entry)) openPreview(name);
  else download(path);
}
$('#files').addEventListener('click', onItemClick);
$('#grid').addEventListener('click', onItemClick);
$('#files').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr[data-name]');
  const entry = tr && state.entries.find((x) => x.name === tr.dataset.name);
  if (entry?.dir && tr.isConnected && !e.target.closest('button,input,[data-open]')) loadDir(join(state.path, entry.name));
});
$('#bulkAll').onclick = () => { visibleEntries().forEach((x) => state.selected.add(x.name)); renderFiles(); };

// ---------- preview viewer ----------
const viewer = { list: [], index: 0 };
function openPreview(name) {
  viewer.list = visibleEntries().filter(canPreview);
  viewer.index = Math.max(0, viewer.list.findIndex((e) => e.name === name));
  $('#viewer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  showPreview();
}
function closePreview() {
  $('#viewer').classList.add('hidden');
  $('#vStage').innerHTML = '';  // stops any playing video/audio
  document.body.style.overflow = '';
}
function stepPreview(d) {
  if (viewer.list.length < 2) return;
  viewer.index = (viewer.index + d + viewer.list.length) % viewer.list.length;
  showPreview();
}
async function showPreview() {
  const e = viewer.list[viewer.index];
  if (!e) return closePreview();
  const path = join(state.path, e.name);
  const stage = $('#vStage');
  stage.classList.remove('zoomed');
  $('#vName').textContent = e.name;
  $('#vMeta').textContent = `${fmtSize(e.size)} · ${fmtDate(e.mtime)}`;
  $('#vCount').textContent = viewer.list.length > 1 ? `${viewer.index + 1} of ${viewer.list.length}  ·  ← → to browse, Esc to close` : 'Esc to close';
  $('#vPrev').classList.toggle('hidden', viewer.list.length < 2);
  $('#vNext').classList.toggle('hidden', viewer.list.length < 2);
  $('#vDownload').onclick = () => download(path);
  const fullUrl = needsConversion(e) ? thumbUrl(path, e, 2048) : rawUrl(path);
  $('#vOpen').onclick = () => window.open(fullUrl, '_blank');

  const k = kindOf(e);
  if (k === 'image') {
    // Show the (usually cached) thumbnail instantly, then swap in the full image when it arrives.
    const img = document.createElement('img');
    img.className = 'full';
    img.src = hasThumb(e) ? thumbUrl(path, e) : fullUrl;
    stage.replaceChildren(img, Object.assign(document.createElement('span'), { className: 'spin' }));
    const full = new Image();
    full.onload = () => { if (img.isConnected) { img.src = full.src; stage.querySelector('.spin')?.remove(); } };
    full.onerror = () => { if (img.isConnected) { stage.querySelector('.spin')?.remove(); toast('Could not load the full image', true); } };
    full.src = fullUrl;
    img.onclick = () => stage.classList.toggle('zoomed');
    preloadNeighbour();
  } else if (k === 'video' || k === 'audio') {
    const media = document.createElement(k);
    media.controls = true; media.autoplay = true; media.src = fullUrl;
    if (k === 'video' && hasThumb(e)) media.poster = thumbUrl(path, e);
    media.onerror = () => {
      stage.innerHTML = `<div class="v-other"><div>${fileIcon(e)}</div><p>Your browser can't play this format.<br>Download it to open it in another app.</p></div>`;
    };
    stage.replaceChildren(media);
  } else if (k === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = fullUrl;
    stage.replaceChildren(frame);
  } else if (k === 'text') {
    stage.innerHTML = '<span class="spin"></span>';
    const LIMIT = 512 * 1024;
    try {
      const res = await fetch(fullUrl, { headers: { Range: `bytes=0-${LIMIT - 1}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load file');
      const text = await res.text();
      if (viewer.list[viewer.index] !== e) return;
      const pre = document.createElement('pre');
      pre.textContent = text + (e.size > LIMIT ? `\n\n… showing the first ${fmtSize(LIMIT)} of ${fmtSize(e.size)}. Download to see the rest.` : '');
      stage.replaceChildren(pre);
    } catch (err) {
      stage.innerHTML = `<div class="v-other"><div>📄</div><p>${esc(err.message)}</p></div>`;
    }
  }
}
function preloadNeighbour() {
  const next = viewer.list[(viewer.index + 1) % viewer.list.length];
  if (next && kindOf(next) === 'image' && next !== viewer.list[viewer.index]) {
    const p = join(state.path, next.name);
    new Image().src = needsConversion(next) ? thumbUrl(p, next, 2048) : rawUrl(p);
  }
}
$('#vClose').onclick = closePreview;
$('#vPrev').onclick = () => stepPreview(-1);
$('#vNext').onclick = () => stepPreview(1);
$('#vStage').addEventListener('click', (e) => { if (e.target.id === 'vStage') closePreview(); });
document.addEventListener('keydown', (e) => {
  if ($('#viewer').classList.contains('hidden')) return;
  if (e.key === 'Escape') closePreview();
  else if (e.key === 'ArrowLeft') stepPreview(-1);
  else if (e.key === 'ArrowRight') stepPreview(1);
});

async function renameEntry(path, name) {
  const newName = prompt('Rename to:', name);
  if (!newName || newName === name) return;
  try { await api('/api/rename', { serial: state.serial, path, name: newName }); toast('Renamed'); loadDir(state.path); }
  catch (err) { toast(err.message, true); }
}

async function deleteEntries(names) {
  const label = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
  if (!confirm(`Delete ${label} from the phone? This can't be undone.`)) return;
  let failed = 0;
  for (const n of names) {
    try { await api('/api/delete', { serial: state.serial, path: join(state.path, n) }); }
    catch (err) { failed++; toast(err.message, true); }
  }
  if (!failed) toast(`Deleted ${label}`);
  loadDir(state.path);
}

$('#checkAll').addEventListener('change', (e) => {
  visibleEntries().forEach((x) => e.target.checked ? state.selected.add(x.name) : state.selected.delete(x.name));
  renderFiles();
});
$('#bulkClear').onclick = () => { state.selected.clear(); renderFiles(); };
$('#bulkDelete').onclick = () => deleteEntries([...state.selected]);
$('#bulkDownload').onclick = () => {
  const names = [...state.selected];
  const only = names.length === 1 && state.entries.find((e) => e.name === names[0]);
  if (only && !only.dir) download(join(state.path, names[0]));
  else downloadZip(names);
};

$('#crumbs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) loadDir(b.dataset.path); });
$('#upBtn').onclick = () => loadDir(parent(state.path));
$('#refreshBtn').onclick = () => loadDir(state.path);
let filterTimer;
$('#filter').addEventListener('input', (e) => {
  clearTimeout(filterTimer);  // big folders re-render a lot of rows, so wait for a pause in typing
  filterTimer = setTimeout(() => { state.filter = e.target.value; renderFiles(); }, 120);
});
$$('th.sortable').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
  $$('th.sortable').forEach((t) => t.textContent = t.textContent.replace(/ [▲▼]$/, ''));
  th.textContent += state.sort.dir > 0 ? ' ▲' : ' ▼';
  renderFiles();
}));
$('#places').innerHTML = PLACES.map(([i, l, p]) => `<button data-path="${p}">${i} ${l}</button>`).join('');
$('#places').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) loadDir(b.dataset.path); });
$('#mkdirBtn').onclick = async () => {
  const name = prompt('New folder name:');
  if (!name) return;
  try { await api('/api/mkdir', { serial: state.serial, path: state.path, name }); loadDir(state.path); }
  catch (err) { toast(err.message, true); }
};

// ---------- uploads ----------
// Each task is one row in the Transfers panel: a single file, or a whole folder of files.
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const queue = [];
let uploading = false;
$('#uploadBtn').onclick = () => $('#fileInput').click();
$('#uploadDirBtn').onclick = () => $('#dirInput').click();
$('#fileInput').addEventListener('change', (e) => {
  enqueue([...e.target.files].map((file) => ({ file, rel: file.name }))); e.target.value = '';
});
$('#dirInput').addEventListener('change', (e) => {
  enqueue([...e.target.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }))); e.target.value = '';
});

// items: [{ file, rel }] where rel is "a.jpg" or "Folder/sub/a.jpg"; emptyDirs: ["Folder/empty"].
function enqueue(items, emptyDirs = []) {
  if (!state.serial) return toast('Connect a phone first', true);
  items = items.filter((it) => !SKIP_FILES.has(it.file.name));
  const folders = new Map();
  for (const it of items) {
    if (!it.rel.includes('/')) { addTask(it.rel, [it], [], false); continue; }
    const top = it.rel.split('/')[0];
    if (!folders.has(top)) folders.set(top, []);
    folders.get(top).push(it);
  }
  for (const d of emptyDirs) { const top = d.split('/')[0]; if (!folders.has(top)) folders.set(top, []); }
  for (const [top, its] of folders) addTask(top, its, emptyDirs.filter((d) => d === top || d.startsWith(top + '/')), true);
  if (!items.length && !emptyDirs.length) return toast('Nothing to upload', true);
  $('#transfers').classList.add('show');
  pump();
}

function addTask(label, items, emptyDirs, isDir) {
  const total = items.reduce((sum, it) => sum + it.file.size, 0);
  const el = document.createElement('div');
  el.className = 'tx';
  el.innerHTML = `<div class="row"><span class="fname">${isDir ? '📁 ' : ''}${esc(label)}</span><span class="state">Waiting</span></div>
    <div class="bar"><div style="width:0"></div></div>${isDir ? `<div class="sub">${items.length} files · ${fmtSize(total)}</div>` : ''}`;
  $('#txList').prepend(el);
  queue.push({ label, items, emptyDirs, isDir, total, el, serial: state.serial, path: state.path });
}

async function pump() {
  if (uploading) return;
  uploading = true;
  while (queue.length) {
    const task = queue.shift();
    updateTxTitle();
    await runTask(task);
  }
  uploading = false;
  updateTxTitle();
}

function updateTxTitle() {
  const left = queue.length + (uploading ? 1 : 0);
  $('#txTitle').textContent = left ? `Uploading… (${left} left)` : 'Transfers';
}

async function runTask({ label, items, emptyDirs, isDir, total, el, serial, path }) {
  const stateEl = $('.state', el), bar = $('.bar > div', el), sub = $('.sub', el);
  const failed = [];
  let doneBytes = 0;
  for (const d of emptyDirs) {
    await api('/api/mkdir', { serial, path, name: d }).catch(() => failed.push(d));
  }
  for (let i = 0; i < items.length; i++) {
    const { file, rel } = items[i];
    if (sub) sub.textContent = `${i + 1} of ${items.length} · ${rel}`;
    try {
      await uploadFile(serial, path, file, rel, (loaded) => {
        const sending = loaded >= file.size;
        if (isDir) {
          // Count half for reaching the app, half for reaching the phone (adb push happens after).
          const pct = total ? (doneBytes + loaded / 2) / total * 100 : 100;
          bar.style.width = pct + '%';
          stateEl.textContent = `${Math.round(pct)}% · ${fmtSize(total)}`;
        } else {
          bar.style.width = (file.size ? loaded / file.size * 100 : 100) + '%';
          bar.classList.toggle('indet', sending);
          stateEl.textContent = sending ? 'Sending to phone…' : `${Math.round(loaded / file.size * 100)}% · ${fmtSize(file.size)}`;
        }
      });
    } catch (err) {
      failed.push(rel);
      if (!isDir) { stateEl.title = err.message; toast(`${file.name}: ${err.message}`, true); }
    }
    doneBytes += file.size;
  }
  bar.classList.remove('indet');
  if (failed.length) {
    el.classList.add('err');
    stateEl.textContent = isDir ? `${failed.length} failed` : 'Failed';
    if (isDir) { stateEl.title = 'Failed:\n' + failed.join('\n'); toast(`${failed.length} item(s) in "${label}" failed to upload`, true); }
  } else {
    el.classList.add('done'); bar.style.width = '100%'; stateEl.textContent = 'Done ✓';
  }
  if (sub) sub.textContent = `${items.length - failed.length} of ${items.length} files uploaded · ${fmtSize(total)}`;
  if (serial === state.serial && path === state.path) loadDir(state.path);
}

function uploadFile(serial, path, file, rel, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?' + qs({ serial, path, name: rel }));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      if (xhr.status === 200) return resolve();
      let msg = 'Upload failed';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Lost connection to the app'));
    xhr.send(file);
  });
}
$('#txClose').onclick = () => {
  $('#transfers').classList.remove('show');
  $$('#txList .tx.done, #txList .tx.err').forEach((el) => el.remove());
};

// drag & drop (files and whole folders)
async function readEntry(entry, prefix, out, emptyDirs) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, rel: prefix + file.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader(), children = [];
    for (;;) {  // readEntries returns at most ~100 entries per call
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      children.push(...batch);
    }
    const rel = prefix + entry.name;
    if (!children.length) emptyDirs.push(rel);
    for (const child of children) await readEntry(child, rel + '/', out, emptyDirs);
  }
}

let dragDepth = 0;
const main = $('#main');
main.addEventListener('dragenter', (e) => { if (state.serial && e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').classList.add('show'); } });
main.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
main.addEventListener('dragover', (e) => { if (state.serial) e.preventDefault(); });
main.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('show');
  if (!state.serial) return;
  // Entries must be grabbed synchronously; the DataTransfer is emptied after this handler yields.
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return enqueue([...e.dataTransfer.files].map((file) => ({ file, rel: file.name })));
  const out = [], emptyDirs = [];
  if (entries.some((en) => en.isDirectory)) toast('Reading folder…');
  for (const en of entries) {
    await readEntry(en, '', out, emptyDirs).catch(() => toast(`Couldn't read "${en.name}"`, true));
  }
  enqueue(out, emptyDirs);
});
window.addEventListener('beforeunload', (e) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Wi-Fi dialog ----------
const wifiDlg = $('#wifiDlg');
function openWifi() { renderUsbList(); wifiDlg.showModal(); }
$('#openWifi').onclick = openWifi;
$$('[data-open-wifi]').forEach((b) => b.onclick = openWifi);
$('#openHelp').onclick = () => $('#helpDlg').showModal();
$$('dialog [data-close]').forEach((b) => b.onclick = () => b.closest('dialog').close());
$$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
$$('.tabs button').forEach((t) => t.onclick = () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === t));
  $$('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab));
});
$('#pairHost').addEventListener('input', (e) => { if (!$('#conHost').dataset.touched) $('#conHost').value = e.target.value; });
$('#conHost').addEventListener('input', (e) => e.target.dataset.touched = '1');

function splitHostPort(hostEl, portEl) {
  // Accept "192.168.1.5:37123" pasted into the IP box.
  const m = hostEl.value.trim().match(/^(.+):(\d+)$/);
  if (m) { hostEl.value = m[1]; portEl.value = m[2]; }
  return { host: hostEl.value.trim(), port: portEl.value.trim() };
}

$('#pairBtn').onclick = (e) => withBusy(e.currentTarget, async () => {
  const { host, port } = splitHostPort($('#pairHost'), $('#pairPort'));
  const code = $('#pairCode').value.trim();
  if (!host || !port || !code) return setMsg($('#pairMsg'), 'Fill in IP, port and code', false);
  try {
    await api('/api/pair', { host, port, code });
    setMsg($('#pairMsg'), '✓ Paired! Now enter the connect port below (step 3).', true);
    $('#conPort').focus();
  } catch (err) { setMsg($('#pairMsg'), err.message, false); }
});

async function connectWifi(hostEl, portEl, msgEl) {
  const { host, port } = splitHostPort(hostEl, portEl);
  if (!host || !port) return setMsg(msgEl, 'Fill in IP and port', false);
  try {
    const r = await api('/api/connect', { host, port });
    setMsg(msgEl, '✓ ' + r.message, true);
    state.serial = null;
    await refreshDevices();
    selectDevice(r.serial);
    setTimeout(() => wifiDlg.close(), 700);
    toast('Connected over Wi-Fi');
  } catch (err) { setMsg(msgEl, err.message, false); }
}
$('#conBtn').onclick = (e) => withBusy(e.currentTarget, () => connectWifi($('#conHost'), $('#conPort'), $('#conMsg')));
$('#dirBtn').onclick = (e) => withBusy(e.currentTarget, () => connectWifi($('#dirHost'), $('#dirPort'), $('#dirMsg')));

function renderUsbList() {
  const usb = state.devices.filter((d) => d.transport === 'usb' && d.state === 'device');
  $('#usbList').innerHTML = usb.length
    ? usb.map((d) => `<div class="device" style="cursor:default; border-color:var(--border)"><div class="ico">🔌</div>
        <div style="flex:1"><div class="name">${esc(d.model || 'Android device')}</div><div class="sub">${esc(d.serial)}</div></div>
        <button class="primary small" data-tcpip="${esc(d.serial)}">📶 Switch to Wi-Fi</button></div>`).join('')
    : `<div class="empty-devices" style="padding:4px 0">No USB phone connected yet. Plug one in and allow USB debugging.</div>`;
  $$('#usbList [data-tcpip]').forEach((b) => b.onclick = () => switchToWifi(b.dataset.tcpip, b));
}

// ---------- start ----------
setView(view);
refreshDevices().then(() => { renderDevices(); renderView(); });
// Watch for phones being plugged in or unplugged, but only while the tab is visible.
setInterval(() => { if (!document.hidden) refreshDevices(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDevices(); });

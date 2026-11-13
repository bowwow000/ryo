import * as db from './db.js';
import * as cloud from './cloud.js';

// ============================================================
// 設定
// ============================================================
const APP_NAME = '現場ピン';
const PDFJS = './vendor/pdfjs/pdf.min.js';
const PDFJS_WORKER = './vendor/pdfjs/pdf.worker.min.js';
const MAX_DRAWING = 4000;   // 図面画像の最大辺(px)
const MAX_AREA = 16e6;      // iOS のキャンバス上限対策
const MAX_PHOTO = 1920;     // 写真の最大辺(px)

const STATUSES = [
  { v: 'todo', label: '未確認', color: '#8e8e93' },
  { v: 'wip', label: '施工中', color: '#e8a100' },
  { v: 'done', label: '完了', color: '#28a745' },
  { v: 'ng', label: '要是正', color: '#e5242b' },
];
const KINDS = ['扉', '窓', 'シャッター', '点検口', 'その他'];
const OPEN_TYPES = ['片開き', '親子', '両開き', '片引き', '引違い', '引込み', '折戸', '自動ドア', 'その他'];
const FIRE = ['なし', '防火設備', '特定防火設備'];

// 項目（扉など）の入力欄。CSV・レポートもこの定義から作られる
const FIELDS = [
  { k: 'code', label: '符号', ph: '例: SD-1' },
  { k: 'kind', label: '種別', options: KINDS },
  { k: 'room', label: '室名・場所', ph: '例: 1F 事務室', full: true },
  { k: 'openType', label: '開き方', options: OPEN_TYPES },
  { k: 'fire', label: '防火', options: FIRE },
  { k: 'w', label: 'W (mm)', num: true, third: true },
  { k: 'h', label: 'H (mm)', num: true, third: true },
  { k: 't', label: '扉厚 (mm)', num: true, third: true },
  { k: 'hardware', label: '錠・金物', ph: '例: レバーハンドル / クローザー', full: true },
  { k: 'maker', label: 'メーカー・品番', full: true },
  { k: 'status', label: '状態', status: true },
  { k: 'note', label: 'メモ', textarea: true },
];

const statusOf = (v) => STATUSES.find((s) => s.v === v) || STATUSES[0];

// ============================================================
// ユーティリティ
// ============================================================
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const natural = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'ja', { numeric: true });
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const app = $('#app');
const titleEl = $('#title');
const backBtn = $('#back');
const actionsEl = $('#actions');
const sheetRoot = $('#sheet-root');
const toastEl = $('#toast');

let blobUrls = [];
function objUrl(blob) {
  const u = URL.createObjectURL(blob);
  blobUrls.push(u);
  return u;
}
let cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);
function runCleanup() {
  cleanups.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  cleanups = [];
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls = [];
}

function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function pickFiles({ accept, multiple = false, capture } = {}) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    if (accept) i.accept = accept;
    i.multiple = multiple;
    if (capture) i.setAttribute('capture', capture);
    i.style.display = 'none';
    document.body.appendChild(i);
    i.addEventListener('change', () => { resolve([...i.files]); i.remove(); });
    i.addEventListener('cancel', () => { resolve([]); i.remove(); });
    i.click();
  });
}

async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      // ユーザー操作の期限切れなど → ダウンロードにフォールバック
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// ---------- 画像処理 ----------
function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 30000); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

async function resizeToBlob(src, maxDim, type = 'image/jpeg', q = 0.85) {
  const w0 = src.naturalWidth || src.width;
  const h0 = src.naturalHeight || src.height;
  const k = Math.min(1, maxDim / Math.max(w0, h0), Math.sqrt(MAX_AREA / (w0 * h0)));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), type, q));
  c.width = c.height = 0;
  return { blob, width: w, height: h };
}

const drawingImgCache = new Map();
async function getDrawingImage(d) {
  if (!drawingImgCache.has(d.id)) {
    if (drawingImgCache.size >= 3) drawingImgCache.delete(drawingImgCache.keys().next().value);
    drawingImgCache.set(d.id, loadImageFromBlob(d.blob));
  }
  return drawingImgCache.get(d.id);
}

// 図面の一部（ピン周辺）を切り出して canvas に描く
async function renderCrop(d, focus, others, canvas, cssW, cssH, frac = 0.22) {
  const img = await getDrawingImage(d);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  const aspect = cssW / cssH;
  const sw = Math.max(d.width, d.height) * frac;
  const sh = sw / aspect;
  const sx = focus.x * d.width - sw / 2;
  const sy = focus.y * d.height - sh / 2;
  const k = canvas.width / sw;
  ctx.fillStyle = '#d9d9de';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
  const x1 = Math.min(d.width, sx + sw), y1 = Math.min(d.height, sy + sh);
  if (x1 > x0 && y1 > y0) {
    ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k);
  }
  const toC = (it) => [(it.x * d.width - sx) * k, (it.y * d.height - sy) * k];
  for (const o of others) {
    if (o.id === focus.id) continue;
    const [x, y] = toC(o);
    if (x < -50 || y < -50 || x > canvas.width + 50 || y > canvas.height + 50) continue;
    drawPinMarker(ctx, x, y, o.code, statusOf(o.status).color, dpr * 0.8, 0.55);
  }
  const [fx, fy] = toC(focus);
  drawPinMarker(ctx, fx, fy, focus.code, statusOf(focus.status).color, dpr * 1.1, 1);
}

function drawPinMarker(ctx, x, y, label, color, scale, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.font = 'bold 13px -apple-system, "Hiragino Sans", sans-serif';
  const text = label || '●';
  const w = Math.max(28, ctx.measureText(text).width + 16);
  const h = 22;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-6, -9); ctx.lineTo(0, 0); ctx.lineTo(6, -9); ctx.closePath();
  ctx.fill();
  roundRect(ctx, -w / 2, -9 - h, w, h, 11);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, -9 - h / 2 + 1);
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============================================================
// シート（ダイアログ）
// ============================================================
function openSheet(html) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet">${html}</div>`;
  sheetRoot.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 220); };
  return { el: wrap, close };
}

function actionSheet(title, options) {
  return new Promise((resolve) => {
    const s = openSheet(
      `${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}` +
      options.map((o, i) => `<button class="sheet-btn ${o.danger ? 'danger' : ''}" data-i="${i}">${esc(o.label)}</button>`).join('') +
      `<button class="sheet-btn cancel" data-i="-1">キャンセル</button>`
    );
    s.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (e.target !== s.el && !b) return;
      s.close();
      const i = b ? +b.dataset.i : -1;
      resolve(i >= 0 ? options[i].value : null);
    });
  });
}

function formSheet(title, fields, okLabel = '保存') {
  return new Promise((resolve) => {
    const s = openSheet(`<form class="sheet-form"><div class="sheet-title">${esc(title)}</div>
      ${fields.map((f) => `<label class="fld full"><span>${esc(f.label)}</span><input name="${f.k}" value="${esc(f.value || '')}" placeholder="${esc(f.ph || '')}" autocomplete="off"></label>`).join('')}
      <div class="row"><button type="button" class="btn" data-cancel>キャンセル</button><button class="btn primary">${esc(okLabel)}</button></div></form>`);
    const form = $('form', s.el);
    setTimeout(() => $('input', form)?.focus(), 250);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      s.close();
      resolve(v);
    });
    s.el.addEventListener('click', (e) => {
      if (e.target === s.el || e.target.closest('[data-cancel]')) { s.close(); resolve(null); }
    });
  });
}

const confirmSheet = async (msg, okLabel = '削除') => (await actionSheet(msg, [{ label: okLabel, value: true, danger: true }])) === true;

// ============================================================
// ナビゲーション
// ============================================================
const navStack = [];
function trackNav() {
  const h = location.hash || '#/';
  if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else if (navStack[navStack.length - 1] !== h) navStack.push(h);
}
function goBack(fallback) {
  if (navStack.length > 1) history.back();
  else { navStack.pop(); location.replace(fallback); }
}
const go = (h) => { location.hash = h; };

function setBar({ title, back, actions = [] }) {
  titleEl.textContent = title;
  document.title = `${title} - ${APP_NAME}`;
  backBtn.hidden = !back;
  backBtn.onclick = back ? () => goBack(back) : null;
  actionsEl.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'bar-btn' + (a.active ? ' active' : '');
    b.textContent = a.label;
    if (a.id) b.id = a.id;
    b.onclick = a.onClick;
    actionsEl.appendChild(b);
  }
}

let routeToken = 0;
let viewRefresh = null; // 他の人の変更を受信したときの画面更新（未設定なら画面を再表示）
async function route() {
  trackNav();
  runCleanup();
  viewRefresh = null;
  const token = ++routeToken;
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const q = new URLSearchParams(qs || '');
  const p = path.split('/').filter(Boolean);
  document.body.dataset.view = p[0] || 'home';
  window.scrollTo(0, 0);
  const stale = () => token !== routeToken;
  try {
    if (!p.length) await viewHome(stale);
    else if (p[0] === 'p') await viewProject(p[1], p[2] || 'drawings', stale);
    else if (p[0] === 'd') await viewDrawing(p[1], q, stale);
    else if (p[0] === 'i') await viewItem(p[1], stale);
    else if (p[0] === 'r') await viewReport(p[1], stale);
    else await viewHome(stale);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty">エラーが発生しました<br><small>${esc(e.message)}</small></div>`;
  }
}

async function touchProject(pid) {
  const p = await db.get('projects', pid);
  if (p) { p.updatedAt = Date.now(); await db.put('projects', p); }
}

// ============================================================
// 画面: 現場一覧
// ============================================================
async function viewHome(stale) {
  const [projects, items] = await Promise.all([db.all('projects'), db.all('items')]);
  if (stale()) return;
  setBar({ title: '現場一覧', actions: [...(cloud.isConfigured() ? [{ label: '☁', onClick: cloudMenu }] : []), { label: '⋯', onClick: homeMenu }] });
  projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const cnt = {};
  items.forEach((i) => {
    const c = (cnt[i.projectId] ??= { total: 0, done: 0, ng: 0 });
    c.total++;
    if (i.status === 'done') c.done++;
    if (i.status === 'ng') c.ng++;
  });
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  app.innerHTML = `
    ${cloudLineHtml()}
    ${!standalone && /iPhone|iPad/.test(navigator.userAgent) ? `<div class="tip">📲 Safari の共有ボタン →「ホーム画面に追加」でアプリとして使えます。データの保持も安定します。</div>` : ''}
    <div class="list">
      ${projects.length ? projects.map((p) => {
        const c = cnt[p.id] || { total: 0, done: 0, ng: 0 };
        return `<a class="card" href="#/p/${p.id}">
          <div class="card-main"><div class="card-title">${esc(p.name)}</div>
          <div class="card-sub">${p.cloud ? '☁ ' : ''}${esc(p.address || '')}</div></div>
          <div class="card-meta">${progressHtml(c)}</div></a>`;
      }).join('') : `<div class="empty">現場がまだありません。<br>右下の「＋ 新規現場」から作成してください。</div>`}
    </div>
    <button class="fab" id="newProject">＋ 新規現場</button>`;
  $('#newProject').onclick = async () => {
    const v = await formSheet('新規現場', [
      { k: 'name', label: '現場名', ph: '例: ○○ビル新築工事' },
      { k: 'address', label: '住所・メモ' },
    ], '作成');
    if (!v || !v.name.trim()) return;
    const now = Date.now();
    const p = { id: uid(), name: v.name.trim(), address: v.address.trim(), createdAt: now, updatedAt: now };
    await db.put('projects', p);
    navigator.storage?.persist?.();
    go(`#/p/${p.id}`);
  };
}

function progressHtml(c) {
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  return `<div class="prog-text">${c.done}/${c.total} 完了${c.ng ? ` <span class="badge ng">是正 ${c.ng}</span>` : ''}</div>
    <div class="prog"><i style="width:${pct}%"></i></div>`;
}

async function homeMenu() {
  const a = await actionSheet(null, [
    ...(cloud.isConfigured() ? [{ label: '☁ OneDrive 連携', value: 'cloud' }] : []),
    { label: '全データをバックアップ', value: 'backup' },
    { label: 'バックアップから復元', value: 'restore' },
    { label: '使用容量を確認', value: 'usage' },
  ]);
  if (a === 'cloud') cloudMenu();
  if (a === 'backup') exportBackup();
  if (a === 'restore') importBackup();
  if (a === 'usage') {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (!est) return toast('この端末では確認できません');
    const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
    toast(`使用量 ${mb(est.usage)} / 上限目安 ${mb(est.quota)}${persisted ? '（保護済み）' : ''}`, 4000);
  }
}

// ============================================================
// 画面: 現場（図面一覧 / 項目一覧）
// ============================================================
async function viewProject(id, tab, stale) {
  const p = await db.get('projects', id);
  if (!p) return go('#/');
  const [drawings, items, photos] = await Promise.all([
    db.by('drawings', 'projectId', id), db.by('items', 'projectId', id), db.by('photos', 'projectId', id),
  ]);
  if (stale()) return;
  setBar({ title: p.name, back: '#/', actions: [{ label: '⋯', onClick: () => projectMenu(p) }] });
  drawings.sort((a, b) => a.createdAt - b.createdAt);
  const dName = Object.fromEntries(drawings.map((d) => [d.id, d.name]));
  const pinCount = {};
  items.forEach((i) => { pinCount[i.drawingId] = (pinCount[i.drawingId] || 0) + 1; });
  const photoCount = {};
  photos.forEach((ph) => { photoCount[ph.itemId] = (photoCount[ph.itemId] || 0) + 1; });

  app.innerHTML = `
    ${p.cloud ? cloudLineHtml() : ''}
    <div class="tabs">
      <button data-tab="drawings" class="${tab === 'drawings' ? 'active' : ''}">図面 <small>${drawings.length}</small></button>
      <button data-tab="list" class="${tab === 'list' ? 'active' : ''}">一覧 <small>${items.length}</small></button>
    </div>
    <div id="tabBody"></div>`;
  app.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => location.replace(`#/p/${id}/${b.dataset.tab}`);
  });
  const body = $('#tabBody');

  if (tab === 'drawings') {
    body.innerHTML = `
      <div class="grid">
        ${drawings.map((d) => `
          <a class="dcard" href="#/d/${d.id}">
            <div class="dthumb"><img src="${objUrl(d.thumb || d.blob)}" alt="" loading="lazy"></div>
            <div class="dinfo"><div class="dname">${esc(d.name)}</div><div class="dsub">ピン ${pinCount[d.id] || 0}</div></div>
            <button class="dmenu" data-id="${d.id}" aria-label="メニュー">⋯</button>
          </a>`).join('')}
      </div>
      ${drawings.length ? '' : `<div class="empty">図面がありません。<br>PDF・画像・カメラ撮影で取り込めます。</div>`}
      <button class="fab" id="importBtn">＋ 図面を取り込む</button>`;
    $('#importBtn').onclick = () => importDrawings(id);
    body.querySelectorAll('.dmenu').forEach((b) => {
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        drawingMenu(drawings.find((d) => d.id === b.dataset.id), () => route());
      };
    });
  } else {
    body.innerHTML = `
      <div class="filter">
        <input type="search" id="q" placeholder="符号・室名・メモで検索">
        <div class="chips" id="chips">
          <button class="chip on" data-s="">すべて</button>
          ${STATUSES.map((s) => `<button class="chip" data-s="${s.v}" style="--c:${s.color}">${s.label}</button>`).join('')}
        </div>
      </div>
      <div class="rows" id="rows"></div>`;
    let fs = '';
    const render = () => {
      const q = $('#q').value.trim().toLowerCase();
      const list = items
        .filter((i) => !fs || (i.status || 'todo') === fs)
        .filter((i) => !q || FIELDS.some((f) => String(i[f.k] ?? '').toLowerCase().includes(q)) || (dName[i.drawingId] || '').toLowerCase().includes(q))
        .sort((a, b) => natural(a.code, b.code));
      $('#rows').innerHTML = list.length ? list.map((i) => {
        const s = statusOf(i.status);
        return `<a class="row-item" href="#/i/${i.id}">
          <span class="dot" style="--c:${s.color}"></span>
          <div class="ri-main"><div class="ri-title">${esc(i.code || '(符号なし)')} <small>${esc([i.kind, i.openType].filter(Boolean).join(' / '))}</small></div>
          <div class="ri-sub">${esc(i.room || '')}${i.room ? ' ・ ' : ''}${esc(dName[i.drawingId] || '')}</div></div>
          <div class="ri-meta"><span class="st" style="--c:${s.color}">${s.label}</span>${photoCount[i.id] ? `<small>📷${photoCount[i.id]}</small>` : ''}</div>
        </a>`;
      }).join('') : `<div class="empty">該当する項目がありません${items.length ? '' : '。<br>図面を開いて「＋ピン」で追加します。'}</div>`;
    };
    $('#q').addEventListener('input', render);
    $('#chips').addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      fs = b.dataset.s;
      $('#chips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
      render();
    });
    render();
  }
}

async function projectMenu(p) {
  const a = await actionSheet(p.name, [
    ...(!cloud.isConfigured() ? [] : p.cloud
      ? [{ label: '☁ OneDrive のフォルダを開く（共有設定）', value: 'odopen' }, { label: '☁ 今すぐ同期', value: 'sync' }]
      : [{ label: '☁ OneDrive に保存（チームで共有）', value: 'link' }]),
    { label: '写真付きレポート（印刷・PDF）', value: 'report' },
    { label: '一覧をCSVで出力', value: 'csv' },
    { label: 'この現場をバックアップ', value: 'backup' },
    { label: '現場情報を編集', value: 'edit' },
    { label: '現場を削除', value: 'delete', danger: true },
  ]);
  if (a === 'odopen') {
    if (p.cloud.webUrl) window.open(p.cloud.webUrl, '_blank');
    else toast('フォルダの場所を取得できませんでした。OneDrive アプリで「現場ピン」フォルダを開いてください', 5000);
  }
  if (a === 'sync') syncNow();
  if (a === 'link') {
    if (!cloud.hasSession()) return cloudMenu();
    try {
      toast('OneDrive に保存中…（写真が多いと時間がかかります）', 0);
      await cloud.linkProject(p.id);
      toast('OneDrive に保存しました。共有するには「OneDrive のフォルダを開く」から共有してください', 6000);
    } catch (e) {
      toast(`保存できませんでした: ${e.message}`, 6000);
    }
    route();
  }
  if (a === 'report') go(`#/r/${p.id}`);
  if (a === 'csv') exportCsv(p);
  if (a === 'backup') exportBackup(p);
  if (a === 'edit') {
    const v = await formSheet('現場情報', [
      { k: 'name', label: '現場名', value: p.name },
      { k: 'address', label: '住所・メモ', value: p.address },
    ]);
    if (!v || !v.name.trim()) return;
    Object.assign(p, { name: v.name.trim(), address: v.address.trim(), updatedAt: Date.now() });
    await db.put('projects', p);
    route();
  }
  if (a === 'delete') {
    if (p.cloud) {
      if (!(await confirmSheet(`「${p.name}」をこの端末から外します。OneDrive 上のデータは残ります（完全に消すときは OneDrive でフォルダを削除してください）。`, 'この端末から外す'))) return;
      await deleteProject(p.id, { localOnly: true });
      toast('この端末から外しました');
      return location.replace('#/');
    }
    if (!(await confirmSheet(`「${p.name}」の図面・項目・写真をすべて削除します。元に戻せません。`))) return;
    await deleteProject(p.id);
    toast('削除しました');
    location.replace('#/');
  }
}

async function drawingMenu(d, after) {
  const a = await actionSheet(d.name, [
    { label: '名前を変更', value: 'rename' },
    { label: '図面を削除', value: 'delete', danger: true },
  ]);
  if (a === 'rename') {
    const v = await formSheet('図面名', [{ k: 'name', label: '名前', value: d.name }]);
    if (!v || !v.name.trim()) return;
    d.name = v.name.trim();
    await db.put('drawings', d);
    after?.();
  }
  if (a === 'delete') {
    const n = (await db.by('items', 'drawingId', d.id)).length;
    if (!(await confirmSheet(`「${d.name}」${n ? `と配置済みの ${n} 件（写真含む）` : ''}を削除します。`))) return;
    await deleteDrawing(d.id);
    toast('削除しました');
    if (location.hash.startsWith('#/d/')) location.replace(`#/p/${d.projectId}`);
    else after?.();
  }
}

// ---------- 図面の取り込み ----------
async function importDrawings(projectId) {
  const files = await pickFiles({ accept: 'image/*,application/pdf', multiple: true });
  if (!files.length) return;
  let added = 0;
  try {
    for (const f of files) {
      const base = f.name.replace(/\.[^.]+$/, '') || '図面';
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        added += await importPdf(projectId, f, base);
      } else {
        toast(`取り込み中… ${f.name}`, 0);
        const img = await loadImageFromBlob(f);
        await addDrawing(projectId, base === 'image' ? `図面 ${new Date().toLocaleDateString('ja-JP')}` : base, img);
        added++;
      }
    }
    toast(`${added} 枚の図面を取り込みました`);
  } catch (e) {
    console.error(e);
    toast(`取り込みに失敗しました: ${e.message}`, 5000);
  }
  await touchProject(projectId);
  if (location.hash.startsWith(`#/p/${projectId}`)) route();
}

async function addDrawing(projectId, name, source) {
  const full = await resizeToBlob(source, MAX_DRAWING, 'image/jpeg', 0.9);
  const thumb = await resizeToBlob(source, 480, 'image/jpeg', 0.8);
  await db.put('drawings', {
    id: uid(), projectId, name, blob: full.blob, thumb: thumb.blob,
    width: full.width, height: full.height, createdAt: Date.now(),
  });
}

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFJS;
    s.onload = resolve;
    s.onerror = () => reject(new Error('PDF読み込み機能を取得できませんでした'));
    document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return window.pdfjsLib;
}

async function importPdf(projectId, file, base) {
  toast('PDFを読み込み中…', 0);
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  for (let n = 1; n <= pdf.numPages; n++) {
    toast(`PDFを変換中… ${n} / ${pdf.numPages} ページ`, 0);
    const page = await pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_DRAWING / Math.max(vp1.width, vp1.height), Math.sqrt(MAX_AREA / (vp1.width * vp1.height)));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    await addDrawing(projectId, pdf.numPages > 1 ? `${base} (${n})` : base, c);
    c.width = c.height = 0;
    page.cleanup();
  }
  const n = pdf.numPages;
  await pdf.destroy();
  return n;
}

// ============================================================
// 図面ビューア（パン・ピンチズーム）
// ============================================================
function createViewer(stage, content, W, H, { onTap, onPin } = {}) {
  let s = 1, tx = 0, ty = 0, minS = 0.05, maxS = 10;
  content.style.width = W + 'px';
  content.style.height = H + 'px';
  const apply = () => {
    content.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${s})`;
    content.style.setProperty('--inv', 1 / s);
  };
  const rect = () => stage.getBoundingClientRect();
  function fit() {
    const r = rect();
    s = Math.min(r.width / W, r.height / H) * 0.96;
    minS = s * 0.5;
    maxS = Math.max(s * 25, 3);
    tx = (r.width - W * s) / 2;
    ty = (r.height - H * s) / 2;
    apply();
  }
  function zoomAt(f, cx, cy) {
    const ns = clamp(s * f, minS, maxS);
    const px = (cx - tx) / s, py = (cy - ty) / s;
    s = ns; tx = cx - px * s; ty = cy - py * s;
    apply();
  }
  function centerOn(nx, ny, scale) {
    const r = rect();
    s = clamp(scale, minS, maxS);
    tx = r.width / 2 - nx * W * s;
    ty = r.height / 2 - ny * H * s;
    apply();
  }
  const pts = new Map();
  let g = null;
  let lastTap = 0;
  const local = (e) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  stage.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) {
      const p = local(e);
      g = { type: 'pan', sx: p.x, sy: p.y, tx, ty, moved: false, t: Date.now(), pin: e.target.closest('.pin')?.dataset.id };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      g = { type: 'pinch', d: dist(a, b) || 1, m: mid(a, b), s, tx, ty };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, local(e));
    if (g.type === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const nm = mid(a, b);
      const px = (g.m.x - g.tx) / g.s, py = (g.m.y - g.ty) / g.s;
      s = clamp((g.s * dist(a, b)) / g.d, minS, maxS);
      tx = nm.x - px * s; ty = nm.y - py * s;
      apply();
    } else if (g.type === 'pan') {
      const p = local(e);
      const dx = p.x - g.sx, dy = p.y - g.sy;
      if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
      if (g.moved) { tx = g.tx + dx; ty = g.ty + dy; apply(); }
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.delete(e.pointerId);
    if (g?.type === 'pan' && !g.moved && e.type === 'pointerup' && Date.now() - g.t < 600) {
      if (g.pin) onPin?.(g.pin);
      else {
        const nx = (p.x - tx) / s / W, ny = (p.y - ty) / s / H;
        const now = Date.now();
        const handled = onTap?.(nx, ny);
        // 何もしないタップを素早く2回 → ズーム
        if (!handled) {
          if (now - lastTap < 320) { zoomAt(2, p.x, p.y); lastTap = 0; } else lastTap = now;
        }
      }
    }
    if (pts.size === 1 && g?.type === 'pinch') {
      const [q] = [...pts.values()];
      g = { type: 'pan', sx: q.x, sy: q.y, tx, ty, moved: true };
    } else if (pts.size === 0) g = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  fit();
  return {
    fit,
    centerOn,
    zoom: (f) => { const r = rect(); zoomAt(f, r.width / 2, r.height / 2); },
    get scale() { return s; },
  };
}

// ============================================================
// 画面: 図面（ピン配置）
// ============================================================
async function viewDrawing(id, q, stale) {
  const d = await db.get('drawings', id);
  if (!d) return go('#/');
  let items = await db.by('items', 'drawingId', id);
  if (stale()) return;
  const moveId = q.get('move');
  const focusId = q.get('focus');
  let addMode = false;
  const hidden = new Set();

  const toggleAdd = () => {
    addMode = !addMode;
    $('#addBtn').classList.toggle('active', addMode);
    $('#hint').hidden = !addMode;
    $('#hint').textContent = '追加したい位置をタップ';
  };
  setBar({
    title: d.name,
    back: `#/p/${d.projectId}`,
    actions: moveId ? [] : [
      { label: '＋ピン', id: 'addBtn', onClick: toggleAdd },
      { label: '⋯', onClick: () => drawingMenu(d, () => { titleEl.textContent = d.name; }) },
    ],
  });

  app.innerHTML = `
    <div class="stage" id="stage"><div class="content" id="content">
      <img src="${objUrl(d.blob)}" draggable="false" alt="">
      <div class="pins" id="pins"></div>
    </div></div>
    <div class="hint" id="hint" ${moveId ? '' : 'hidden'}>新しい位置をタップしてください</div>
    <div class="floating">
      <div class="chips" id="chips"></div>
      <div class="zoom">
        <button data-z="in" aria-label="拡大">＋</button>
        <button data-z="out" aria-label="縮小">－</button>
        <button data-z="fit" aria-label="全体">⤢</button>
      </div>
    </div>`;

  const renderPins = () => {
    $('#pins').innerHTML = items
      .filter((i) => !hidden.has(i.status || 'todo'))
      .map((i) => `<div class="pin ${i.id === moveId ? 'moving' : ''} ${i.id === focusId ? 'focus' : ''}" data-id="${i.id}"
          style="left:${i.x * 100}%;top:${i.y * 100}%;--c:${statusOf(i.status).color}"><span>${esc(i.code || '●')}</span></div>`)
      .join('');
    $('#chips').innerHTML = STATUSES.map((s) => {
      const n = items.filter((i) => (i.status || 'todo') === s.v).length;
      return `<button class="chip ${hidden.has(s.v) ? '' : 'on'}" data-s="${s.v}" style="--c:${s.color}">${s.label} <b>${n}</b></button>`;
    }).join('');
  };
  renderPins();
  viewRefresh = async () => {
    if (!(await db.get('drawings', id))) return location.replace(`#/p/${d.projectId}`);
    items = await db.by('items', 'drawingId', id);
    renderPins();
  };
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    hidden.has(b.dataset.s) ? hidden.delete(b.dataset.s) : hidden.add(b.dataset.s);
    renderPins();
  });

  const viewer = createViewer($('#stage'), $('#content'), d.width, d.height, {
    onPin: (pid) => { if (!moveId) go(`#/i/${pid}`); },
    onTap: (nx, ny) => {
      if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return false;
      if (moveId) {
        (async () => {
          const it = items.find((i) => i.id === moveId) || (await db.get('items', moveId));
          if (!it) return;
          Object.assign(it, { x: nx, y: ny, drawingId: d.id, updatedAt: Date.now() });
          await db.put('items', it);
          toast('位置を変更しました');
          goBack(`#/i/${moveId}`);
        })();
        return true;
      }
      if (addMode) {
        (async () => {
          const projectItems = await db.by('items', 'projectId', d.projectId);
          const last = projectItems.sort((a, b) => b.createdAt - a.createdAt)[0];
          const now = Date.now();
          const it = {
            id: uid(), projectId: d.projectId, drawingId: d.id, x: nx, y: ny,
            code: nextCode(last?.code), kind: last?.kind || '扉', status: 'todo',
            createdAt: now, updatedAt: now,
          };
          await db.put('items', it);
          await touchProject(d.projectId);
          go(`#/i/${it.id}?new=1`);
        })();
        return true;
      }
      return false;
    },
  });
  document.querySelector('.zoom').addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'in') viewer.zoom(1.6);
    if (z === 'out') viewer.zoom(1 / 1.6);
    if (z === 'fit') viewer.fit();
  });
  const focus = items.find((i) => i.id === (focusId || moveId));
  if (focus) viewer.centerOn(focus.x, focus.y, viewer.scale * 4);
  const onResize = () => viewer.fit();
  window.addEventListener('orientationchange', onResize);
  onCleanup(() => window.removeEventListener('orientationchange', onResize));
}

function nextCode(code) {
  if (!code) return '';
  const m = String(code).match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return code;
  const n = String(+m[2] + 1).padStart(m[2].length, '0');
  return m[1] + n + m[3];
}

// ============================================================
// 画面: 項目（扉など）の詳細
// ============================================================
function fieldHtml(f, it) {
  const v = it[f.k] ?? '';
  if (f.status) {
    return `<div class="fld full"><span>${f.label}</span><div class="seg">
      ${STATUSES.map((s) => `<label style="--c:${s.color}"><input type="radio" name="status" value="${s.v}" ${(v || 'todo') === s.v ? 'checked' : ''}><span>${s.label}</span></label>`).join('')}
    </div></div>`;
  }
  if (f.options) {
    return `<label class="fld ${f.full ? 'full' : ''}"><span>${f.label}</span><select name="${f.k}">
      <option value=""></option>
      ${f.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      ${v && !f.options.includes(v) ? `<option selected>${esc(v)}</option>` : ''}
    </select></label>`;
  }
  if (f.textarea) {
    return `<label class="fld full"><span>${f.label}</span><textarea name="${f.k}" rows="4" placeholder="${esc(f.ph || '')}">${esc(v)}</textarea></label>`;
  }
  return `<label class="fld ${f.full ? 'full' : f.third ? 'third' : ''}"><span>${f.label}</span><input name="${f.k}" value="${esc(v)}"
    placeholder="${esc(f.ph || '')}" autocomplete="off" ${f.num ? 'inputmode="numeric"' : ''}></label>`;
}

async function viewItem(id, stale) {
  const it = await db.get('items', id);
  if (!it) return goBack('#/');
  const [d, siblings] = await Promise.all([db.get('drawings', it.drawingId), db.by('items', 'drawingId', it.drawingId)]);
  if (stale()) return;
  const isNew = new URLSearchParams(location.hash.split('?')[1] || '').has('new');
  const titleOf = () => it.code || '(符号なし)';
  setBar({
    title: titleOf(),
    back: `#/d/${it.drawingId}`,
    actions: [{ label: '⋯', onClick: () => itemMenu(it) }],
  });

  app.innerHTML = `
    <div class="item-page">
      <button class="loc" id="loc" ${d ? '' : 'disabled'}>
        <canvas id="locCanvas"></canvas>
        <div class="loc-label">${esc(d?.name || '図面なし')} ・ タップで図面を開く</div>
      </button>
      <section>
        <div class="sec-head"><h2>写真 <small id="phCount"></small></h2>
          <div class="sec-actions"><button class="btn sm" id="cam">📷 撮影</button><button class="btn sm" id="lib">🖼 選択</button></div>
        </div>
        <div class="photos" id="photos"></div>
      </section>
      <section>
        <h2>情報</h2>
        <form id="form" class="form" autocomplete="off">${FIELDS.map((f) => fieldHtml(f, it)).join('')}</form>
        <div class="meta">登録 ${fmtDate(it.createdAt)} ・ 更新 <span id="upd">${fmtDate(it.updatedAt)}</span></div>
      </section>
      <div class="bottom-actions">
        <button class="btn" id="moveBtn">図面上の位置を変更</button>
        <button class="btn danger" id="delBtn">この項目を削除</button>
      </div>
    </div>`;

  if (d) {
    const cv = $('#locCanvas');
    const w = cv.clientWidth || 340;
    renderCrop(d, it, siblings, cv, w, 170, 0.4).catch(console.error);
    $('#loc').onclick = () => go(`#/d/${d.id}?focus=${it.id}`);
  }

  // ---- 写真 ----
  const renderPhotos = async () => {
    const photos = (await db.by('photos', 'itemId', it.id)).sort((a, b) => a.createdAt - b.createdAt);
    $('#phCount').textContent = photos.length || '';
    $('#photos').innerHTML = photos.length
      ? photos.map((ph) => `<button class="ph" data-id="${ph.id}"><img src="${objUrl(ph.thumb || ph.blob)}" alt="">${ph.caption ? `<span>${esc(ph.caption)}</span>` : ''}</button>`).join('')
      : `<div class="ph-empty">写真はまだありません</div>`;
    $('#photos').querySelectorAll('.ph').forEach((b) => {
      b.onclick = () => openPhoto(photos.find((p) => p.id === b.dataset.id), renderPhotos);
    });
  };
  viewRefresh = async () => {
    const cur = await db.get('items', it.id);
    if (!cur) { toast('この項目は他の人に削除されました', 4000); return goBack(`#/d/${it.drawingId}`); }
    renderPhotos();
    if (cur._mtime !== it._mtime && !cur._dirty) toast('他の人がこの項目を更新しました。開き直すと反映されます', 4000);
  };
  const addPhotos = async (files) => {
    if (!files.length) return;
    try {
      for (let n = 0; n < files.length; n++) {
        toast(`写真を保存中… ${n + 1}/${files.length}`, 0);
        const img = await loadImageFromBlob(files[n]);
        const full = await resizeToBlob(img, MAX_PHOTO, 'image/jpeg', 0.85);
        const th = await resizeToBlob(img, 360, 'image/jpeg', 0.75);
        await db.put('photos', {
          id: uid(), itemId: it.id, projectId: it.projectId, blob: full.blob, thumb: th.blob,
          width: full.width, height: full.height, caption: '', createdAt: Date.now(),
        });
      }
      it.updatedAt = Date.now();
      await db.put('items', it);
      toast(`${files.length} 枚保存しました`);
    } catch (e) {
      toast(`保存に失敗しました: ${e.message}`, 5000);
    }
    renderPhotos();
  };
  $('#cam').onclick = async () => addPhotos(await pickFiles({ accept: 'image/*', capture: 'environment' }));
  $('#lib').onclick = async () => addPhotos(await pickFiles({ accept: 'image/*', multiple: true }));
  renderPhotos();

  // ---- 入力（自動保存） ----
  const form = $('#form');
  let timer = null;
  const save = async () => {
    timer = null;
    const fd = new FormData(form);
    FIELDS.forEach((f) => { it[f.k] = String(fd.get(f.k) ?? '').trim(); });
    it.updatedAt = Date.now();
    await db.put('items', it);
    if (!stale()) {
      titleEl.textContent = titleOf();
      $('#upd').textContent = fmtDate(it.updatedAt);
    }
  };
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 500); });
  form.addEventListener('change', () => { clearTimeout(timer); save(); });
  onCleanup(() => { if (timer) { clearTimeout(timer); save(); } });
  if (isNew) {
    setTimeout(() => form.querySelector('[name=code]')?.select(), 300);
    const clean = `#/i/${it.id}`;
    history.replaceState(null, '', clean);
    navStack[navStack.length - 1] = clean;
  }

  $('#moveBtn').onclick = () => go(`#/d/${it.drawingId}?move=${it.id}`);
  $('#delBtn').onclick = () => removeItem(it);
}

async function removeItem(it) {
  if (!(await confirmSheet(`「${it.code || '(符号なし)'}」と写真を削除します。`))) return;
  await deleteItem(it.id);
  toast('削除しました');
  goBack(`#/d/${it.drawingId}`);
}

async function itemMenu(it) {
  const a = await actionSheet(it.code || '(符号なし)', [
    { label: '図面上で表示', value: 'show' },
    { label: '同じ内容で複製（位置を指定）', value: 'dup' },
    { label: '削除', value: 'delete', danger: true },
  ]);
  if (a === 'show') go(`#/d/${it.drawingId}?focus=${it.id}`);
  if (a === 'dup') {
    const now = Date.now();
    const copy = { ...it, id: uid(), code: nextCode(it.code), status: 'todo', x: Math.min(1, it.x + 0.02), y: it.y, createdAt: now, updatedAt: now };
    await db.put('items', copy);
    toast('複製しました。配置する位置をタップしてください');
    location.replace(`#/i/${copy.id}`);
    setTimeout(() => go(`#/d/${copy.drawingId}?move=${copy.id}`), 50);
  }
  if (a === 'delete') removeItem(it);
}

// ---------- 写真の拡大表示 ----------
function openPhoto(ph, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'photo-view';
  wrap.innerHTML = `
    <div class="pv-bar">
      <button class="bar-btn" data-a="close">閉じる</button>
      <div class="pv-date">${fmtDate(ph.createdAt)}</div>
      <button class="bar-btn" data-a="share">共有</button>
      <button class="bar-btn danger" data-a="del">削除</button>
    </div>
    <div class="stage pv-stage"><div class="content"><img alt="" draggable="false"></div></div>
    <div class="pv-cap"><input placeholder="キャプション（例: 丁番取付状況）" value="${esc(ph.caption || '')}"></div>`;
  document.body.appendChild(wrap);
  const url = URL.createObjectURL(ph.blob);
  $('img', wrap).src = url;
  const viewer = createViewer($('.pv-stage', wrap), $('.content', wrap), ph.width || 1000, ph.height || 1000, { onTap: () => false });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const cap = $('.pv-cap input', wrap).value.trim();
    if (cap !== (ph.caption || '')) { ph.caption = cap; await db.put('photos', ph); onChange?.(); }
    URL.revokeObjectURL(url);
    wrap.remove();
  };
  onCleanup(close);
  wrap.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'close') close();
    if (a === 'share') shareOrDownload(ph.blob, `photo_${ph.id.slice(0, 8)}.jpg`);
    if (a === 'del') {
      if (!(await confirmSheet('この写真を削除します'))) return;
      await db.del('photos', ph.id);
      closed = true;
      URL.revokeObjectURL(url);
      wrap.remove();
      onChange?.();
    }
  });
  void viewer;
}

// ============================================================
// 画面: レポート（印刷・PDF保存用）
// ============================================================
async function viewReport(pid, stale) {
  const p = await db.get('projects', pid);
  if (!p) return go('#/');
  const [drawings, items, photos] = await Promise.all([
    db.by('drawings', 'projectId', pid), db.by('items', 'projectId', pid), db.by('photos', 'projectId', pid),
  ]);
  if (stale()) return;
  setBar({ title: 'レポート', back: `#/p/${pid}`, actions: [{ label: '印刷 / PDF', onClick: () => window.print() }] });
  drawings.sort((a, b) => a.createdAt - b.createdAt);
  const phBy = {};
  photos.sort((a, b) => a.createdAt - b.createdAt).forEach((ph) => (phBy[ph.itemId] ??= []).push(ph));
  const c = { total: items.length, done: 0, ng: 0 };
  items.forEach((i) => { if (i.status === 'done') c.done++; if (i.status === 'ng') c.ng++; });

  app.innerHTML = `<div class="report">
    <div class="r-head"><h1>${esc(p.name)}</h1><div>${esc(p.address || '')}</div>
      <div class="r-sum">出力日 ${fmtDate(Date.now())} ・ 全 ${c.total} 件 ・ ${STATUSES.map((s) => `${s.label} ${items.filter((i) => (i.status || 'todo') === s.v).length}`).join(' ・ ')}</div>
    </div>
    ${drawings.map((d) => {
      const its = items.filter((i) => i.drawingId === d.id).sort((a, b) => natural(a.code, b.code));
      return `<section class="r-drawing">
        <h2>${esc(d.name)} <small>${its.length} 件</small></h2>
        <div class="r-plan"><img src="${objUrl(d.blob)}" alt="">
          ${its.map((i) => `<div class="r-pin" style="left:${i.x * 100}%;top:${i.y * 100}%;--c:${statusOf(i.status).color}">${esc(i.code || '●')}</div>`).join('')}
        </div>
        ${its.map((i) => `<article class="r-item">
          <div class="r-item-head"><b>${esc(i.code || '(符号なし)')}</b><span class="st" style="--c:${statusOf(i.status).color}">${statusOf(i.status).label}</span></div>
          <div class="r-item-body">
            <canvas class="r-crop" data-item="${i.id}" data-drawing="${d.id}"></canvas>
            <table>${FIELDS.filter((f) => !f.status && f.k !== 'code' && i[f.k]).map((f) => `<tr><th>${f.label}</th><td>${esc(i[f.k]).replace(/\n/g, '<br>')}</td></tr>`).join('')}
              <tr><th>更新</th><td>${fmtDate(i.updatedAt)}</td></tr></table>
          </div>
          ${(phBy[i.id] || []).length ? `<div class="r-photos">${phBy[i.id].map((ph) => `<figure><img src="${objUrl(ph.blob)}" alt="">${ph.caption ? `<figcaption>${esc(ph.caption)}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}
        </article>`).join('')}
      </section>`;
    }).join('')}
  </div>`;

  // ピン周辺の切り出し図を順に描画
  for (const cv of app.querySelectorAll('.r-crop')) {
    if (stale()) return;
    const d = drawings.find((x) => x.id === cv.dataset.drawing);
    const it = items.find((x) => x.id === cv.dataset.item);
    const sib = items.filter((x) => x.drawingId === d.id);
    try { await renderCrop(d, it, sib, cv, 220, 160, 0.25); } catch (e) { console.error(e); }
  }
}

// ============================================================
// 出力（CSV / バックアップ）
// ============================================================
async function exportCsv(p) {
  const [drawings, items, photos] = await Promise.all([
    db.by('drawings', 'projectId', p.id), db.by('items', 'projectId', p.id), db.by('photos', 'projectId', p.id),
  ]);
  const dn = Object.fromEntries(drawings.map((d) => [d.id, d.name]));
  const pc = {};
  photos.forEach((ph) => { pc[ph.itemId] = (pc[ph.itemId] || 0) + 1; });
  const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['図面', ...FIELDS.map((f) => f.label), '写真枚数', '登録日時', '更新日時'];
  const rows = items
    .sort((a, b) => natural(dn[a.drawingId], dn[b.drawingId]) || natural(a.code, b.code))
    .map((i) => [dn[i.drawingId], ...FIELDS.map((f) => (f.status ? statusOf(i.status).label : i[f.k])), pc[i.id] || 0, fmtDate(i.createdAt), fmtDate(i.updatedAt)]);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  await shareOrDownload(new Blob([csv], { type: 'text/csv' }), `${p.name}_一覧_${dateStamp()}.csv`);
}

const dateStamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };
const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });

async function exportBackup(project) {
  try {
    toast('バックアップを作成中…', 0);
    const out = { app: 'genba-pin', version: 1, exportedAt: Date.now(), data: {} };
    for (const s of ['projects', 'drawings', 'items', 'photos']) {
      let rows = await db.all(s);
      if (project) rows = rows.filter((r) => (s === 'projects' ? r.id === project.id : r.projectId === project.id));
      out.data[s] = [];
      for (const r of rows) {
        const o = { ...r };
        for (const k of ['_etag', '_dirty', '_blobDone', 'cloud']) delete o[k];
        for (const k of ['blob', 'thumb']) if (o[k] instanceof Blob) o[k] = { __blob: await blobToDataUrl(o[k]) };
        out.data[s].push(o);
      }
    }
    const name = `${project ? project.name : '現場ピン全データ'}_backup_${dateStamp()}.json`;
    toast('保存先を選んでください');
    await shareOrDownload(new Blob([JSON.stringify(out)], { type: 'application/json' }), name);
  } catch (e) {
    toast(`バックアップに失敗しました: ${e.message}`, 5000);
  }
}

async function importBackup() {
  const [f] = await pickFiles({ accept: 'application/json,.json' });
  if (!f) return;
  try {
    toast('読み込み中…', 0);
    const json = JSON.parse(await f.text());
    if (json.app !== 'genba-pin' || !json.data) throw new Error('このアプリのバックアップファイルではありません');
    const n = json.data.projects?.length || 0;
    if (!(await confirmSheet(`${n} 件の現場を復元します。同じデータがある場合は上書きされます。`, '復元する'))) return toast('', 1);
    for (const s of ['projects', 'drawings', 'items', 'photos']) {
      const rows = [];
      for (const r of json.data[s] || []) {
        for (const k of ['blob', 'thumb']) if (r[k]?.__blob) r[k] = await (await fetch(r[k].__blob)).blob();
        rows.push(r);
      }
      await db.putMany(s, rows);
    }
    toast('復元しました');
    route();
  } catch (e) {
    toast(`復元に失敗しました: ${e.message}`, 5000);
  }
}

// ============================================================
// 削除（関連データもまとめて）
// ============================================================
async function deleteItem(id) {
  for (const ph of await db.by('photos', 'itemId', id)) await db.del('photos', ph.id);
  await db.del('items', id);
}
async function deleteDrawing(id) {
  for (const i of await db.by('items', 'drawingId', id)) await deleteItem(i.id);
  drawingImgCache.delete(id);
  await db.del('drawings', id);
}
async function deleteProject(id, { localOnly = false } = {}) {
  if (localOnly) {
    // OneDrive 側は消さずに、この端末のデータだけ削除
    for (const s of ['photos', 'items', 'drawings', 'tombstones']) {
      for (const r of await db.by(s, 'projectId', id)) await db.delRaw(s, r.id);
    }
    await db.delRaw('projects', id);
    return;
  }
  for (const d of await db.by('drawings', 'projectId', id)) await deleteDrawing(d.id);
  for (const i of await db.by('items', 'projectId', id)) await deleteItem(i.id);
  await db.del('projects', id);
}

// ============================================================
// OneDrive 連携の画面
// ============================================================
const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function cloudText() {
  if (!cloud.isConfigured()) return '';
  const acc = cloud.account();
  if (!acc) return '☁ OneDrive にログインすると、チームで現場を共有できます';
  const s = cloud.status;
  const t = {
    syncing: '同期中…',
    ok: `同期済み ${s.at ? hhmm(s.at) : ''}`,
    idle: '接続済み',
    offline: 'オフライン（電波が戻ると自動で送信します）',
    login: '⚠ 再ログインが必要です（タップ）',
    error: '⚠ 同期エラー（タップで詳細）',
  }[s.state] || '';
  return `☁ OneDrive: ${esc(acc.name || acc.mail || '')} ・ ${t}`;
}
const cloudLineHtml = () => (cloud.isConfigured() ? `<button class="cloud-line" id="cloudLine">${cloudText()}</button>` : '');
document.addEventListener('click', (e) => { if (e.target.closest('#cloudLine')) cloudMenu(); });

async function syncNow() {
  if (!cloud.hasSession()) return cloudMenu();
  toast('同期中…', 0);
  await cloud.syncAll();
  const s = cloud.status;
  toast(s.state === 'ok' ? '同期しました' : s.msg || '同期できませんでした', s.state === 'ok' ? 2000 : 5000);
}

async function cloudMenu() {
  if (!cloud.isConfigured()) return toast('OneDrive 連携は準備中です', 3000);
  const acc = cloud.account();
  if (!acc || !cloud.hasSession()) {
    const a = await actionSheet(
      acc ? 'ログインの有効期限が切れました。もう一度ログインしてください。' : 'OneDrive にログインすると、現場を OneDrive に保存してチームで共有できます。',
      [{ label: 'Microsoft アカウントでログイン', value: 'login' }],
    );
    if (a === 'login') cloud.login().catch((e) => toast(e.message, 5000));
    return;
  }
  if (cloud.status.state === 'error' && cloud.status.msg) toast(cloud.status.msg, 6000);
  const a = await actionSheet(`${acc.name || ''}${acc.mail ? `（${acc.mail}）` : ''}`, [
    { label: '今すぐ同期', value: 'sync' },
    { label: 'OneDrive の現場を開く', value: 'open' },
    { label: '共有リンクから現場を追加', value: 'link' },
    { label: 'ログアウト', value: 'logout', danger: true },
  ]);
  if (a === 'sync') syncNow();
  if (a === 'open') openCloudPicker();
  if (a === 'link') {
    const v = await formSheet('共有リンクから追加', [{ k: 'url', label: 'OneDrive の共有リンク（フォルダ）', ph: 'https://...' }], '追加');
    if (!v?.url?.trim()) return;
    try {
      toast('読み込み中…', 0);
      const id = await cloud.openCloudProject(await cloud.resolveShareLink(v.url));
      toast('追加しました');
      go(`#/p/${id}`);
    } catch (e) {
      toast(e.message, 5000);
    }
  }
  if (a === 'logout') {
    if (!(await confirmSheet('ログアウトします。OneDrive の現場はこの端末に残りますが、同期は止まります。', 'ログアウト'))) return;
    cloud.logout();
    route();
  }
}

async function openCloudPicker() {
  toast('OneDrive を確認中…', 0);
  let list;
  try { list = await cloud.listCloudProjects(); } catch (e) { return toast(e.message, 5000); }
  const linked = new Set((await db.all('projects')).filter((p) => p.cloud).map((p) => p.cloud.folderId));
  const cands = list.filter((e) => !linked.has(e.folderId));
  if (!cands.length) return toast('追加できる現場はありません（すべてこの端末にあります）', 3500);
  toast('', 1);
  const e = await actionSheet('開く現場を選んでください（👥 は共有された現場）', cands.map((c) => ({
    label: `${c.shared ? '👥 ' : ''}${c.name}${c.owner ? `（${c.owner}）` : ''}`, value: c,
  })));
  if (!e) return;
  try {
    toast('ダウンロード中…', 0);
    const id = await cloud.openCloudProject(e);
    toast('追加しました');
    go(`#/p/${id}`);
  } catch (err) {
    toast(err.message, 5000);
  }
}

// ============================================================
// 起動
// ============================================================
document.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('hashchange', route);

cloud.setThumbMaker(async (blob, max) => (await resizeToBlob(await loadImageFromBlob(blob), max, 'image/jpeg', 0.8)).blob);
cloud.onStatus(() => { const el = document.getElementById('cloudLine'); if (el) el.innerHTML = cloudText(); });
cloud.onRemoteChange(() => {
  if (sheetRoot.children.length || document.querySelector('.photo-view')) return; // 操作中は画面を変えない
  if (viewRefresh) viewRefresh(); else route();
});
(async () => {
  try {
    if (await cloud.handleRedirect()) toast('OneDrive にログインしました', 3000);
  } catch (e) {
    toast(`ログインできませんでした: ${e.message}`, 6000);
  }
  cloud.startAutoSync();
  route();
  cloud.syncAll();
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // 新しいバージョンが入ったら自動で再読み込み（初回インストール時は除く）
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !window.__reloading) { window.__reloading = true; location.reload(); }
  });
  navigator.serviceWorker.register('./sw.js').then((r) => r.update()).catch((e) => console.warn('SW登録失敗', e));
}

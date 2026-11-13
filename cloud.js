// OneDrive 連携（Microsoft Graph / サインインは PKCE 方式）
//
// OneDrive 上の保存形式（1現場 = 1フォルダ）:
//   現場ピン/<現場名>/project.json
//                    drawings/<id>.json, <id>.jpg
//                    items/<id>.json
//                    photos/<id>.json, <id>.jpg
// 項目ごとにファイルを分けるので、複数人が別々の扉を同時に編集しても衝突しない。
// 同じ項目を同時に編集した場合は、あとから編集した方（_mtime が新しい方）が残る。
import * as db from './db.js';

// Microsoft Entra（Azure）に登録したアプリの「アプリケーション (クライアント) ID」
export const CLIENT_ID = '';

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても続行 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
};
// 開発・テスト用の差し替え（通常は使わない）
const cfg = {
  clientId: ls.get('genba.dev.clientId') || CLIENT_ID,
  authBase: ls.get('genba.dev.authBase') || 'https://login.microsoftonline.com/common/oauth2/v2.0',
  graph: ls.get('genba.dev.graphBase') || 'https://graph.microsoft.com/v1.0',
};
const SCOPES = 'openid profile offline_access User.Read Files.ReadWrite.All';
const ROOT_NAME = '現場ピン';
const SUBS = ['drawings', 'items', 'photos'];
const BLOB_STORES = new Set(['drawings', 'photos']);
const LOCAL_KEYS = new Set(['blob', 'thumb', '_etag', '_dirty', '_blobDone', 'cloud']);
const K_TOKEN = 'genba.od.token';
const K_ME = 'genba.od.me';
const K_PKCE = 'genba.od.pkce';

export class NeedLogin extends Error {
  constructor() { super('OneDrive に再ログインしてください'); this.needLogin = true; }
}

// ------------------------------------------------------------
// サインイン
// ------------------------------------------------------------
const redirectUri = () => location.origin + location.pathname;
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randStr(n = 32) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
async function challenge(v) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))); }

const loadTok = () => { try { return JSON.parse(ls.get(K_TOKEN) || 'null'); } catch { return null; } };
const saveTok = (t) => ls.set(K_TOKEN, JSON.stringify(t));

export const isConfigured = () => !!cfg.clientId;
export const account = () => { try { return JSON.parse(ls.get(K_ME) || 'null'); } catch { return null; } };
export function hasSession() { const t = loadTok(); return !!(t && (t.refresh || t.exp > Date.now())); }

export async function login() {
  if (!isConfigured()) throw new Error('OneDrive 連携の設定がまだ完了していません');
  const verifier = randStr(48);
  const state = randStr(16);
  ls.set(K_PKCE, JSON.stringify({ verifier, state, hash: location.hash }));
  const u = new URL(cfg.authBase + '/authorize');
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });
  location.assign(u.toString());
}

// サインイン画面から戻ってきたときの処理。戻りでなければ false
export async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return false;
  let saved = null;
  try { saved = JSON.parse(ls.get(K_PKCE) || 'null'); } catch { /* noop */ }
  ls.del(K_PKCE);
  history.replaceState(null, '', redirectUri() + (saved?.hash || ''));
  if (p.has('error')) throw new Error(p.get('error_description') || p.get('error'));
  if (!saved || saved.state !== p.get('state')) throw new Error('ログインをやり直してください（状態が一致しません）');
  await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), code_verifier: saved.verifier, redirect_uri: redirectUri() });
  const me = await g('/me?$select=displayName,mail,userPrincipalName');
  ls.set(K_ME, JSON.stringify({ name: me.displayName, mail: me.mail || me.userPrincipalName }));
  return true;
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: cfg.clientId, scope: SCOPES, ...params });
  const r = await fetch(cfg.authBase + '/token', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `サインインに失敗しました (${r.status})`);
  const old = loadTok();
  saveTok({ access: j.access_token, refresh: j.refresh_token || old?.refresh || null, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 });
}

let refreshing = null;
async function getToken(force = false) {
  const t = loadTok();
  if (!t) return null;
  if (!force && t.access && t.exp > Date.now()) return t.access;
  if (!t.refresh) return null;
  refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })
    .then(() => loadTok().access)
    .catch((e) => {
      console.warn('トークン更新失敗', e);
      saveTok({ access: null, refresh: null, exp: 0 });
      return null;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export function logout() { ls.del(K_TOKEN); ls.del(K_ME); setStatus('off'); }

// ------------------------------------------------------------
// Microsoft Graph 呼び出し
// ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => encodeURIComponent(s);
const JSON_HDR = { 'Content-Type': 'application/json' };

async function g(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const url = path.startsWith('http') ? path : cfg.graph + path;
  let force = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const tok = await getToken(force);
    force = false;
    if (!tok) throw new NeedLogin();
    let r;
    try {
      r = await fetch(url, { method, body, headers: { Authorization: 'Bearer ' + tok, ...headers } });
    } catch (e) {
      const err = new Error('OneDrive に接続できません（電波を確認してください）');
      err.offline = true;
      throw err;
    }
    if (r.status === 401 && attempt === 0) { force = true; continue; }
    if (r.status === 429 || r.status === 503 || r.status === 504) {
      await sleep(Math.min(30, +r.headers.get('Retry-After') || 2 ** attempt) * 1000);
      continue;
    }
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).error?.message || ''; } catch { /* noop */ }
      const e = new Error(msg || `OneDrive エラー (${r.status})`);
      e.status = r.status;
      throw e;
    }
    if (raw) return r;
    if (r.status === 204) return null;
    return r.json();
  }
  throw new Error('OneDrive が混み合っています。しばらくしてから再度お試しください');
}

async function listAll(driveId, folderId) {
  const out = [];
  let url = `/drives/${driveId}/items/${folderId}/children?$top=999`;
  while (url) {
    const j = await g(url);
    out.push(...(j.value || []));
    url = j['@odata.nextLink'];
  }
  return out;
}

async function download(driveId, item) {
  const direct = item['@microsoft.graph.downloadUrl'];
  if (direct) {
    const r = await fetch(direct);
    if (r.ok) return r;
  }
  return g(`/drives/${driveId}/items/${item.id}/content`, { raw: true });
}

const upload = (driveId, folderId, name, body, type) =>
  g(`/drives/${driveId}/items/${folderId}:/${enc(name)}:/content`, { method: 'PUT', headers: { 'Content-Type': type }, body });

async function removeByName(driveId, folderId, name) {
  try { await g(`/drives/${driveId}/items/${folderId}:/${enc(name)}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
}

async function ensureFolder(driveId, parentId, name) {
  try { return await g(`/drives/${driveId}/items/${parentId}:/${enc(name)}`); } catch (e) { if (e.status !== 404) throw e; }
  return g(`/drives/${driveId}/items/${parentId}/children`, {
    method: 'POST', headers: JSON_HDR,
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
}

async function myRoot() {
  const drive = await g('/me/drive?$select=id');
  const root = await g('/me/drive/root?$select=id');
  const f = await ensureFolder(drive.id, root.id, ROOT_NAME);
  return { driveId: drive.id, id: f.id };
}

async function prepareFolders(driveId, folderId) {
  const sub = {};
  for (const s of SUBS) sub[s] = (await ensureFolder(driveId, folderId, s)).id;
  return sub;
}

const safeName = (s) => (String(s).replace(/[\\/:*?"<>|#%]/g, '_').trim() || '現場').slice(0, 100);
const toRemote = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !LOCAL_KEYS.has(k)));

// ------------------------------------------------------------
// 現場とフォルダの結び付け
// ------------------------------------------------------------
async function markAllDirty(pid) {
  for (const s of ['projects', ...SUBS]) {
    const rows = s === 'projects' ? [await db.get('projects', pid)] : await db.by(s, 'projectId', pid);
    for (const r of rows) {
      if (!r) continue;
      r._dirty = true;
      r._mtime ||= Date.now();
      delete r._etag;
      delete r._blobDone;
      await db.putRaw(s, r);
    }
  }
}

// 端末の現場を自分の OneDrive に保存して同期を始める
export async function linkProject(pid) {
  const p = await db.get('projects', pid);
  const root = await myRoot();
  const f = await g(`/drives/${root.driveId}/items/${root.id}/children`, {
    method: 'POST', headers: JSON_HDR,
    body: JSON.stringify({ name: safeName(p.name), folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
  });
  const sub = await prepareFolders(root.driveId, f.id);
  p.cloud = { provider: 'onedrive', driveId: root.driveId, folderId: f.id, sub, webUrl: f.webUrl || '' };
  await db.putRaw('projects', p);
  await markAllDirty(pid);
  await syncAll();
}

// OneDrive 上の現場（自分のもの + 共有されたもの）の一覧
export async function listCloudProjects() {
  const out = [];
  const root = await myRoot();
  for (const f of await listAll(root.driveId, root.id)) {
    if (f.folder) out.push({ name: f.name, driveId: root.driveId, folderId: f.id, shared: false });
  }
  try {
    const j = await g('/me/drive/sharedWithMe');
    for (const it of j.value || []) {
      const ri = it.remoteItem || it;
      if (!ri.folder || !ri.parentReference?.driveId) continue;
      out.push({
        name: ri.name || it.name, driveId: ri.parentReference.driveId, folderId: ri.id, shared: true,
        owner: ri.shared?.owner?.user?.displayName || ri.createdBy?.user?.displayName || '',
      });
    }
  } catch (e) {
    console.warn('共有アイテムの取得に失敗', e);
  }
  return out;
}

// OneDrive の共有リンク（https://...）から現場フォルダを特定
export async function resolveShareLink(url) {
  const id = 'u!' + btoa(unescape(encodeURIComponent(url.trim()))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const it = await g(`/shares/${id}/driveItem`);
  if (!it.folder) throw new Error('フォルダの共有リンクを貼り付けてください');
  return { name: it.name, driveId: it.parentReference.driveId, folderId: it.id, shared: true };
}

// OneDrive の現場フォルダをこの端末に取り込む（以後は自動同期）
export async function openCloudProject(entry) {
  const files = await listAll(entry.driveId, entry.folderId);
  const pj = files.find((f) => f.name === 'project.json');
  if (!pj) throw new Error('このフォルダは「現場ピン」の現場ではありません');
  const remote = await (await download(entry.driveId, pj)).json();
  const sub = await prepareFolders(entry.driveId, entry.folderId);
  const webUrl = (await g(`/drives/${entry.driveId}/items/${entry.folderId}?$select=webUrl`).catch(() => ({}))).webUrl || '';
  const existing = await db.get('projects', remote.id);
  await db.putRaw('projects', {
    ...(existing || {}), ...remote,
    cloud: { provider: 'onedrive', driveId: entry.driveId, folderId: entry.folderId, sub, webUrl },
    _etag: pj.eTag, _dirty: false,
  });
  await syncAll();
  return remote.id;
}

// ------------------------------------------------------------
// 同期
// ------------------------------------------------------------
let thumbMaker = async (blob) => blob;
export function setThumbMaker(fn) { thumbMaker = fn; }

const statusListeners = new Set();
export const status = { state: 'off', at: 0, msg: '' };
function setStatus(state, msg = '') {
  Object.assign(status, { state, msg }, state === 'ok' ? { at: Date.now() } : {});
  statusListeners.forEach((fn) => { try { fn(status); } catch (e) { console.error(e); } });
}
export function onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }

const changeListeners = new Set();
export function onRemoteChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }

async function syncProject(pid) {
  let p = await db.get('projects', pid);
  const c = p?.cloud;
  if (!c) return false;
  let changed = false;

  // 1) 削除の反映
  for (const t of await db.by('tombstones', 'projectId', pid)) {
    const folder = c.sub[t.store];
    if (folder) {
      await removeByName(c.driveId, folder, t.id + '.json');
      if (BLOB_STORES.has(t.store)) await removeByName(c.driveId, folder, t.id + '.jpg');
    }
    await db.delRaw('tombstones', t.id);
  }

  // 2) この端末の変更を送信
  const push = async (s, rec, folder, name) => {
    if (BLOB_STORES.has(s) && !rec._blobDone && rec.blob) {
      await upload(c.driveId, folder, rec.id + '.jpg', rec.blob, 'image/jpeg');
    }
    const res = await upload(c.driveId, folder, name, new Blob([JSON.stringify(toRemote(rec))], { type: 'application/json' }), 'application/json');
    const cur = await db.get(s, rec.id);
    if (!cur) return;
    cur._etag = res.eTag;
    cur._blobDone = true;
    if (cur._mtime === rec._mtime) cur._dirty = false;
    await db.putRaw(s, cur);
  };
  if (p._dirty) await push('projects', p, c.folderId, 'project.json');
  for (const s of SUBS) {
    for (const r of await db.by(s, 'projectId', pid)) if (r._dirty) await push(s, r, c.sub[s], r.id + '.json');
  }

  // 3) 他の人の変更を受信
  const take = (loc, remote) => !loc || !loc._dirty || (remote._mtime || 0) > (loc._mtime || 0);

  const top = await listAll(c.driveId, c.folderId);
  const pj = top.find((f) => f.name === 'project.json');
  p = await db.get('projects', pid);
  if (pj && pj.eTag !== p._etag) {
    const remote = await (await download(c.driveId, pj)).json();
    if (take(p, remote)) {
      await db.putRaw('projects', { ...remote, cloud: p.cloud, _etag: pj.eTag, _dirty: false });
      changed = true;
    }
  }

  for (const s of SUBS) {
    const files = await listAll(c.driveId, c.sub[s]);
    const byName = new Map(files.map((f) => [f.name, f]));
    const locals = new Map((await db.by(s, 'projectId', pid)).map((r) => [r.id, r]));
    for (const f of files) {
      if (!f.name.endsWith('.json')) continue;
      const id = f.name.slice(0, -5);
      const loc = locals.get(id);
      if (loc && loc._etag === f.eTag) continue;
      const remote = await (await download(c.driveId, f)).json();
      if (!take(loc, remote)) continue;
      const rec = { ...remote, _etag: f.eTag, _dirty: false, _blobDone: true };
      if (BLOB_STORES.has(s)) {
        if (loc?.blob) {
          rec.blob = loc.blob;
          rec.thumb = loc.thumb;
        } else {
          const bf = byName.get(id + '.jpg');
          if (!bf) continue; // 画像の送信がまだ終わっていない → 次回
          const b = await (await download(c.driveId, bf)).blob();
          rec.blob = new Blob([b], { type: 'image/jpeg' });
          rec.thumb = await thumbMaker(rec.blob, s === 'drawings' ? 480 : 360);
        }
      }
      await db.putRaw(s, rec);
      changed = true;
    }
    // 他の人が削除したもの
    for (const loc of locals.values()) {
      if (loc._etag && !loc._dirty && !byName.has(loc.id + '.json')) {
        await db.delRaw(s, loc.id);
        changed = true;
      }
    }
  }
  return changed;
}

let running = null;
let again = false;
export function syncAll() {
  if (!hasSession() || !isConfigured()) return Promise.resolve(false);
  if (running) { again = true; return running; }
  running = (async () => {
    let changed = false;
    do {
      again = false;
      setStatus('syncing');
      try {
        const projects = (await db.all('projects')).filter((p) => p.cloud?.provider === 'onedrive');
        const errors = [];
        for (const p of projects) {
          try {
            if (await syncProject(p.id)) changed = true;
          } catch (e) {
            if (e.needLogin || e.offline) throw e;
            console.error(e);
            errors.push(`${p.name}: ${e.status === 403 ? '書き込み権限がありません' : e.message}`);
          }
        }
        setStatus(errors.length ? 'error' : 'ok', errors.join(' / '));
      } catch (e) {
        console.warn(e);
        setStatus(e.needLogin ? 'login' : e.offline ? 'offline' : 'error', e.message);
        again = false;
      }
    } while (again);
    if (changed) changeListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    return changed;
  })().finally(() => { running = null; });
  return running;
}

// 自動同期: 変更の数秒後 / 30秒ごと / アプリに戻ってきたとき
let pushTimer = null;
export function startAutoSync() {
  if (startAutoSync.started) return;
  startAutoSync.started = true;
  db.onChange(() => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => syncAll(), 2500);
  });
  setInterval(() => { if (document.visibilityState === 'visible') syncAll(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(); });
  window.addEventListener('online', () => syncAll());
  if (hasSession()) setStatus('idle');
  else if (account()) setStatus('login');
}

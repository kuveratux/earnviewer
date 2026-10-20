'use strict';

// Manager・Agent 共通の土台（データの読み込み・復号・Google ドライブ・表示と配色・更新・タブ）
// データは利用者が操作したときだけ読み込む（ファイルを選ぶ、または Google ドライブから取得）。自動では取りに行かない。
// データ・合言葉・設定は、すべて端末内の IndexedDB（app-config.js の db）だけに保存する。
// 画面ごとの表示は各アプリの app.js が ESV.start({ render, describe }) で渡す。

const APP = self.ESV_APP;
const $ = (id) => document.getElementById(id);

let data = null;     // 読み込んだデータ（復号後）
let dataMeta = null; // { fileName, source, importedAt }
let ranks = { old: null, new: null }; // ランク表（旧・新）：{ ranks, startDate, generatedAt, fileName }
let hooks = { render() {}, describe() { return ''; } };

//--------------------------------------------------------------
// 表示用の小道具
//--------------------------------------------------------------
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const fmtAmount = (n) => Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 6 });
const fmtDate = (unix) => new Date(unix * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDay = (unix) => new Date(unix * 1000).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtJst = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
const fmtMonth = (m) => m.replace(/^(\d{4})-0?(\d+)$/, '$1年$2月');

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function kvRows(rows) {
  return rows.flatMap(([k, v]) => [el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)]);
}

//--------------------------------------------------------------
// 端末内の保存（IndexedDB。名前はアプリごとに別）
//--------------------------------------------------------------
const STORE = 'dataset';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(APP.db, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRun(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

const getSetting = (key) => dbRun('readonly', (s) => s.get(key));
const putSetting = (key, value) => dbRun('readwrite', (s) => s.put(value, key));
const delSetting = (key) => dbRun('readwrite', (s) => s.delete(key));

//--------------------------------------------------------------
// データファイル：読み込み・復号・保存
//--------------------------------------------------------------
// EARN VIEWER は招待で受け取る（ESV の Agent アプリと同じ流れ）
const RECEIVE = true;
const DATA_FORMAT = 'ev-data';
const DATA_VERSION = 1;

// データ（ev-data version 1）：1人分。ランク表（旧・新・新ランク表の開始日）と手元の残高（wallet）がデータの中にある
function validateData(d) {
  if (d && d.format === 'esv-data') throw new Error('EARN SPLIT VIEWER（ESV）のデータファイルです。EARN VIEWER のデータファイルを選んでください');
  if (!d || d.format !== DATA_FORMAT || !d.generatedAt) throw new Error('EARN VIEWER のデータファイルではありません');
  if (d.version !== DATA_VERSION) throw new Error('このアプリでは読めない版のデータファイルです（version ' + d.version + '）。アプリを更新するか、データを作り直してください');
  const r = d.ranks;
  if (!r || !Array.isArray(r.old) || !r.old.length || !Array.isArray(r.new) || !r.new.length || !/^\d{4}-\d{2}-\d{2}$/.test(r.newStartDate || '')) throw new Error('データファイルのランク表の形式が違います');
  if (!d.holder || !/^0x[0-9a-f]{40}$/.test(d.holder.address || '')) throw new Error('データファイルの形式が違います（配布先のアドレスがありません）');
  if (!d.wallet || !Number.isFinite(Number(d.wallet.amount))) throw new Error('データファイルの形式が違います（手元の残高がありません）');
  if (!Array.isArray(d.transfers)) throw new Error('データファイルの形式が違います（transfers がありません）');
  return d;
}

function validateRank(d) {
  if (d.version !== 2 || !['old', 'new'].includes(d.kind) || !Array.isArray(d.ranks) || !d.ranks.length) throw new Error('ランク表の形式が違います');
  if (d.kind === 'new' && !/^\d{4}-\d{2}-\d{2}$/.test(d.startDate || '')) throw new Error('新ランク表に開始日がありません');
  return d;
}

// 暗号化ファイルの復号（取得プログラムと同じ方式：PBKDF2-SHA256 → AES-256-GCM）
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decryptData(enc, passphrase) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: enc.kdf.hash, salt: b64(enc.kdf.salt), iterations: enc.kdf.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.cipher.iv) }, key, b64(enc.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

function askPassphrase() {
  return new Promise((resolve) => {
    const dlg = $('passDlg');
    $('passInput').value = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? { pass: $('passInput').value, save: $('passSave').checked } : null), { once: true });
    dlg.showModal();
  });
}

// 暗号化されていれば復号する。保存済みの合言葉を先に試し、だめなら入力を求める。キャンセル時は null
async function decryptIfNeeded(json) {
  if (json.format !== 'esv-data-enc') return json;
  const saved = await getSetting('passphrase');
  if (saved) {
    try { return await decryptData(json, saved); } catch { /* 合言葉が変わった → 入力を求める */ }
  }
  for (;;) {
    const r = await askPassphrase();
    if (r == null) return null;
    $('status').textContent = '復号中…';
    try {
      const plain = await decryptData(json, r.pass);
      if (r.save) await putSetting('passphrase', r.pass);
      else await delSetting('passphrase');
      return plain;
    } catch {
      $('status').textContent = '';
      if (!confirm('合言葉が違うか、ファイルが壊れています。もう一度入力しますか？')) return null;
    }
  }
}

async function loadSavedData() {
  const saved = await getSetting('current');
  if (saved && saved.data && saved.data.format === DATA_FORMAT && saved.data.version === DATA_VERSION) { data = saved.data; dataMeta = saved.meta; }
  ranks.old = (await getSetting('rankOld')) || null;
  ranks.new = (await getSetting('rankNew')) || null;
}

const RANK_LABEL = { old: '旧ランク表', new: '新ランク表' };
let lastImportKind = null; // 直前に読み込んだファイルの種類（'data' | 'rankOld' | 'rankNew'）。ドライブのファイルを枠に振り分けるのに使う

// 読み込んだ文字列（暗号化されていれば復号）を、データかランク表かを見分けて保存する
// 戻り値：表示するメッセージ。キャンセル時は null。失敗時は例外
async function importText(text, fileName, source) {
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('JSON 形式のファイルではありません'); }
  json = await decryptIfNeeded(json);
  if (!json) return null;

  if (json.format === 'esv-rank') {
    validateRank(json);
    lastImportKind = json.kind === 'old' ? 'rankOld' : 'rankNew';
    const cur = ranks[json.kind];
    if (cur && source === 'drive' && cur.generatedAt === json.generatedAt) return RANK_LABEL[json.kind] + 'は最新です';
    ranks[json.kind] = { ranks: json.ranks, startDate: json.startDate || '', generatedAt: json.generatedAt, fileName, importedAt: new Date().toISOString() };
    await putSetting(json.kind === 'old' ? 'rankOld' : 'rankNew', ranks[json.kind]);
    refreshAll();
    return RANK_LABEL[json.kind] + 'を読み込みました（' + json.ranks.length + ' ランク' + (json.startDate ? '、開始日 ' + json.startDate : '') + '）';
  }

  validateData(json);
  lastImportKind = 'data';
  if (data && source === 'drive' && json.generatedAt === data.generatedAt) {
    return 'データは最新です（作成：' + fmtJst(json.generatedAt) + '）';
  }
  const meta = { fileName, source, importedAt: new Date().toISOString() };
  // データの中のランク表を、ESV と同じ保存場所（rankOld・rankNew）に入れる（報酬の計算はそのまま）
  const at = { generatedAt: json.generatedAt, fileName, importedAt: meta.importedAt };
  ranks.old = { ranks: json.ranks.old, startDate: '', ...at };
  ranks.new = { ranks: json.ranks.new, startDate: json.ranks.newStartDate, ...at };
  await putSetting('rankOld', ranks.old);
  await putSetting('rankNew', ranks.new);
  await putSetting('current', { data: json, meta });
  if (typeof applyDisplay === 'function') await applyDisplay(json); // 画像・Community（変わったものだけ入れ替える）
  data = json;
  dataMeta = meta;
  refreshAll();
  return 'データを読み込みました（取引 ' + data.transfers.length + ' 件）';
}

// ファイルから読み込む（データ・ランク表のどれでも。まとめて選べる）
document.querySelectorAll('.dataFile').forEach((input) => input.addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const msgs = [];
  for (const file of files) {
    try {
      const msg = await importText(await file.text(), file.name, 'file');
      if (msg) msgs.push(msg);
    } catch (err) {
      msgs.push(file.name + '：読み込めませんでした（' + err.message + '）');
    }
  }
  showStatus();
  if (msgs.length) alert(msgs.join('\n'));
}));

//--------------------------------------------------------------
// Google ドライブから最新データを取得
//--------------------------------------------------------------
let driveBusy = false;

// ドライブのファイルは、データの1つだけを覚える（'driveSlots' の data）。1.3 から、ランク表はデータの中に入っている
// （以前は データ・旧ランク表・新ランク表 の3つの枠。旧・新の枠の記録は、取得のときに消す）
const SLOTS = [
  { key: 'data', label: () => 'データ', hint: () => APP.filePrefix + '…_latest.json' },
];
const OLD_SLOT_KEYS = ['rankOld', 'rankNew'];
// 以前のランク表のファイル（esv_*_rank_old/new.json）。選ばれたら開く前に断る（中身が古いまま残っているため）
const isRankFileName = (name) => /_rank_(old|new)\b/i.test(String(name || ''));
const slotOf = (key) => SLOTS.find((x) => x.key === key);

// ファイル名に、このアプリの名前（manager / agent）が入っているか。入っていなければ開く前に断る
// （他方の合言葉で暗号化されたファイルを開こうとして、合言葉を聞かれたり、保存した合言葉が置き換わったりしないように）
const nameFits = (name) => String(name || '').toLowerCase().startsWith(APP.filePrefix);
const nameError = (name) => '「' + name + '」は EARN VIEWER のファイルではないようです（ファイル名が ' + APP.filePrefix + ' で始まっていません）。' +
  'EARN VIEWER のデータのファイル（' + APP.filePrefix + '…_latest.json）を選んでください。'
const rankFileError = (name) => '「' + name + '」はランク表のファイルです。ランク表はデータに入っているので、データのファイル（' + APP.filePrefix + '…_latest.json）を選んでください。'

async function getSlots() {
  return (await getSetting('driveSlots')) || {};
}

// ファイルを1つ取得して読み込む。戻り値：{ msg, kind }。失敗時は例外
async function driveImportOne(file) {
  const { meta, text } = await Drive.download(file.id);
  lastImportKind = null;
  const msg = await importText(text, meta.name, 'drive');
  return { msg, kind: lastImportKind, name: meta.name };
}

// 1つの枠のファイルを選んで読み込む。キャンセル時は null
async function pickSlot(key, msgs) {
  const slot = slotOf(key);
  $('status').textContent = slot.label() + 'を選択中…';
  const picked = await Drive.pick(slot.label() + 'のファイル（' + slot.hint() + '）を選んでください', false, APP.filePrefix);
  if (!picked || !picked.length) return null;
  const file = picked[0];
  if (!nameFits(file.name)) { msgs.push(nameError(file.name)); return 'cancel'; }
  if (isRankFileName(file.name)) { msgs.push(rankFileError(file.name)); return 'cancel'; }
  $('status').textContent = slot.label() + 'を取得中…';
  const r = await driveImportOne(file);
  if (!r.kind) return 'cancel'; // 合言葉の入力をやめた
  const slots = await getSlots();
  if (r.kind !== 'data') { if (r.msg) msgs.push(r.msg); return 'cancel'; } // 枠はデータだけ（ここには来ない想定）
  slots.data = { id: file.id, name: r.name };
  await putSetting('driveSlots', slots);
  if (r.msg) msgs.push(r.msg);
  return r.kind;
}

// pickKey：選び直す枠（省略時は、覚えている枠を取得し、足りない枠を1つずつ選ばせる）
async function fetchFromDrive(pickKey) {
  if (driveBusy) return;
  if (!Drive.configured()) { alert('Google ドライブの連携が設定されていません。'); return; }
  // ログイン画面は、ほかの処理より先に開く（iPhone の Safari で開けなくならないように）
  let auth = null;
  try { auth = Drive.authorizeNow(); } catch { auth = null; }
  driveBusy = true;
  const msgs = [];
  try {
    $('status').textContent = '準備中…';
    const loadedNow = await Drive.ensureLoaded();
    if (auth) { $('status').textContent = 'ログイン中…'; await auth; }
    else if (loadedNow) $('status').textContent = '準備ができました…';
    await delSetting('driveFiles'); // 以前の「まとめて選ぶ」形の記録は使わない
    if (pickKey) {
      await pickSlot(pickKey, msgs);
    } else {
      // 覚えている枠を取得（以前の旧・新ランク表の枠の記録は消す）
      const slots = await getSlots();
      if (OLD_SLOT_KEYS.some((k) => slots[k])) { OLD_SLOT_KEYS.forEach((k) => delete slots[k]); await putSetting('driveSlots', slots); }
      for (const slot of SLOTS) {
        const file = slots[slot.key];
        if (!file) continue;
        if (!nameFits(file.name)) {
          // 以前に選んだ、名前の合わないファイル（例：名前を分ける前の esv_rank_old.json）は外して選び直してもらう
          delete slots[slot.key];
          await putSetting('driveSlots', slots);
          msgs.push(slot.label() + '：' + nameError(file.name));
          continue;
        }
        $('status').textContent = slot.label() + 'を取得中…';
        try {
          const r = await driveImportOne(file);
          if (r.msg) msgs.push(r.msg);
          if (r.name !== file.name) { slots[slot.key] = { id: file.id, name: r.name }; await putSetting('driveSlots', slots); }
        } catch (err) {
          if (err.repick) { delete slots[slot.key]; await putSetting('driveSlots', slots); }
          msgs.push(file.name + '：' + err.message);
          if (err.retry) return; // ログインからやり直し（finally でメッセージを出す）
        }
      }
      // 足りない枠を1つずつ選ぶ（キャンセルしたらそこでやめる）
      for (let guard = 0; guard < 6; guard++) {
        const cur = await getSlots();
        const missing = SLOTS.find((x) => !cur[x.key]);
        if (!missing) break;
        if (!confirm(missing.label() + 'のファイルがまだ選ばれていません。今選びますか？')) break;
        const r = await pickSlot(missing.key, msgs);
        if (!r || r === 'cancel') break;
      }
    }
  } catch (err) {
    msgs.push(err.message);
  } finally {
    driveBusy = false;
    renderDriveInfo();
    showStatus();
    if (msgs.length) alert(msgs.join('\n'));
  }
}

// 読み込んであるデータ・ランク表の作成日時と読み込み日時（ドライブの欄のファイル名の下に出す）
const fmtShortJst = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function slotTimes(key) {
  const x = key === 'data' ? (data && dataMeta ? { g: data.generatedAt, i: dataMeta.importedAt } : null)
    : key === 'rankOld' ? (ranks.old ? { g: ranks.old.generatedAt, i: ranks.old.importedAt } : null)
    : (ranks.new ? { g: ranks.new.generatedAt, i: ranks.new.importedAt } : null);
  if (!x) return '';
  return '作成 ' + fmtShortJst(x.g) + (x.i ? '　読込 ' + fmtShortJst(x.i) : '');
}

async function renderDriveInfo() {
  if (RECEIVE) { renderRecvInfo(); return; } // 「インポートデータ」の欄
  const ok = Drive.configured();
  document.querySelectorAll('.driveOnly').forEach((e) => { e.hidden = !ok; });
  if (!ok) return;
  const slots = await getSlots();
  const pass = await getSetting('passphrase');
  $('driveSlots').replaceChildren(...SLOTS.map((slot) => el('li', {},
    el('div', { class: 'slot-text' }, el('span', { class: 'muted' }, slot.label()), el('b', {}, slots[slot.key] ? slots[slot.key].name : '未選択'),
      slotTimes(slot.key) ? el('span', { class: 'slot-meta' }, slotTimes(slot.key)) : null),
    el('button', { type: 'button', onclick: () => fetchFromDrive(slot.key) }, slots[slot.key] ? '選び直す' : '選ぶ'))));
  $('forgetPassBtn').hidden = !pass;
}

document.querySelectorAll('.driveFetch').forEach((b) => b.addEventListener('click', () => {
  // Agent アプリ：共有のファイルを読めているときは、ログインせずに確かめる（読めなければ次からログインして取得）
  // ログイン画面はボタンを押したその場で開く必要があるので、どちらにするかは前回の結果（publicState）で決める
  if (RECEIVE && publicState === 'ok') checkPublic(true);
  else fetchFromDrive();
}));
if ($('driveSignOutBtn')) $('driveSignOutBtn').addEventListener('click', async () => {
  Drive.signOut();
  await delSetting('driveSlots');
  await delSetting('driveFiles');
  renderDriveInfo();
  alert('Google との連携を解除しました（次回はログインとファイルの選択からやり直します）');
});
$('forgetPassBtn').addEventListener('click', async () => {
  await delSetting('passphrase');
  renderDriveInfo();
  alert('保存していた合言葉を削除しました');
});

// ヘッダのタイトルを、アイコン・Manager／Agent の印・Version を除いた残りの幅いっぱいの大きさに（12〜26px）
function fitTitle() {
  const h = document.querySelector('.bar h1'), box = document.querySelector('.bar .title'), bar = document.querySelector('.bar'), st = $('status');
  if (!h || !box || !bar) return;
  const outer = (e) => e.getBoundingClientRect().width + (parseFloat(getComputedStyle(e).marginLeft) || 0) + (parseFloat(getComputedStyle(e).marginRight) || 0);
  const others = [...box.children].filter((e) => e !== h).reduce((w, e) => w + outer(e), 0);
  const cs = getComputedStyle(bar);
  // ヘッダの幅から、左右の余白・Version・間隔・アイコン・印を引いた残り
  const avail = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (st ? outer(st) : 0) - (parseFloat(cs.columnGap) || 0) - others - 2;
  h.style.fontSize = '20px';
  const natural = h.scrollWidth;
  h.style.fontSize = Math.max(12, Math.min(26, Math.floor(20 * avail / natural * 10) / 10)) + 'px';
}
window.addEventListener('resize', fitTitle);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTitle);

function showStatus() {
  // ヘッダの右側はアプリのバージョン（取得中などは、そのときだけ「取得中…」などを出す）
  const st = $('status');
  st.textContent = 'Version：' + self.APP_VERSION;
  st.title = data ? 'データの作成日時：' + fmtJst(data.generatedAt) : 'データはまだ読み込んでいません';
  fitTitle();
}

//--------------------------------------------------------------
// 保存の持続化・インストール
//--------------------------------------------------------------
async function showStorageInfo() {
  if (!navigator.storage || !navigator.storage.persist) return;
  if (!$('storageInfo')) { navigator.storage.persist().catch(() => {}); return; } // 表示の欄はなくした（持続化の依頼だけする）
  const persisted = await navigator.storage.persisted() || await navigator.storage.persist();
  $('storageInfo').textContent = persisted
    ? '保存の持続化：有効（容量不足でも自動で消されにくくなっています）'
    : '保存の持続化：未許可（データは' + FETCH_HINT() + 'でいつでも取り直せます）';
}

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  if (typeof onInstallReady === 'function') onInstallReady();
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('installBtn').hidden = true;
});

//--------------------------------------------------------------
// タブ切り替え・全体
//--------------------------------------------------------------
// 設定タブを開いたら、Google の部品を前もって読み込む（「最新データを取得」を押したときに、すぐログイン画面を開けるように）
document.querySelector('[data-tab=settings]').addEventListener('click', () => Drive.preload());
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + btn.dataset.tab; });
}));

// 横にスワイプすると隣のタブへ（左へスワイプで右隣、右へで左隣）。ページは指についてきて、離すと次のページが横から滑り込む（0.15 秒）
// 動かしている間は、移る先の側に矢印と行き先のタブ名を出す。画面幅の 20% 未満でゆっくり離したときは元に戻る。両端のタブでは重く動いて戻る
// 入力欄・グラフ・横にスクロールできる表の上、アドレス一覧を開いているときは動かさない
(() => {
  const SLIDE_MS = 150;
  // 移る先を示す矢印（左へ払うと右端に「›」と次のタブ名、右へ払うと左端に「‹」と前のタブ名）
  const hint = document.createElement('div');
  hint.className = 'swipe-hint';
  hint.innerHTML = '<span class="sh-arrow"></span><span class="sh-name"></span>';
  document.body.appendChild(hint);
  const showHint = (dir, name, p) => { // dir：-1＝次（右端）、1＝前（左端）、p：0〜1
    hint.classList.toggle('left', dir > 0); hint.classList.toggle('right', dir < 0);
    hint.querySelector('.sh-arrow').textContent = dir < 0 ? '›' : '‹';
    hint.querySelector('.sh-name').textContent = name;
    hint.style.opacity = String(Math.min(1, p * 1.6));
    hint.style.setProperty('--p', String(Math.min(1, p)));
    hint.classList.toggle('ready', p >= 1);
  };
  const hideHint = (go) => { hint.classList.remove('ready'); if (go) { hint.classList.add('go'); setTimeout(() => { hint.classList.remove('go'); hint.style.opacity = '0'; }, 260); } else hint.style.opacity = '0'; };
  let sx = 0, sy = 0, st = 0, armed = false, mode = '', dx = 0, page = null, busy = false;
  const scrollsX = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true; } return false; };
  const btns = () => [...document.querySelectorAll('.tabs button')];
  const curIndex = () => btns().findIndex((b) => b.getAttribute('aria-selected') === 'true');
  const move = (el, x, ms) => { el.style.transition = ms ? 'transform ' + ms + 'ms ease-out' : 'none'; el.style.transform = x ? 'translateX(' + x + 'px)' : ''; };
  const after = (ms) => new Promise((r) => setTimeout(r, ms + 20));
  document.addEventListener('touchstart', (ev) => {
    armed = false; mode = ''; dx = 0;
    if (busy || ev.touches.length !== 1 || !$('tab-book').hidden) return;
    const t = ev.target;
    if (t.closest('input, select, textarea, dialog, .ch-wrap, .tabs') || scrollsX(t)) return;
    sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; st = Date.now(); armed = true;
    page = document.querySelector('.tab:not([hidden])');
  }, { passive: true });
  document.addEventListener('touchmove', (ev) => {
    if (!armed || !page) return;
    const mx = ev.touches[0].clientX - sx, my = ev.touches[0].clientY - sy;
    if (!mode) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      mode = Math.abs(mx) > Math.abs(my) * 1.5 ? 'x' : 'y'; // 最初の動きで、横（タブ移動）か縦（スクロール）かを決める
    }
    if (mode !== 'x') return;
    ev.preventDefault(); // 横に動かしている間は、縦にスクロールさせない
    const j = curIndex() + (mx < 0 ? 1 : -1);
    const has = j >= 0 && j < btns().length;
    dx = has ? mx : mx / 4; // 端のタブでは重く
    move(page, dx, 0);
    if (has) showHint(mx < 0 ? -1 : 1, btns()[j].textContent.trim(), Math.abs(dx) / (window.innerWidth * 0.2)); else hideHint(false);
  }, { passive: false });
  document.addEventListener('touchend', async () => {
    if (!armed || mode !== 'x' || !page) { armed = false; return; }
    armed = false;
    const cur = page, w = window.innerWidth;
    const j = curIndex() + (dx < 0 ? 1 : -1);
    const fast = Math.abs(dx) > 25 && Date.now() - st < 300; // すばやく払ったときは短くても移る
    if (j < 0 || j >= btns().length || (Math.abs(dx) < w * 0.2 && !fast)) { hideHint(false); move(cur, 0, SLIDE_MS); await after(SLIDE_MS); move(cur, 0, 0); return; }
    hideHint(true);
    busy = true;
    const dir = dx < 0 ? -1 : 1;
    move(cur, dir * w, SLIDE_MS); // 今のページを外へ
    await after(SLIDE_MS);
    move(cur, 0, 0);
    btns()[j].click();
    window.scrollTo(0, 0);
    const next = document.querySelector('.tab:not([hidden])');
    if (next) { move(next, -dir * w, 0); next.getBoundingClientRect(); move(next, 0, SLIDE_MS); await after(SLIDE_MS); move(next, 0, 0); } // 次のページを反対側から
    busy = false;
  });
  document.addEventListener('touchcancel', () => { if (armed && page) move(page, 0, SLIDE_MS); hideHint(false); armed = false; });
})();

function refreshAll() {
  document.querySelectorAll('.whenEmpty').forEach((e) => { e.hidden = !!data; });
  document.querySelectorAll('.whenData').forEach((e) => { e.hidden = !data; });
  $('dummyNote').hidden = !(data && data.dummy);
  hooks.render();
  for (const f of ESV.renderers) f();
  if ($('dataInfo')) $('dataInfo').textContent = (data
    ? 'データ：' + dataMeta.fileName + '（作成 ' + fmtJst(data.generatedAt) + '、読み込み ' + fmtJst(dataMeta.importedAt) + '）' + hooks.describe()
    : 'データ：まだ読み込んでいません。') +
    '　旧ランク表：' + (ranks.old ? ranks.old.fileName : '未読み込み') +
    '　新ランク表：' + (ranks.new ? ranks.new.fileName + '（開始日 ' + ranks.new.startDate + '）' : '未読み込み');
  renderDriveInfo();
  showStatus();
}

//--------------------------------------------------------------
// バージョンと更新
//--------------------------------------------------------------
$('appVersion').textContent = self.APP_VERSION;
// 新しい版の Service Worker に入れ替わるまで待ってから再読み込みする（最大 15 秒）
// 先に保管庫を消すと、入れ替わる前に古い版の Service Worker が古いファイルを取り直してしまうことがあるため、消さない
// （古い版の保管庫は、新しい版の Service Worker が入れ替わるときに消す。消すのは自分の接頭辞のものだけ）
// 戻り値：入れ替わったら true（再読み込みする）。入れ替わらなければ false
function waitForNewWorker(reg, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    navigator.serviceWorker.addEventListener('controllerchange', () => finish(true), { once: true });
    const watch = (w) => w && w.addEventListener('statechange', () => { if (w.state === 'activated') finish(true); if (w.state === 'redundant') finish(false); });
    watch(reg.installing); watch(reg.waiting);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    if (reg.waiting) reg.waiting.postMessage('skipWaiting');
    setTimeout(() => finish(false), ms);
  });
}

async function applyUpdate() {
  $('status').textContent = '更新中…';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      const waiting = waitForNewWorker(reg, 15000);
      await reg.update();
      const ok = await waiting;
      if (!ok && !(await newerVersion())) {
        showStatus();
        alert('新しいバージョンの準備ができませんでした。公開の直後は、反映まで数分かかることがあります。少し待ってから、もう一度お試しください。');
        return;
      }
    }
  } catch { /* 失敗しても再読み込みで取り直す */ }
  location.reload();
}
// 「新しいバージョンがあります［更新する］」は、新しい版に入れ替わったあとに出るので、すぐ再読み込みする
$('reloadBtn').addEventListener('click', () => location.reload());

// 公開サイトの一時保管（最大 10 分）を通さずに、最新の版の番号を読む。今より新しければその番号、同じなら null
async function newerVersion() {
  const res = await fetch('version.js?t=' + Date.now(), { cache: 'no-store' });
  const latest = ((await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  return latest && latest !== self.APP_VERSION ? latest : null;
}

if ('serviceWorker' in navigator) {
  // 新しい版の Service Worker に切り替わったら、再読み込みを促す（初回のインストール時は除く）
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('updateNote').hidden = false; });
}

$('updateBtn').addEventListener('click', async () => {
  const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
  if (!reg) { alert('更新を確認できませんでした'); return; }
  $('updateBtn').disabled = true;
  try {
    const latest = await newerVersion();
    if (latest) {
      if (confirm('新しいバージョン（' + latest + '）があります。更新しますか？')) await applyUpdate();
    } else {
      alert('最新のバージョンです（' + self.APP_VERSION + '）');
    }
  } catch {
    alert('更新を確認できませんでした（通信を確認してください）');
  } finally {
    $('updateBtn').disabled = false;
  }
});

// 各アプリの app.js から呼ぶ。init：保存済みの設定を読む処理（任意）
const ESV = {
  loaders: [],   // 起動時に保存済みのものを読む処理（book.js など）
  renderers: [], // 画面を描き直すときに一緒に呼ぶ処理
  async start(h) {
    hooks = Object.assign(hooks, h);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
    await loadSavedData();
    // 表示と配色の設定はなくした（2026-10 ユーザー指示）。以前に端末で変えていた設定は消して、標準に戻す
    applyAppearance(APPEARANCE_DEFAULT);
    delSetting('appearance').catch(() => { /* なくてもよい */ });
    for (const f of ESV.loaders) await f();
    if (h.init) await h.init();
    refreshAll();
    showStorageInfo();
    // Agent：招待リンクで開いたときは受け取る。そうでなければ、共有にしたデータのファイルを確かめ、新しければ自動で取り込む（待たない）
    if (RECEIVE) startAgentReceive();
  },
};

//--------------------------------------------------------------
// 自動で最新にする（Agent アプリだけ。2026-10）
// Agent 用のデータのファイルを「リンクを知っている全員」に共有しておくと、ログインなしで（API キーで）読める
// アプリを開いたとき・ほかのアプリから戻ってきたとき（前の確認から5分以上）に、ファイルの目印（md5）を前回と比べ、
// 変わっていれば取り込んで短く知らせる。合言葉を端末に保存していなければ入力画面が出る。読めないときは何も出さない
// ファイルの ID は端末の中（driveSlots）にだけ持つ（プログラムには書かない）
//--------------------------------------------------------------
const PUBLIC_INTERVAL = 5 * 60 * 1000;
let publicState = null;   // 'ok'（ログインなしで読めた）| 'ng'（読めなかった）| null（まだ確かめていない）
let lastPublicCheck = 0;
let skipMd5 = '';         // 合言葉の入力をやめたファイルの目印（このあいだは自動では聞き直さない）

function toast(msg) {
  let t = $('toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 4000);
}

// manual：［最新データを取得］から呼んだとき（結果を必ず知らせる）
async function checkPublic(manual = false) {
  if (!RECEIVE || driveBusy || !Drive.configured()) return;
  const slots = await getSlots();
  const file = slots.data;
  if (!file) { if (manual) toast('データ格納先が決まっていません。招待リンクを開くか、［招待コードを入れる］から始めてください。'); return; }
  lastPublicCheck = Date.now();
  driveBusy = true;
  let msg = null;
  try {
    let meta;
    try {
      if (manual) $('status').textContent = '確認中…';
      meta = await Drive.publicMeta(file.id);
    } catch (err) {
      publicState = 'ng';
      if (manual) msg = '受け取れませんでした。通信の状態を確かめるか、招待した人に共有の設定を確かめてもらってください。';
      return;
    }
    publicState = 'ok';
    file.checkedAt = new Date().toISOString();
    await putSetting('driveSlots', slots);
    if (data && file.md5 && meta.md5Checksum === file.md5) { if (manual) msg = 'データは最新です（作成：' + fmtShortJst(data.generatedAt) + '）'; return; }
    if (!manual && meta.md5Checksum === skipMd5) return;
    if (manual) $('status').textContent = '取得中…';
    const text = await Drive.publicText(file.id);
    lastImportKind = null;
    const r = await importText(text, meta.name, 'drive');
    if (lastImportKind !== 'data') { skipMd5 = meta.md5Checksum; return; } // 合言葉の入力をやめた
    skipMd5 = '';
    slots.data = { id: file.id, name: meta.name, md5: meta.md5Checksum, checkedAt: file.checkedAt };
    await putSetting('driveSlots', slots);
    msg = /^データは最新/.test(r || '') ? (manual ? r : null) : '新しいデータを読み込みました（作成：' + fmtShortJst(data.generatedAt) + '）';
  } catch (err) {
    if (manual) msg = err.message;
  } finally {
    driveBusy = false;
    renderDriveInfo();
    showStatus();
    if (msg) toast(msg);
  }
}

if (RECEIVE) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastPublicCheck > PUBLIC_INTERVAL) checkPublic();
  });
}

// 「最新データを取得」の案内（Agent はボタンの名前が違う）
const FETCH_HINT = () => (RECEIVE ? '「設定」の［今すぐ確認］' : '「設定」の［最新データを取得］');

//--------------------------------------------------------------
// 招待（Agent アプリだけ。2026-10）
// 招待リンク：https://kuveratux.github.io/earnsplitviewer-agent/#invite=<招待コード>（# の後ろはサーバーに送られない）
// 招待コード：Agent 用のデータのファイルの ID（ドライブの共有のリンクから取り出したもの）。合言葉は入れない（別の手段で伝える）
// 受け取ったファイルの ID は端末の中（driveSlots）にだけ持つ。プログラムには書かない
//--------------------------------------------------------------
// 招待コード・招待リンク・ドライブの共有のリンクのどれを貼られても、ファイルの ID を取り出す
function inviteIdOf(text) {
  const s = String(text || '').trim();
  const m = s.match(/[#&?]invite=([A-Za-z0-9_-]+)/) || s.match(/\/d\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/) || s.match(/^([A-Za-z0-9_-]+)$/);
  return m && m[1].length >= 20 ? m[1] : null;
}
// 招待リンクで開いたときの招待コード。読んだらアドレス欄からすぐ消す（履歴やブックマークに残さない）
function takeInviteFromUrl() {
  const id = inviteIdOf(location.hash);
  if (/invite=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  return id;
}
const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

// 招待を受け取る：ログインなしで読み、合言葉で開けたら、そのファイルを覚える（開けなければ何も変えない）
async function acceptInvite(id) {
  if (driveBusy) return;
  const slots = await getSlots();
  if (slots.data && slots.data.id === id) { checkPublic(true); return; } // 同じ招待をもう一度開いた
  driveBusy = true;
  let ok = false;
  try {
    $('status').textContent = '受け取り中…';
    // 読めるかを先に確かめてから、置き換えてよいかを聞く
    let meta;
    try { meta = await Drive.publicMeta(id); } catch {
      alert('招待のデータを受け取れませんでした。招待コード（リンク）が正しいか、通信の状態を確かめてください。続くときは、招待した人に共有の設定を確かめてもらってください。');
      return;
    }
    if ((data || slots.data) && !confirm('招待を受け取りました。今のデータを、招待されたデータに置き換えますか？')) return;
    const text = await Drive.publicText(id);
    lastImportKind = null;
    await importText(text, meta.name, 'invite');
    if (lastImportKind !== 'data') return; // 合言葉の入力をやめた
    slots.data = { id, name: meta.name, md5: meta.md5Checksum, checkedAt: new Date().toISOString() };
    await putSetting('driveSlots', slots);
    publicState = 'ok';
    ok = true;
  } catch (err) {
    alert('受け取れませんでした（' + err.message + '）');
  } finally {
    driveBusy = false;
    renderDriveInfo();
    showStatus();
  }
  if (!ok) return;
  if (isStandalone()) { toast('データを受け取りました（作成：' + fmtShortJst(data.generatedAt) + '）'); return; }
  // ブラウザで開いたとき：ホーム画面に追加したあとの案内（iPhone は追加したアプリに招待コードを入れ直す）
  $('inviteDoneCode').textContent = id;
  $('inviteDoneDlg').showModal();
}

// 「インポートデータ」の欄（2026-10 に「データの受け取り」から改名）
async function renderRecvInfo() {
  if (!$('recvInfo')) return;
  const slots = await getSlots();
  const f = slots.data;
  // ファイル名は伏せる（ev_…_latest.json。番号やアドレスの一部を画面に出さない）
  const masked = (name) => String(name || '').replace(/^ev_.+_latest\.json$/i, 'ev_…_latest.json');
  const rows = [
    ['データ格納先', f ? '設定済み' + (f.name ? '（' + masked(f.name) + '）' : '') : '未設定（招待リンクを開くか、招待コードを入れてください）'],
    ['データ最終確認日時', f && f.checkedAt ? fmtShortJst(f.checkedAt) : '—'],
    ['データ作成日時', data ? fmtShortJst(data.generatedAt) : '—'],
  ];
  if (publicState === 'ng') rows.push(['状態', '受け取れませんでした（共有の設定を招待した人に確かめてもらってください）']);
  $('recvInfo').replaceChildren(...kvRows(rows));
  $('forgetPassBtn').hidden = !(await getSetting('passphrase'));
}

if (RECEIVE) {
  $('recvCheckBtn').addEventListener('click', () => checkPublic(true));
  $('inviteCodeBtn').addEventListener('click', () => { $('codeInput').value = ''; $('codeDlg').showModal(); });
  $('codeDlg').addEventListener('close', () => {
    if ($('codeDlg').returnValue !== 'ok') return;
    const id = inviteIdOf($('codeInput').value);
    if (!id) { alert('招待コードの形が正しくありません。招待した人から受け取ったコード（またはリンク）をそのまま貼り付けてください。'); return; }
    acceptInvite(id);
  });
  $('inviteCopyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('inviteDoneCode').textContent); toast('招待コードをコピーしました'); }
    catch { toast('コピーできませんでした。コードを長押ししてコピーしてください'); }
  });
  // 起動中に招待リンクを開き直したとき（同じページで # だけ変わる）
  window.addEventListener('hashchange', () => { const inv = takeInviteFromUrl(); if (inv) openInvite(inv); });
}

//--------------------------------------------------------------
// 招待リンクをブラウザで開いたときの流れ（Agent。2026-10）
// ・ホーム画面のアプリ（standalone）で開いた → そのまま受け取る
// ・LINE などのアプリの中のブラウザ → Safari／Chrome で開き直す案内（インストールできないため）
// ・iPhone の Safari → 受け取らずに、ホーム画面に追加する手順と［コードをコピー］（ホーム画面のアプリは Safari と別に情報を持つため）
// ・Android の Chrome など → 招待を端末に覚えて（'pendingInvite'）、まずインストール。インストールしたアプリを開くと受け取る
//   （インストールしたアプリはブラウザと情報を共有する。Chrome がインストールの画面を出せないときは、メニューからの手順を出す）
// どれも［このまま使う］で、ブラウザのまま受け取ることもできる
//--------------------------------------------------------------
const UA = navigator.userAgent || '';
const isIOS = () => /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(UA);
const isInAppBrowser = () => /\bLine\/|FBAN|FBAV|Instagram|MicroMessenger|; wv\)/i.test(UA);
const inviteLinkOf = (id) => location.origin + location.pathname + '#invite=' + id;
const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="vertical-align:-3px"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

async function startAgentReceive() {
  const inv = takeInviteFromUrl();
  if (inv) { openInvite(inv); return; }
  // インストールしたアプリを初めて開いた（ブラウザで覚えた招待がある）
  const pending = await getSetting('pendingInvite');
  if (pending && isStandalone()) { await delSetting('pendingInvite'); acceptInvite(pending); return; }
  checkPublic();
}

function openInvite(id) {
  if (isStandalone()) { acceptInvite(id); return; }
  if (isInAppBrowser()) { showOnboard('inapp', id); return; }
  if (isIOS()) { showOnboard('ios', id); return; }
  putSetting('pendingInvite', id).catch(() => {});
  showOnboard('install', id);
}

let onbKind = '', onbId = '';
function onbStep(n, ...body) { return el('div', { class: 'onb-step' }, el('span', { class: 'onb-num' }, String(n)), el('div', {}, ...body)); }
function showOnboard(kind, id) {
  onbKind = kind; onbId = id;
  const btn = (text, primary, onclick) => { const b = el('button', { type: 'button', class: primary ? 'primary' : '' }, text); b.addEventListener('click', onclick); return b; };
  const useHere = btn('このまま使う（ホーム画面に追加しない）', false, async () => { $('onbDlg').close(); await delSetting('pendingInvite'); acceptInvite(id); });
  const copy = (text, done) => async () => { try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('コピーできませんでした'); } };
  let title, body, btns;
  if (kind === 'inapp') {
    title = 'ブラウザで開き直してください';
    body = [el('p', {}, 'LINE などのアプリの中のブラウザでは、アプリとしてインストール（ホーム画面に追加）ができません。'),
      onbStep(1, '画面のメニュー（… や ⋮）から「ブラウザで開く」「Safari で開く」「Chrome で開く」などを選んでください。'),
      onbStep(2, 'メニューにないときは、［リンクをコピー］を押して、Safari（Android は Chrome）のアドレス欄に貼り付けて開いてください。')];
    btns = [btn('リンクをコピー', true, copy(inviteLinkOf(id), '招待リンクをコピーしました')), useHere];
  } else if (kind === 'ios') {
    title = 'ホーム画面に追加して使います';
    const sh = el('span', {}); sh.innerHTML = SHARE_ICON; // 固定の図形だけ
    body = [onbStep(1, '［コードをコピー］を押します。'),
      onbStep(2, '画面下（iPad は右上）の共有ボタン ', sh, ' を押し、［ホーム画面に追加］→［追加］を押します。'),
      onbStep(3, 'ホーム画面の「' + APP.defaultName + '」を開き、［コピーした招待コードで受け取る］を押して、合言葉を入れます。'),
      el('p', { class: 'muted' }, 'iPhone では、ホーム画面に追加したアプリは Safari と別に情報を持つため、招待コードを入れて受け取ります。'),
      el('p', { class: 'mono invite-code' }, id)];
    btns = [btn('コードをコピー', true, copy(id, '招待コードをコピーしました')), useHere];
  } else {
    title = 'まずアプリをインストールしてください';
    const ready = !!installEvent;
    body = [onbStep(1, ready ? '［アプリとしてインストール］を押し、表示された画面で［インストール］を押します。' : '画面右上のメニュー（⋮）から［アプリをインストール］（または［ホーム画面に追加］）を押します。'),
      onbStep(2, 'ホーム画面の「' + APP.defaultName + '」を開きます。招待は自動で受け取るので、合言葉を入れれば使い始められます。'),
      el('p', { id: 'onbInstalled', class: 'note', hidden: '' }, 'インストールしました。ホーム画面の「' + APP.defaultName + '」を開いてください（このページは閉じてかまいません）。')];
    btns = [...(ready ? [btn('アプリとしてインストール', true, async () => {
      if (!installEvent) return;
      installEvent.prompt();
      const r = await installEvent.userChoice;
      installEvent = null;
      if ($('installBtn')) $('installBtn').hidden = true;
      if (r && r.outcome === 'accepted') $('onbInstalled').hidden = false;
    })] : []), useHere];
  }
  $('onbTitle').textContent = title;
  $('onbBody').replaceChildren(...body);
  $('onbBtns').replaceChildren(...btns, btn('閉じる', false, () => $('onbDlg').close()));
  if (!$('onbDlg').open) $('onbDlg').showModal();
}
// Chrome がインストールの画面を出せるようになった（案内を出したあとでも、ボタンを出す）
function onInstallReady() { if (RECEIVE && $('onbDlg') && $('onbDlg').open && onbKind === 'install') showOnboard('install', onbId); }
window.addEventListener('appinstalled', () => { if ($('onbInstalled')) $('onbInstalled').hidden = false; });

// データがない画面の［コピーした招待コードで受け取る］（iPhone でホーム画面に追加したあと）・［招待コードを入れる］
if (RECEIVE) {
  document.querySelectorAll('.pasteInviteBtn').forEach((b) => b.addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* 読めない端末は入力の画面へ */ }
    const id = inviteIdOf(text);
    if (id) { acceptInvite(id); return; }
    $('codeInput').value = '';
    $('codeDlg').showModal();
  }));
  document.querySelectorAll('.openCodeBtn').forEach((b) => b.addEventListener('click', () => { $('codeInput').value = ''; $('codeDlg').showModal(); }));
}

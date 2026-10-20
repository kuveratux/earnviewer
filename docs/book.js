'use strict';

// アドレス一覧とアドレス帳（Manager・Agent 共通）
// ・一覧：取引に出てきたアドレス（新しく出てきた順）と、名前を付けたアドレス
// ・名前は端末内（IndexedDB の 'addressbook'）だけに保存し、外部には送らない。取引一覧の相手先にも表示する
// ・書き出し・読み込みでバックアップできる（機種変更や、端末のデータが消えたときのため）
// views.js の後、各アプリの app.js の前に読み込む

let book = {}; // アドレス（小文字） → { name, updatedAt }

nameOf = (addr) => {
  const b = book[addr.toLowerCase()];
  return b ? b.name + '（' + short(addr) + '）' : short(addr);
};

async function loadBook() { book = (await getSetting('addressbook')) || {}; }
async function saveBook() { await putSetting('addressbook', book); }

async function setName(addr, name) {
  const a = addr.toLowerCase();
  name = (name || '').trim();
  if (name) book[a] = { name, updatedAt: new Date().toISOString() };
  else delete book[a];
  await saveBook();
}

// 名前の登録ダイアログ（一覧のボタン、取引一覧の相手先から開く）
function openNameDialog(addr) {
  const b = book[addr.toLowerCase()];
  $('dlgAddr').textContent = addr;
  $('dlgName').value = b ? b.name : '';
  $('nameDlg').dataset.addr = addr;
  $('nameDlg').showModal();
}
$('nameDlg').addEventListener('close', async () => {
  const dlg = $('nameDlg');
  if (dlg.returnValue !== 'save') return;
  await setName(dlg.dataset.addr, $('dlgName').value);
  refreshAll();
});

// 一覧に出すアドレス：取引に出てきた順（新しい順）→ 名前だけあるアドレス
function bookAddresses() {
  const seen = new Map();
  if (data) for (const x of [...data.transfers].sort((a, b) => b.t - a.t)) if (!seen.has(x.counterparty)) seen.set(x.counterparty, true);
  for (const a of Object.keys(book)) if (!seen.has(a)) seen.set(a, false);
  return [...seen.entries()].map(([address, inData]) => ({ address, inData }));
}

function renderBook() {
  const rows = bookAddresses();
  const named = rows.filter((r) => book[r.address]).length;
  $('bookCount').textContent = rows.length + ' 件（名前あり ' + named + ' 件）';
  $('bookList').replaceChildren(...(rows.length ? rows.map((r) => {
    const b = book[r.address];
    return el('li', {},
      el('div', { class: 'b-name' }, b ? b.name : el('span', { class: 'muted' }, '名前なし'), r.inData ? null : el('span', { class: 'tag' }, '取引なし')),
      el('div', { class: 'mono' }, r.address),
      el('div', { class: 'b-actions' }, el('button', { type: 'button', onclick: () => openNameDialog(r.address) }, b ? '名前を変更' : '名前を付ける')));
  }) : [el('li', { class: 'muted' }, 'データを読み込むと、取引に出てきたアドレスが表示されます。')]));
}

// 設定タブ ⇄ アドレス一覧
function showBook(open) {
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = open ? s.id !== 'tab-book' : s.id !== 'tab-settings'; });
  if (open) { renderBook(); window.scrollTo(0, 0); }
}
$('openBookBtn').addEventListener('click', () => showBook(true));
$('backFromBook').addEventListener('click', () => showBook(false));

// 書き出し・読み込み（アプリごとの形式。Manager と Agent で別々に保存される）
const BOOK_FORMAT = 'esv-addressbook';
$('bookExportBtn').addEventListener('click', () => {
  const entries = Object.entries(book).map(([address, b]) => ({ address, name: b.name, updatedAt: b.updatedAt }));
  const body = JSON.stringify({ format: BOOK_FORMAT, version: 1, app: APP.id, exportedAt: new Date().toISOString(), entries }, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const a = el('a', { href: url, download: 'esv_' + APP.id + '_addressbook_' + new Date().toISOString().slice(0, 10) + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('bookImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (json.format !== BOOK_FORMAT || !Array.isArray(json.entries)) throw new Error('アドレス帳のファイルではありません');
    const valid = json.entries.filter((x) => x && /^0x[0-9a-fA-F]{40}$/.test(x.address) && typeof x.name === 'string' && x.name.trim());
    if (!confirm(valid.length + ' 件を読み込みます。同じアドレスの名前は上書きされます。よろしいですか？')) return;
    for (const x of valid) book[x.address.toLowerCase()] = { name: x.name.trim(), updatedAt: x.updatedAt || new Date().toISOString() };
    await saveBook();
    refreshAll();
    alert(valid.length + ' 件を読み込みました。');
  } catch (err) {
    alert('読み込めませんでした：' + err.message);
  }
});

ESV.loaders.push(loadBook);
ESV.renderers.push(() => { if (!$('tab-book').hidden) renderBook(); });

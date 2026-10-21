'use strict';

// ランキングタブ（保有者ランキング）。Manager・Agent 共通
// ・データの ranking.source（保有者ランキング取得エクセルが作った元データ）から、開いた時点の報酬・魚分類で作り直す（report.js）
//   ランク表は ESV のデータのもの（ranks）を使う（報酬タブと同じ表で計算する）
// ・一番上：保有枚数（報酬タブと同じ）と推定順位・Tier（魚分類）。分配で持ち分を分けているので一致するアドレスはなく「推定」
//     分配しているときは、配布先アドレス（ranking.self）の行を外し、分配後の Manager 分・Agent 分を1行ずつ差し込んで順位を数える
//     （Agent アプリは Agent 分だけを表示し、Manager 分は表示しないが人数・順位には数える。2026-10 ユーザー決定）
//     推定順位：Manager 分・Agent 分は差し込んだ一覧の中の順位、合算はほかの保有者と比べた順位
// ・① 保有者ランキング／② 預入ランキング（切り替え）。順位の変化はエクセルで前回ランキングを作ったときとの比較
// ・名前は各スマホのアドレス一覧（book.js）の名前。押すと名前を付けられる
// 使う部品：deposits.js・fish.js・report.js（保有者ランキングの部品の写し。tools/sync-ranking.js で本体と同じか確かめる）

const FISH_EMOJI = { Whale: '🐳', Shark: '🦈', Dolphin: '🐬', Fish: '🐟', Crab: '🦀', Shrimp: '🦐' };
const FISH_JA = Object.fromEntries(Fish.CLASSES.map((c) => [c.name, c.ja]));
const RANK_PAGE = 100; // 一度に出す件数（「さらに表示」で増やす）
let rankListKind = 'holders'; // 起動時は保有者の順位（端末に保存しない）
let rankShown = RANK_PAGE;
let rankCache = { key: '', view: null };
let rankSelfName = ''; // Agent アプリ：ランキングでの自分の表示名（空欄なら「自分」。端末の中だけ）
let rankJump = null;   // 推定順位を押したときに移る行（分配の行の id）

// 開いた時点（分単位）の4つの観点。同じ分のうちは作り直さない
function rankingView(now) {
  const rg = data.ranking;
  const key = rg.generatedAt + '|' + Math.floor(now / 60) + '|' + ranks.old.generatedAt + '|' + ranks.new.startDate;
  if (rankCache.key !== key) {
    const src = { ...rg.source, ranks: { old: { ranks: ranks.old.ranks }, new: { ranks: ranks.new.ranks, startDate: ranks.new.startDate } } };
    rankCache = { key, view: Report.build(src, now) };
  }
  return rankCache.view;
}

// 前回からの順位の変化：↑n・↓n・－・新。前回の記録がないときは出さない
// 配布先の行・分配の行を除いた順位どうしで比べる（分配の行を差し込んだことで、ほかの人の順位がずれて見えないように）
//   前回の順位（配布先の行を含む）から、配布先が上にいた分を引く
function rankChange(kind, address, curNo, adjust = true) {
  const prev = data.ranking.previous;
  if (!prev || !prev[kind] || !(address in prev[kind])) return null;
  const p = prev[kind][address];
  if (p == null) return el('span', { class: 'rk-chg new' }, '新');
  const selfPrev = adjust ? prev[kind][(data.ranking.self || '').toLowerCase()] : null;
  const d = (selfPrev != null && selfPrev < p ? p - 1 : p) - curNo;
  return el('span', { class: 'rk-chg ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'same') }, d > 0 ? '↑' + d : d < 0 ? '↓' + -d : '－');
}

// ---- EARN Tier のアイコン（宝石のバッジ。design/icons/tier_candidates の案C。2026-10 ユーザー決定）
// ランクの名前 → 見た目：General＝Bronze、Standard＝Silver、Gold＝Gold、Platinum＝Platinum、Premium＝Diamond、利用なし・ランク外＝灰色
// 表にない名前は、新ランク表の並び（下から上）で Bronze → Diamond を割り当てる
const TIER_STYLES = {
  bronze: { c: ['#f6c79a', '#c9834a', '#7a4520'], n: 1 }, silver: { c: ['#ffffff', '#c7d0dd', '#7d8796'], n: 2 }, gold: { c: ['#fff3c4', '#e8c06a', '#9c6f22'], n: 3 },
  platinum: { c: ['#f2fbff', '#a9d9e6', '#5c8fa3'], n: 4 }, diamond: { c: ['#ffffff', '#8fd8ff', '#2a6fd6'], n: 5 }, none: { c: ['#9aa3b5', '#6b7488', '#3d4454'], n: 0 },
};
const TIER_BY_NAME = { General: 'bronze', Standard: 'silver', Gold: 'gold', Platinum: 'platinum', Premium: 'diamond', '利用なし': 'none', 'ランク外': 'none' };
const tierIconCache = {};
function tierStyleKey(name) {
  if (!name) return 'none';
  if (TIER_BY_NAME[name]) return TIER_BY_NAME[name];
  const order = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  const i = ((ranks.new && ranks.new.ranks) || []).findIndex((r) => r.name === name);
  return i < 0 ? 'none' : order[Math.min(i, order.length - 1)];
}
function tierIconUrl(key) {
  if (tierIconCache[key]) return tierIconCache[key];
  const t = TIER_STYLES[key], g = 'k' + key;
  const one = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-8 -3 L-5 -8 L5 -8 L8 -3 L0 8 Z" fill="url(#${g})" stroke="${t.c[2]}" stroke-width="1"/><path d="M-8 -3 L8 -3 M-5 -8 L-2 -3 L0 8 L2 -3 L5 -8" fill="none" stroke="${t.c[0]}" stroke-width=".8" opacity=".9"/></g>`;
  const pos = { 1: [[32, 32, 1.6]], 2: [[24, 33, 1.2], [40, 33, 1.2]], 3: [[32, 26, 1.1], [22, 38, 1.0], [42, 38, 1.0]], 4: [[24, 26, 1.0], [40, 26, 1.0], [24, 40, 1.0], [40, 40, 1.0]], 5: [[32, 22, 1.0], [20, 32, 0.9], [44, 32, 0.9], [25, 44, 0.9], [39, 44, 0.9]] }[t.n] || [];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.c[0]}"/><stop offset=".5" stop-color="${t.c[1]}"/><stop offset="1" stop-color="${t.c[2]}"/></linearGradient></defs>` +
    `<circle cx="32" cy="33" r="26" fill="#0b1630" stroke="url(#${g})" stroke-width="4"/>` +
    (t.n ? pos.map(([x, y, s]) => one(x, y, s)).join('') : `<path d="M24 33 L40 33" stroke="${t.c[1]}" stroke-width="3" stroke-linecap="round"/>`) + '</svg>';
  return (tierIconCache[key] = 'data:image/svg+xml;base64,' + btoa(svg));
}
// アイコンだけ（報酬タブの預入期間・資産シミュレーション・EARN 割合の表で使う）
const tierIcon = (name) => el('img', { class: 'tier-icon', src: tierIconUrl(tierStyleKey(name)), alt: '', width: '16', height: '16' });

const fishBadge = (name, big) => el('span', { class: 'fish' + (big ? ' big' : ''), title: name + '（' + (FISH_JA[name] || '') + '）' }, FISH_EMOJI[name] || '');

// 分配後の持ち分（Manager 分・Agent 分）。Agent アプリは Manager 分を一覧に出さないが、人数・順位には数える
// EARN VIEWER：分割しないので、EARN の枚数をそのまま1行（自分）にする。名前は「自分」（設定の「ランキングでの表示名」で変えられる）
function splitShares(split) {
  if (!split) return [];
  return [{ id: 'me', name: (rankSelfName || '').trim() || '自分', share: Number(split.amount), show: true }];
}

// targets：[{ id, name, share }]（報酬タブと同じ対象・順番）
function renderRankingTab(targets) {
  const rg = data.ranking;
  const split = data.transfers.find((x) => x.cls === 'split');
  const ok = rg && rg.source && ranks.old && ranks.new;
  $('rankNote').hidden = !!ok;
  $('rankNote').textContent = !rg ? 'このデータには保有者ランキングが入っていません。'
    : 'ランク表が読み込まれていないため、ランキングを計算できません。' + FETCH_HINT() + 'で、新しいデータを読み込んでください。';
  $('rankBody').hidden = !ok;
  if (!ok) return;

  const sym = data.token.symbol;
  const now = Math.floor(Date.now() / 1000);
  const v = rankingView(now);
  // 分配しているときは、配布先の行を外し、分配後の Manager 分・Agent 分を差し込む（報酬タブと同じ計算）
  // ただし Manager アプリで「保有枚数の表示」が合算だけのときは、配布先の行をほかの保有者と同じくアドレスで（合算の枚数で）そのまま出す（2026-10 ユーザー決定）
  const merged = APP.id === 'manager' && targets.length > 0 && targets.every((w) => w.id === 'total');
  const selfAddr = split ? (rg.self || '').toLowerCase() : '';
  const self = merged ? '' : selfAddr; // 一覧から外す行
  const s = split ? Reward.settled(split, rewardRanks(), now) : null; // 自分の報酬は、新EARN Tier に倍率を掛けて計算（ほかの人は表の APY のまま）
  // 手元（ウォレットの残高）は、取得のときに balanceOf で読んだデータの値（wallet）を使う（ランキングの値より新しい）
  const selfWallet = Number(data.wallet && data.wallet.amount) || 0;
  const shares = (merged ? [] : splitShares(split)).map((x) => {
    const wallet = selfWallet;
    const reward = x.share * s.factor;
    return { ...x, wallet, reward, total: wallet + x.share + reward };
  });
  const ins = (rows, extra) => [...rows.filter((r) => r.address !== self).map((r, i) => ({ ...r, otherNo: i + 1 })), ...shares.map(extra)]
    .sort((a, b) => b.total - a.total).map((r, i) => ({ ...r, no: i + 1 }));
  const holders = ins(v.holders, (x) => ({ split: x, wallet: x.wallet, principal: x.share, reward: x.reward, total: x.total, share: x.total / v.supply * 100, fish: Fish.classify(x.total, v.supply).name }));
  // 預入（EARN）ランキング：ウォレット残高＋元本＋報酬の多い順（2026-10 ユーザー指示。以前は元本＋報酬だけ）
  //   ウォレット残高は保有者の一覧（v.holders）から。自分の行は取得のときの残高（selfWallet）
  const walletOf_ = new Map(v.holders.map((h) => [h.address, h.wallet]));
  const deps = v.depositors.map((r) => { const wallet = walletOf_.get(r.address) || 0; return { ...r, wallet, total: wallet + r.principal + r.reward }; });
  // 保有者の順位で、預けている人の EARN Tier（枚数の前にアイコンを出す。2026-10 ユーザー指示）
  const tierOfAddr = new Map(deps.map((r) => [r.address, r.rankName]));
  const depositors = ins(deps, (x) => ({ split: x, wallet: x.wallet, principal: x.share, reward: x.reward, total: x.total, rankName: s.rankNow ? s.rankNow.name : null, rate: s.rateNow }));
  const others = v.holders.filter((h) => h.address !== self);

  // 一番上：保有枚数と推定順位（Manager 分・Agent 分は一覧の中の順位、合算はほかの保有者と比べた順位）
  const multi = APP.id === 'manager';
  $('rankCards').replaceChildren(...(targets.length ? [] : [el('div', { class: 'card' }, el('p', { class: 'muted' }, split ? '表示する対象がありません。「設定」の「保有枚数の表示」で選んでください。' : '「EARN」に仕分けた取引がないため、保有枚数はありません。'))]),
    ...targets.map((w, wi) => {
      // 保有枚数：分配＋報酬。Manager 分と合算には配布先の手元も入れる
      const amount = w.share + w.share * s.factor + selfWallet;
      const mergedRow = merged ? holders.find((r) => r.address === selfAddr) : null;
      // 推定順位は選んでいる枠に合わせる（2026-10 ユーザー指示）：保有者＝保有者全体の中、EARN＝EARN 利用者の中（どちらもウォレット残高＋元本＋報酬）
      const earn = rankListKind === 'depositors' || rankListKind === 'rankShare';
      const list = earn ? depositors : holders;
      const row = merged ? list.find((r) => r.address === selfAddr) : list.find((r) => r.split && r.split.id === w.id);
      const base = earn ? deps.filter((h) => h.address !== self) : others;
      const cmpAmount = amount;
      const est = row ? row.no : base.filter((h) => h.total > cmpAmount).length + 1;
      const of = row ? list.length : base.length + 1;
      const canJump = row && (merged || row.split.show);
      const shownAmount = mergedRow ? mergedRow.total : amount;
      const f = Fish.classify(shownAmount, v.supply).name;
      return el('div', { class: 'card asset-hero rank-me' },
        el('div', { class: 'sym' }, multi ? '保有枚数（' + labelOf_(w) + '）' : '保有枚数'),
        el('div', { class: 'hero-row' }, coinIcons[w.id] ? el('img', { class: 'coin-icon', src: coinIcons[w.id], alt: '' }) : null,
          el('span', { class: 'hero-val' }, hid(fmtInt(shownAmount)) + ' ' + sym), wi === 0 ? eyeButton() : null),
        el('div', { class: 'rank-est' }, showYen ? fishBadge(f, true) : el('span', { class: 'fish big hidden-fish' }, '？'),
          el('div', {}, el(canJump && showYen ? 'button' : 'div', { class: 'rank-est-no' + (canJump && showYen ? ' jump' : ''), type: 'button', onclick: canJump && showYen ? () => jumpToRank(w.id, earn ? 'depositors' : 'holders') : null },
            '推定 ', el('b', {}, hid(est.toLocaleString('ja-JP')) + '位'), el('span', { class: 'muted' }, '（' + (earn ? 'EARN利用者' : '全保有者') + '：' + of.toLocaleString('ja-JP') + '人中）')),
            el('div', { class: 'muted' }, showYen ? f + '（' + FISH_JA[f] + '）・総供給量の ' + (shownAmount / v.supply * 100).toFixed(3) + '%' : HIDDEN))),
        rankProgress(row ? list.filter((r) => r !== row) : base, shownAmount, est, sym));
    }));

  // ① 保有者ランキング／② 預入ランキング／③ EARN（ランク＝レベル別の人数）／④ Tier（魚分類）の割合
  document.querySelectorAll('#rankSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.list === rankListKind)));
  const isShare = rankListKind === 'rankShare' || rankListKind === 'fishShare';
  $('rankShareBox').hidden = !isShare;
  $('rankList').hidden = isShare;
  if (isShare) {
    $('rankMore').hidden = true;
    renderShare(rankListKind === 'rankShare' ? rankShareOf(depositors, holders) : fishShareOf(holders, v), rankListKind);
    return;
  }
  const list = (rankListKind === 'holders' ? holders : depositors).filter((r) => !r.split || r.split.show);
  const shown = list.slice(0, rankShown);
  $('rankList').replaceChildren(...shown.map((r) => {
    const sub = rankListKind === 'holders'
      // 行の内訳は英字（Wallet・Deposit・Reward。2026-10 ユーザー指示。ほかの画面は日本語のまま）
      ? (r.split ? 'Wallet ' + fmtInt(r.wallet) + '・Deposit ' + fmtInt(r.principal) + '・Reward ' + fmtInt(r.reward) : 'Wallet ' + fmtInt(r.wallet) + (r.principal > 0 ? '・Deposit ' + fmtInt(r.principal) + '・Reward ' + fmtInt(r.reward) : '')) + '（' + r.share.toFixed(2) + '%）'
      : 'Wallet ' + fmtInt(r.wallet) + '・Deposit ' + fmtInt(r.principal) + '・Reward ' + fmtInt(r.reward); // EARN Tier は上の行（アドレスと枚数の間）
    const mine = r.split ? r.split.id : merged && r.address === selfAddr ? 'total' : ''; // 自分の行（枠全体を強調・ジャンプ先）
    return el('li', { class: 'rank-row' + (mine ? ' self' : ''), ...(mine ? { 'data-split': mine } : {}) },
      el('div', { class: 'rank-line' + (rankListKind === 'holders' ? '' : ' earn') },
        el('span', { class: 'rk-no' }, String(r.no)),
        // 前回からの順位の変化：EARN は並べ方（ウォレット残高を含める）が保有者ランキング取得エクセルの前回の順位と違うので出さない
        r.split || rankListKind !== 'holders' ? null : rankChange(rankListKind, r.address, merged ? r.no : r.otherNo, !merged),
        // アイコンはアドレスの前（保有者は魚の分類、EARN は EARN Tier）。EARN Tier の名前はアドレスの後に、先頭をそろえて（2026-10 ユーザー指示）
        rankListKind === 'holders' ? fishBadge(r.fish) : tierIcon(r.rankName),
        r.split ? el('span', { class: 'rk-name' }, r.split.name) : el('button', { class: 'cp', type: 'button', onclick: () => openNameDialog(r.address) }, nameOf(r.address)),
        rankListKind === 'holders' ? null : el('span', { class: 'rk-tname' }, r.rankName || 'ランク外'),
        // 保有者の順位：預けている人（自分の行は EARN があるとき）だけ、枚数の前に EARN Tier のアイコン
        rankListKind === 'holders' && (r.split ? true : r.principal > 0) ? tierIcon(r.split ? (s.rankNow && s.rankNow.name) : tierOfAddr.get(r.address)) : null,
        el('span', { class: 'rk-total' }, fmtInt(r.total) + ' ' + sym)),
      el('div', { class: 'rank-sub' }, sub));
  }));
  fitRankLines();
  $('rankMore').hidden = list.length <= rankShown;
  $('rankMore').textContent = 'さらに表示（' + Math.min(RANK_PAGE, list.length - rankShown) + '件／残り ' + (list.length - rankShown) + '件）';
  // 次の順位まで（2026-10 ユーザー指示）：自分より多い人のうちいちばん少ない人を抜くのに、あと何枚か
// バーは、すぐ下の人（いなければ 0）からすぐ上の人までのどこにいるか。1位なら満タン
function rankProgress(others, amount, est, sym) {
  const above = others.filter((r) => r.total > amount).reduce((m, r) => Math.min(m, r.total), Infinity);
  if (above === Infinity) return progressBlock('次の順位', hid('1位です'), 1);
  const below = others.filter((r) => r.total <= amount).reduce((m, r) => Math.max(m, r.total), 0);
  return progressBlock('次の順位（' + hid((est - 1).toLocaleString('ja-JP')) + '位）まで',
    'あと ' + hid(fmtInt(Math.floor(above - amount) + 1)) + ' ' + sym, (amount - below) / (above - below));
}

// 推定順位を押したとき：その行まで移って、一瞬光らせる
  if (rankJump) {
    const li = document.querySelector('#rankList li[data-split="' + rankJump + '"]');
    rankJump = null;
    if (li) {
      const top = li.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
    }
  }
}

// 一覧の行を1行に収める：はみ出す行だけ文字を少しずつ小さくする（内訳は 9px まで、上の行の枚数は 11px まで）
// 一覧が見えていないとき（幅が 0）は何もしない。タブを開いたとき・画面の幅が変わったときにやり直す
function fitRankLines() {
  const list = $('rankList');
  if (!list || !list.clientWidth) return;
  const shrink = (e, min) => {
    e.style.fontSize = '';
    let fs = parseFloat(getComputedStyle(e).fontSize);
    while (e.scrollWidth > e.clientWidth + 1 && fs > min) { fs -= 0.5; e.style.fontSize = fs + 'px'; }
  };
  list.querySelectorAll('.rank-sub').forEach((e) => shrink(e, 9));
  list.querySelectorAll('.rank-line').forEach((line) => {
    const t = line.querySelector('.rk-total');
    if (!t) return;
    t.style.fontSize = '';
    let fs = parseFloat(getComputedStyle(t).fontSize);
    while (line.scrollWidth > line.clientWidth + 1 && fs > 11) { fs -= 0.5; t.style.fontSize = fs + 'px'; }
  });
}
document.querySelector('[data-tab=ranking]').addEventListener('click', () => setTimeout(fitRankLines, 0));
window.addEventListener('resize', () => { clearTimeout(fitRankLines.timer); fitRankLines.timer = setTimeout(fitRankLines, 150); });

// 推定順位を押したとき：その順位の一覧（保有者または EARN）に切り替え、その行が出るまで表示を広げてから移る
function jumpToRank(id, kind = 'holders') {
  rankListKind = kind;
  const li = () => document.querySelector('#rankList li[data-split="' + id + '"]');
  rankJump = id;
  rankShown = Math.max(rankShown, RANK_PAGE);
  refreshAll();
  for (let guard = 0; !li() && !$('rankMore').hidden && guard < 50; guard++) { rankShown += RANK_PAGE; rankJump = id; refreshAll(); }
}

document.querySelectorAll('#rankSeg button').forEach((b) => b.addEventListener('click', () => { rankListKind = b.dataset.list; rankShown = RANK_PAGE; refreshAll(); }));
$('rankMore').addEventListener('click', () => { rankShown += RANK_PAGE; refreshAll(); });

// ---- ③ EARN（レベル別の人数・APY）・④ Tier（魚分類）の割合（ドーナツと表）。Community（運営）の名前・画像・色はデータで配られる
// 色：順序のある区分なので青1色の濃淡（暗い地では、低い区分ほど地に近い暗い青、高いほど明るい青）。運営（Community）・ランク外は灰色
// （dataviz の検証：#184f95,#256abf,#3987e5,#6da7ec,#9ec5f4,#cde2fb,#eef5fe の7段を --ordinal --mode dark --surface #0c1428 で合格。
//   いちばん濃い #184f95 は運営（Community）の標準の色と EARN の「利用あり」専用。区分（Tier・レベル）は残りの6段。#184f95 より濃い青は地に溶けて検証に通らない（2026-10）。灰色 #6b7488 は地に 3.9:1）
const SHARE_DARKEST = '#184f95';
const SHARE_RAMP = ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb', '#eef5fe'];
const SHARE_GRAY = '#6b7488';
const SHARE_GRAY_DARK = '#454e60'; // EARN の「預入なし」（地に 2.19:1。レベル外の灰色より暗い）
const rampFor = (n) => Array.from({ length: n }, (_, i) => SHARE_RAMP[n === 1 ? SHARE_RAMP.length - 1 : Math.round(i * (SHARE_RAMP.length - 1) / (n - 1))]); // 低い→高い
let shareSel = { rankShare: null, fishShare: null }; // 押して選んだ区分

// ③ EARN：保有者全員の、ランク（画面では「レベル」）別の人数。預けていない人は「預入なし」（2026-10 ユーザー指示）
//   一覧と同じく、分配の行は Manager 分・Agent 分として数える。上位のレベルから
// APY：今日の時点で使うランク表（新ランク表の開始日より前なら旧、以降なら新）の、そのレベルの年利
function rankShareOf(depositors, holders) {
  const names = [];
  for (const r of [...ranks.new.ranks, ...ranks.old.ranks].reverse()) if (!names.includes(r.name)) names.push(r.name); // 上位から
  const OUT = 'レベル外';
  const colors = rampFor(names.length).reverse();
  const nowTable = Date.now() / 1000 >= Date.parse(ranks.new.startDate + 'T00:00:00+09:00') / 1000 ? ranks.new.ranks : ranks.old.ranks;
  const apyOf = (name) => { const r = nowTable.find((x) => x.name === name); return r ? pct(r.rate) : '—'; };
  const NONE = '利用なし'; // EARN を利用していない（預けていない）人
  const rows = [...names, OUT].map((name, i) => ({ key: name, label: name, color: name === OUT ? SHARE_GRAY : colors[i], apy: name === OUT ? '—' : apyOf(name), count: depositors.filter((p) => (p.rankName || OUT) === name).length }));
  rows.push({ key: NONE, label: NONE, color: SHARE_GRAY_DARK, apy: '—', count: holders.filter((h) => !(h.principal > 0)).length });
  const total = rows.reduce((t, r) => t + r.count, 0);
  const used = total - rows[rows.length - 1].count; // 利用あり＝レベル（レベル外を含む）の人数
  return {
    unit: '人', total, used, usedRatio: total ? used / total : 0, NONE,
    center: (total ? (used / total * 100).toFixed(1) : '0') + '%', centerSub: 'EARN 利用者（' + used.toLocaleString('ja-JP') + '／' + total.toLocaleString('ja-JP') + '人）',
    rows: rows.filter((r) => r.count > 0 || (r.key !== OUT && r.key !== NONE)).map((r) => ({ ...r, value: r.count, ratio: total ? r.count / total : 0 })),
  };
}

// ④：手元＋元本（報酬は入れない）の分類別の枚数。運営は Community。分配の行は Manager 分・Agent 分として数える
function fishShareOf(holders, v) {
  const items = holders.map((h) => ({ amount: h.wallet + h.principal, community: false }));
  const base = Fish.share(items, v.supply);
  const com = v.fishShare.find((x) => x.name === Fish.COMMUNITY.name);
  const rows = base.map((x) => (x.name === Fish.COMMUNITY.name ? { ...x, count: com.count, amount: com.amount } : x));
  const total = rows.reduce((t, r) => t + r.amount, 0);
  const colors = rampFor(Fish.CLASSES.length).reverse(); // Whale が明るい
  return {
    unit: data.token.symbol, total, center: rows.reduce((t, r) => t + r.count, 0).toLocaleString('ja-JP') + '件', centerSub: '保有者（運営を含む）',
    rows: rows.map((r) => {
      const ci = Fish.CLASSES.findIndex((c) => c.name === r.name);
      const com = ci < 0;
      const text = com ? comName() : r.name + '（' + Fish.CLASSES[ci].ja + '）';
      return { key: r.name, text, label: (FISH_EMOJI[r.name] ? FISH_EMOJI[r.name] + ' ' : '') + text, image: com ? communityStyle.image : '', color: com ? comColor() : colors[ci], count: r.count, value: r.amount, ratio: total ? r.amount / total : 0 };
    }),
  };
}

const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const pctText = (r) => (r * 100 >= 10 ? (r * 100).toFixed(1) : (r * 100).toFixed(2)) + '%';

function renderShare(d, kind) {
  const sel = shareSel[kind];
  const pick = (key) => { shareSel[kind] = shareSel[kind] === key ? null : key; refreshAll(); };
  // ドーナツ（上から時計回り。区分の間に地の色のすき間）
  // EARN利用者比率：輪の外側 1/3 に利用ありの範囲（いちばん濃い色）、内側 2/3 に内訳（レベル・利用なし）
  const S = 220, C = S / 2, RO = 100, RI = 62;
  const svg = svgEl('svg', { viewBox: `0 0 ${S} ${S}`, class: 'donut', role: 'img', 'aria-label': kind === 'rankShare' ? 'EARN利用者比率' : 'トークン配分内訳' });
  const pt = (r, a) => [C + r * Math.cos(a), C + r * Math.sin(a)];
  const arc = (a0, a1, ro, ri) => {
    if (a1 - a0 >= Math.PI * 2 - 1e-4) return `M ${C} ${C - ro} A ${ro} ${ro} 0 1 1 ${C - 0.01} ${C - ro} Z M ${C} ${C - ri} A ${ri} ${ri} 0 1 0 ${C - 0.01} ${C - ri} Z`;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = pt(ro, a0), [x1, y1] = pt(ro, a1), [x2, y2] = pt(ri, a1), [x3, y3] = pt(ri, a0);
    return `M ${x0} ${y0} A ${ro} ${ro} 0 ${big} 1 ${x1} ${y1} L ${x2} ${y2} A ${ri} ${ri} 0 ${big} 0 ${x3} ${y3} Z`;
  };
  const twoRings = kind === 'rankShare';
  const inRO = twoRings ? RI + (RO - RI) * 2 / 3 : RO; // 内訳の輪の外径
  let a0 = -Math.PI / 2;
  // 選んだ区分以外を薄くする（「利用あり」を選んだときは、レベルの区分と外側の輪を残す）
  const isUsed = (key) => twoRings && key !== d.NONE;
  const lit = (key) => !sel || sel === key || (sel === '__used' && (key === '__used' || isUsed(key)));
  for (const r of d.rows) {
    if (!(r.ratio > 0)) continue;
    const a1 = a0 + r.ratio * Math.PI * 2;
    const ro = twoRings && r.key !== d.NONE ? inRO : RO; // 利用なしは輪の全体の太さ
    const seg = svgEl('path', { d: arc(a0, a1, ro, RI), fill: r.color, class: 'seg-arc' + (lit(r.key) ? '' : ' dim') + (sel === r.key ? ' on' : ''), 'fill-rule': 'evenodd' });
    const tip = svgEl('title', {}); tip.textContent = r.label + '：' + pctText(r.ratio); seg.appendChild(tip);
    seg.addEventListener('click', () => pick(r.key));
    svg.appendChild(seg);
    a0 = a1;
  }
  if (twoRings && d.usedRatio > 0) {
    const b0 = -Math.PI / 2;
    const used = svgEl('path', { d: arc(b0, b0 + d.usedRatio * Math.PI * 2, RO, inRO + 2), fill: SHARE_DARKEST, class: 'seg-arc used-arc' + (lit('__used') ? '' : ' dim') + (sel === '__used' ? ' on' : ''), 'fill-rule': 'evenodd' });
    const tip = svgEl('title', {}); tip.textContent = '利用あり：' + pctText(d.usedRatio); used.appendChild(tip);
    used.addEventListener('click', () => pick('__used'));
    svg.appendChild(used);
  }
  const s = sel === '__used' ? { ratio: d.usedRatio, text: '利用あり' } : d.rows.find((r) => r.key === sel);
  // トークン配分内訳で区分を選んだときは、真ん中に区分の画像（Tier は絵文字、運営は設定した画像）と割合（2026-10 ユーザー指示）
  const pic = kind === 'fishShare' && s ? (s.image ? { img: s.image } : FISH_EMOJI[s.key] ? { emoji: FISH_EMOJI[s.key] } : null) : null;
  if (pic) {
    if (pic.img) svg.appendChild(svgEl('image', { href: pic.img, x: C - 22, y: C - 44, width: 44, height: 44, preserveAspectRatio: 'xMidYMid meet' }));
    else { const e = svgEl('text', { x: C, y: C - 8, class: 'donut-emoji', 'text-anchor': 'middle' }); e.textContent = pic.emoji; svg.appendChild(e); }
    const t = svgEl('text', { x: C, y: C + 26, class: 'donut-main', 'text-anchor': 'middle' }); t.textContent = pctText(s.ratio);
    svg.appendChild(t);
  } else {
    const t1 = svgEl('text', { x: C, y: C - 4, class: 'donut-main', 'text-anchor': 'middle' }); t1.textContent = s ? pctText(s.ratio) : d.center;
    const t2 = svgEl('text', { x: C, y: C + 18, class: 'donut-sub', 'text-anchor': 'middle' }); t2.textContent = s ? (s.text || s.label) : d.centerSub;
    svg.append(t1, t2);
  }

  // 表（凡例を兼ねる。押すと選ぶ）。EARN利用者比率は 利用あり（その下にレベル）・利用なし の順
  const head = kind === 'rankShare' ? ['EARN Tier', '人数', '割合', 'APY'] : ['Tier', '件数', '枚数', '割合'];
  const rowsForTable = kind === 'rankShare'
    ? [{ key: '__used', label: '利用あり', head: true, count: d.used, ratio: d.usedRatio, apy: '' }, ...d.rows.filter((r) => r.key !== d.NONE).map((r) => ({ ...r, sub: true })), ...d.rows.filter((r) => r.key === d.NONE).map((r) => ({ ...r, head: true }))]
    : d.rows;
  const table = el('table', { class: 'grid share-table' },
    el('tr', {}, ...head.map((h, i) => el('th', i ? { class: 'num' } : {}, h))),
    ...rowsForTable.map((r) => {
      const tr = el('tr', { class: (lit(r.key) ? '' : 'dim') + (sel === r.key ? ' on' : '') + (r.sub ? ' sub' : '') + (r.head ? ' head' : '') },
        el('td', {}, r.key === '__used' ? el('span', { class: 'swatch', style: 'background:' + SHARE_DARKEST }) : el('span', { class: 'swatch', style: 'background:' + r.color }), r.image ? el('img', { class: 'share-img', src: r.image, alt: r.label, title: r.label }) : null, kind === 'rankShare' && r.key !== '__used' ? tierIcon(r.key === d.NONE || r.key === 'レベル外' ? null : r.key) : null, r.image ? null : r.label), // 運営は画像があれば画像だけ。EARN 割合はランクのアイコンも
        el('td', { class: 'num' }, r.count.toLocaleString('ja-JP')),
        ...(kind === 'fishShare' ? [el('td', { class: 'num' }, fmtInt(r.value))] : []),
        el('td', { class: 'num' }, pctText(r.ratio)),
        ...(kind === 'rankShare' ? [el('td', { class: 'num' }, r.apy)] : []));
      tr.addEventListener('click', () => pick(r.key));
      return tr;
    }));
  $('rankShareBox').replaceChildren(el('h2', {}, kind === 'rankShare' ? 'EARN利用者比率' : 'トークン配分内訳'), el('div', { class: 'donut-wrap' }, svg), el('div', { class: 'scroll' }, table));
}

// ---- Community（運営）の表示：名前・色・画像はデータで配られる（views.js の communityStyle。取得エクセルの設定シートで決める）
const comName = () => (communityStyle.name || '').trim() || 'Community';
const comColor = () => (/^#[0-9a-f]{6}$/i.test(communityStyle.color || '') ? communityStyle.color : SHARE_DARKEST); // 標準はいちばん濃い色

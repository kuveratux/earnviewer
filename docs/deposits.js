'use strict';

// 預け先に隠れている保有者の計算（ほかのツールでも使う共通部品。ブラウザと Node の両方で使える）
//
// ・預け先は普通のアドレス（コントラクトではない）なので、誰がいくら預けたかは預け先とのやり取り（Transfer）から割り出す
// ・入金（預け先への送付）：送った人の預け入れ
// ・返却（預け先からの送付）：報酬込みで返す運用。その時点までのその人の預け入れを「元本＋報酬で全部精算」とみなし 0 に戻す
//     元本ちょうどの返却も精算済み。返却のあと預け直したら新しい預け入れ
//     預け入れのない人への返却は「対応のない返却」として別に数える
// ・除外アドレス（運営の資金移動など）とのやり取りは、預け入れ・返却として数えない
// ・報酬：EARN VIEWER 1.0.8 の shared/reward.js（settled）と同じルール（この部品だけで動くよう、同じ計算をここに書く）
//     日数：入金の日時から24時間後を1日目とし、now までに経過した24時間の回数。入金ごとに数える
//     年利：k 日目の時点 m（入金日時＋k×24時間）が新ランク表の開始日（日本時間 0:00）より前なら旧ランク表、以降なら新ランク表
//     ランク（Tier）：**その時点 m までに入った、精算されていない入金の合計**が、ランク表の「下限」以上かで決める
//       （2026-10-22 E-38 ユーザー決定。例：7/1 に 500、9/15 に 600 なら 7/1〜9/14 は 500 枚、9/15 からは 1,100 枚の Tier。
//        報酬は合計に入れない。返却で精算したら合計は 0 から数え直す。最下位の下限未満は「ランク外」で年利 0）
//     報酬：入金の枚数 × その日の年利 ÷ 365 を1日ずつ足す（単利）。入金が1件なら 旧・新の日数 × 年利 でまとめて計算（結果は同じ）
//     今のランク（表示用の rankName・rate）は今の合計で決める（今日の時点ではすべての入金が入っているので、その日までの合計＝今の合計）
// ・預け先の残高との差：預けた人の元本の合計 − 預け先の実際の残高（元本だけで比べる。未払いの報酬は入れない）
//     差 ＝ 除外への出金 − 除外からの入金 ＋ 返却で上乗せされた報酬 ＋ 対応のない返却 − 精算で戻らなかった元本
//     （最後の項は、元本より少なく返却されたときの不足分）
// ・取得（RPC）と表示はこのファイルに入れない（呼ぶ側の仕事）

const Deposits = (() => {
  const DAY = 86400;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const jstMidnight = (ymd) => Date.parse(ymd + 'T00:00:00+09:00') / 1000;

  // 最小単位（BigInt）を枚数（Number）に。ランクの判定と報酬の計算は ESV と同じく Number で行う
  function toTokens(value, decimals) {
    const keep = Math.min(decimals, 6);
    return Number(value / 10n ** BigInt(decimals - keep)) / 10 ** keep;
  }

  // 枚数が下限以上の、いちばん上のランク。どれにも届かなければ null（ランク外）
  function rankFor(ranks, amount) {
    let hit = null;
    for (const r of ranks) if (amount >= r.min) hit = r;
    return hit;
  }

  // 入金1件の確定分の日数（旧・新）。reward.js の settled と同じ数え方
  function daysOf(t, rk, now) {
    const days = Math.max(0, Math.floor((now - t) / DAY));
    const newStart = jstMidnight(rk.new.startDate);
    const oldDays = Math.min(days, Math.max(0, Math.ceil((newStart - t) / DAY) - 1));
    return { days, oldDays, newDays: days - oldDays };
  }

  // 精算されていない入金 [{ t, amount（枚数） }]（古い順）の報酬の確定分。EARN VIEWER 1.0.8 の reward.js（settled）と同じ計算
  //   1件：今の合計で旧・新のランクを決め、旧・新の日数 × 年利（1件なら今の合計＝その日までの合計なので同じ結果）
  //   複数：入金ごとに k 日目の時点 m で、m までに入った入金の合計でランクを決め、m で旧・新のランク表を選んで1日分ずつ足す
  function rewardOf(list, rk, now, newStart = jstMidnight(rk.new.startDate)) {
    if (!list.length) return 0;
    if (list.length === 1) {
      const e = list[0];
      const n = daysOf(e.t, rk, now);
      const rOld = rankFor(rk.old.ranks, e.amount);
      const rNew = rankFor(rk.new.ranks, e.amount);
      return e.amount * ((rOld ? rOld.rate : 0) * n.oldDays + (rNew ? rNew.rate : 0) * n.newDays) / 365;
    }
    let reward = 0;
    for (const e of list) {
      const n = Math.max(0, Math.floor((now - e.t) / DAY));
      for (let k = 1; k <= n; k++) {
        const m = e.t + k * DAY;
        const sum = list.reduce((a, x) => (x.t <= m ? a + x.amount : a), 0);
        const r = rankFor(m < newStart ? rk.old.ranks : rk.new.ranks, sum);
        reward += e.amount * (r ? r.rate : 0) / 365;
      }
    }
    return reward;
  }

  // events：預け先とのやり取り [{ t（UNIX 秒）, from, to, value（BigInt） }]。古い順（同じブロックはログの順）に並べて渡す
  // opts：{ custodian, exclude（アドレスの配列）, ranks（{ old: { ranks }, new: { ranks, startDate } }）, now（UNIX 秒）, decimals }
  function compute(events, opts) {
    const custodian = opts.custodian.toLowerCase();
    const skip = new Set([ZERO, ...(opts.exclude || []).map((a) => a.toLowerCase())]);
    const dec = opts.decimals;
    const people = new Map(); // アドレス → { open: [{ t, value }], deposits, returns, settled }
    const person = (a) => {
      if (!people.has(a)) people.set(a, { open: [], deposits: 0, returns: 0, settled: 0n, returned: 0n });
      return people.get(a);
    };
    const s = { inTotal: 0n, outTotal: 0n, excludedIn: 0n, excludedOut: 0n, rewardsPaid: 0n, shortfall: 0n, unmatched: [] };

    for (const e of events) {
      const from = e.from.toLowerCase(), to = e.to.toLowerCase(), v = e.value;
      if (from === custodian && to === custodian) continue; // 自分あて
      if (to === custodian) {
        s.inTotal += v;
        if (skip.has(from)) { s.excludedIn += v; continue; }
        const p = person(from);
        p.open.push({ t: e.t, value: v });
        p.deposits++;
      } else if (from === custodian) {
        s.outTotal += v;
        if (skip.has(to)) { s.excludedOut += v; continue; }
        const p = people.get(to);
        if (!p || !p.open.length) { s.unmatched.push({ t: e.t, to, value: v }); continue; }
        // 精算：それまでの預け入れを全部閉じる
        const principal = p.open.reduce((x, d) => x + d.value, 0n);
        if (v >= principal) s.rewardsPaid += v - principal;
        else s.shortfall += principal - v;
        p.settled += principal;
        p.returned += v;
        p.returns++;
        p.open = [];
      }
    }

    // 今の預け入れ（元本）と報酬
    const list = [];
    let principalSum = 0n;
    const now = opts.now;
    // 今のランク：次の1日（days＋1 日目）に使うランク表で決める（reward.js と同じ）。入金が複数あるときは、いちばん古い入金で数える
    const newStart = jstMidnight(opts.ranks.new.startDate);
    const tableNext = (t) => (t + (daysOf(t, opts.ranks, now).days + 1) * DAY < newStart ? opts.ranks.old.ranks : opts.ranks.new.ranks);
    for (const [address, p] of people) {
      const principal = p.open.reduce((x, d) => x + d.value, 0n);
      principalSum += principal;
      const total = toTokens(principal, dec);
      const reward = rewardOf(p.open.map((d) => ({ t: d.t, amount: toTokens(d.value, dec) })), opts.ranks, now, newStart);
      const rankNow = p.open.length ? rankFor(tableNext(p.open[0].t), total) : null;
      list.push({
        address,
        principal,                 // 元本（BigInt、最小単位）
        principalTokens: total,    // 元本（枚数）
        reward,                    // 報酬の確定分（枚数）
        rankName: rankNow ? rankNow.name : null, // 今のランク（次の1日に使うランク表で）
        rate: rankNow ? rankNow.rate : 0,
        openDeposits: p.open.length, // 精算されていない入金の件数
        open: p.open.map((d) => ({ t: d.t, value: d.value })), // 精算されていない入金（日時・枚数。表示時点で報酬を計算し直す元）
        firstOpen: p.open.length ? p.open[0].t : null,
        deposits: p.deposits,      // 入金の件数（精算済みも含む）
        returns: p.returns,        // 返却の件数
      });
    }
    list.sort((a, b) => (a.principal === b.principal ? (a.address < b.address ? -1 : 1) : (a.principal > b.principal ? -1 : 1)));

    const balance = s.inTotal - s.outTotal; // 預け先の残高（やり取りからの計算）
    const unmatchedSum = s.unmatched.reduce((x, u) => x + u.value, 0n);
    return {
      people: list,
      principalSum,
      balance,
      gap: principalSum - balance,
      // 差の内訳（足すと gap になる）
      gapParts: { excludedOut: s.excludedOut, excludedIn: -s.excludedIn, rewardsPaid: s.rewardsPaid, unmatched: unmatchedSum, shortfall: -s.shortfall },
      unmatched: s.unmatched,
      inTotal: s.inTotal,
      outTotal: s.outTotal,
    };
  }

  // 手元の保有（Map: アドレス → BigInt。holders.js の残高）と預け入れを合わせたランキング
  // 預け先・0x000…000・opts.exclude は載せない。並びは 合計（手元＋元本＋報酬、枚数）の多い順
  function combine(wallet, dep, opts) {
    const skip = new Set([ZERO, opts.custodian.toLowerCase(), ...(opts.exclude || []).map((a) => a.toLowerCase())]);
    const dec = opts.decimals;
    const rows = new Map();
    const row = (a) => {
      if (!rows.has(a)) rows.set(a, { address: a, wallet: 0n, principal: 0n, reward: 0, rankName: null, rate: 0 });
      return rows.get(a);
    };
    for (const [a, b] of wallet) if (b > 0n && !skip.has(a)) row(a).wallet = b;
    for (const p of dep.people) {
      if (p.principal <= 0n || skip.has(p.address)) continue;
      Object.assign(row(p.address), { principal: p.principal, reward: p.reward, rankName: p.rankName, rate: p.rate });
    }
    const list = [...rows.values()].map((r) => ({ ...r, total: toTokens(r.wallet + r.principal, dec) + r.reward }));
    list.sort((a, b) => (a.total === b.total ? (a.address < b.address ? -1 : 1) : b.total - a.total));
    list.forEach((r, i) => { r.no = i + 1; }); // 順位
    return list;
  }

  return { DAY, ZERO, toTokens, rankFor, daysOf, rewardOf, compute, combine };
})();

if (typeof module !== 'undefined') module.exports = Deposits;

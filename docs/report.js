'use strict';

// 4つの観点を作る（ほかのツールでも使う共通部品。ブラウザと Node の両方で使える）
//   ① 保有者ランキング：手元＋元本＋報酬の多い順、魚分類つき（分類は報酬を入れた合計で決める）
//   ② 預入ランキング：預けている人だけ、元本＋報酬の多い順、ランク名・年利つき
//   ③ ランク割合：預けている人のランク別の人数
//   ④ 魚分類の割合：預け先の中の人を分けて、手元＋元本（報酬は入れない＝発行済みの枚数）の分類別の枚数。運営は Community
//
// 報酬は表示した時点（now）で計算する。そのため、元データ（source）だけを持っておけば、アプリが開いたときに作り直せる
// source（JSON にできる形。枚数は最小単位の文字列）：
//   { decimals, totalSupply, custodian, community: [アドレス], ranks: { old: { ranks }, new: { ranks, startDate } },
//     wallet: { アドレス: 残高 }, deposits: { アドレス: [{ t, value }] }（精算されていない入金だけ） }
// 使う部品：deposits.js・fish.js（ブラウザでは先に読み込んでおく）

const Report = (() => {
  const Dep = typeof Deposits !== 'undefined' ? Deposits : require('./deposits.js');
  const F = typeof Fish !== 'undefined' ? Fish : require('./fish.js');

  function build(src, now) {
    const dec = src.decimals;
    const tok = (v) => Dep.toTokens(v, dec);
    const supply = tok(BigInt(src.totalSupply));
    const community = new Set(src.community);
    // 預け先・ランク表のないトークンでも①④は作れるようにする
    const ranks = src.ranks || { old: { ranks: [] }, new: { ranks: [], startDate: '2000-01-01' } };
    const custodian = src.custodian || Dep.ZERO;

    // 精算されていない入金を、預け先への入金として計算し直す（元本・報酬・ランクは deposits.js と同じ結果になる）
    const events = [];
    for (const [a, list] of Object.entries(src.deposits || {})) for (const d of list) events.push({ t: d.t, from: a, to: custodian, value: BigInt(d.value) });
    events.sort((x, y) => x.t - y.t);
    const dep = Dep.compute(events, { custodian, exclude: [...community], ranks, now, decimals: dec });
    const wallet = new Map(Object.entries(src.wallet).map(([a, v]) => [a, BigInt(v)]));

    // ①
    const holders = Dep.combine(wallet, dep, { custodian, exclude: [...community], decimals: dec }).map((r) => ({
      no: r.no,
      address: r.address,
      wallet: tok(r.wallet),
      principal: tok(r.principal),
      reward: r.reward,
      total: r.total,
      share: r.total / supply * 100,
      fish: F.classify(r.total, supply).name,
      rankName: r.rankName,
      rate: r.rate,
    }));

    // ②
    const depositors = dep.people.filter((p) => p.principal > 0n)
      .map((p) => ({ address: p.address, principal: p.principalTokens, reward: p.reward, total: p.principalTokens + p.reward, rankName: p.rankName, rate: p.rate, openDeposits: p.openDeposits, firstOpen: p.firstOpen }))
      .sort((a, b) => (a.total === b.total ? (a.address < b.address ? -1 : 1) : b.total - a.total));
    depositors.forEach((p, i) => { p.no = i + 1; });

    // ③：ランク表の並び（上位から）＋ランク外。今のランクは次の1日に使う表で決まるので、名前は旧・新の両方から集める
    const names = [];
    for (const r of [...ranks.new.ranks, ...ranks.old.ranks].reverse()) if (!names.includes(r.name)) names.push(r.name);
    const OUT = 'ランク外';
    const rankShare = [...names, OUT].map((name) => ({ name, count: depositors.filter((p) => (p.rankName || OUT) === name).length }));
    const people = depositors.length;
    rankShare.forEach((x) => { x.ratio = people ? x.count / people : 0; });

    // ④：載せない人（運営）も Community として数える。預け先そのものは数えない（中の人に分けたので）
    const items = holders.map((h) => ({ amount: h.wallet + h.principal, community: false }));
    for (const a of community) items.push({ amount: tok(wallet.get(a) || 0n) + tok((dep.people.find((p) => p.address === a) || { principal: 0n }).principal), community: true });
    const fishShare = F.share(items, supply);

    return { now, supply, holders, depositors, rankShare: rankShare.filter((x) => x.count > 0 || x.name !== OUT), fishShare };
  }

  return { build };
})();

if (typeof module !== 'undefined') module.exports = Report;

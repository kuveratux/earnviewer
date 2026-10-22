'use strict';

// 報酬の計算（Manager・Agent 共通。ブラウザと Node の両方で使える）
//
// ・元の枚数：「EARN」に仕分けた取引の枚数。EARN は複数あってよい（E-35、2026-10-22 ユーザー決定）
// ・日数：EARN ごとに、その日時から24時間後を1日目とし、アプリを開いた時点までに経過した24時間の回数
// ・年利：k 日目の時点（EARN の日時＋k×24時間）が新ランク表の開始日（日本時間 0:00）より前なら旧ランク表、以降なら新ランク表
// ・ランク：その時点までに預けた EARN の枚数の合計（報酬は含めない）が、ランク表の「下限」以上かで決める（最下位の下限未満は「ランク外」で年利 0）
// ・報酬（確定分）：EARN ごとに 枚数 × その日の年利 ÷ 365 を1日ずつ足す（単利）
// ・日数・今のランクの表は、いちばん古い EARN で数える（EARN が1件なら以前と同じ）
// ・見込み（グラフ）：今日の確定分から先を、1日ごとに足していく
//     単利：毎日 取り分 × 年利 ÷ 365 を足す（ランクは合計枚数で決めたまま）
//     複利：毎日 その時点の枚数 × 年利 ÷ 365 を足す。枚数が増えてランクが上がったら年利も上げる
//   どちらも取り分の比率に関係なく同じ伸び方になるので、「元の1枚あたりの枚数（倍率）」で計算する

const Reward = (() => {
  const DAY = 86400;
  const jstMidnight = (ymd) => Date.parse(ymd + 'T00:00:00+09:00') / 1000;

  // 枚数が下限以上の、いちばん上のランク。どれにも届かなければ null（ランク外）
  function rankFor(ranks, amount) {
    let hit = null;
    for (const r of ranks) if (amount >= r.min) hit = r;
    return hit;
  }

  // k 日目に使うランク表
  const tableOn = (split, rk, k) => (split.t + k * DAY < jstMidnight(rk.new.startDate) ? rk.old.ranks : rk.new.ranks);

  // EARN の一覧（1件の { t, amount } でも配列でもよい）を古い順に
  const listOf = (earns) => (Array.isArray(earns) ? earns : [earns]).map((x) => ({ t: x.t, amount: Number(x.amount) })).sort((a, b) => a.t - b.t);

  // 確定分。earns：EARN の取引 [{ t, amount }]（1件なら { t, amount } でもよい）、rk：{ old: { ranks }, new: { ranks, startDate } }、now：UNIX 秒
  // factor は「元の1枚あたりの報酬」（報酬の合計 ÷ EARN の合計）。呼ぶ側は 枚数 × factor で報酬を出す
  function settled(earns, rk, now) {
    const list = listOf(earns);
    const split = list[0];
    const total = list.reduce((a, x) => a + x.amount, 0);
    const days = Math.max(0, Math.floor((now - split.t) / DAY));
    const newStart = jstMidnight(rk.new.startDate);
    const oldDays = Math.min(days, Math.max(0, Math.ceil((newStart - split.t) / DAY) - 1));
    const newDays = days - oldDays;
    const rankOld = rankFor(rk.old.ranks, total);
    const rankNew = rankFor(rk.new.ranks, total);
    const rateOld = rankOld ? rankOld.rate : 0;
    const rateNew = rankNew ? rankNew.rate : 0;
    // 1件なら旧・新の日数でまとめて、複数なら EARN ごとに1日ずつ（その時点までの EARN の合計でランクを決める）
    let reward = total * (rateOld * oldDays + rateNew * newDays) / 365;
    if (list.length > 1) {
      reward = 0;
      for (const e of list) {
        const n = Math.max(0, Math.floor((now - e.t) / DAY));
        for (let k = 1; k <= n; k++) {
          const m = e.t + k * DAY;
          const sum = list.reduce((a, x) => (x.t <= m ? a + x.amount : a), 0);
          const r = rankFor(m < newStart ? rk.old.ranks : rk.new.ranks, sum);
          reward += e.amount * (r ? r.rate : 0) / 365;
        }
      }
    }
    const factor = total > 0 ? reward / total : 0; // 元の1枚あたりの報酬
    // 今の年利：次の1日（days＋1 日目）に使うランク表で、合計枚数から決めたランクの年利（1日・週・月・年の報酬の目安に使う）
    const tableNow = tableOn(split, rk, days + 1);
    const rankNow = rankFor(tableNow, total);
    const rateNow = rankNow ? rankNow.rate : 0;
    return { total, days, oldDays, newDays, rankOld, rankNew, rateOld, rateNew, rankNow, rateNow, tableNow, factor, reward, count: list.length, earns: list, firstDay: split.t + DAY };
  }

  // 日本時間の年月日を n か月ずらした日の 0:00（月末は丸める）
  function addMonthsJst(unix, n) {
    const d = new Date((unix + 9 * 3600) * 1000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + n;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(d.getUTCDate(), last)) / 1000 - 9 * 3600;
  }

  // 見込み。今日から months か月後まで、1か月ごとの倍率（元の1枚あたりの枚数）を返す
  // mode：'simple' | 'compound'。[{ t（その日の日本時間 0:00）, k（その時点の日数）, g（倍率） }]
  // withdraw：年間の引出し（元の1枚あたりの枚数。例：取り分 4,800 で年 480 枚なら 0.1）。0 で止める
  // freq：引出しのタイミング。'day'＝毎日 1/365、'week'＝7日ごと 1/52、'month'＝月に1回 1/12（既定）、'year'＝1年ごとに全部（今日は引かない）
  //   単利：取り崩した分だけ、報酬の元（p）も減る。複利：その時点の枚数に年利をかけるので、引いた分だけ報酬も減る
  //   年利：取り崩しで枚数が減っても下げない（年利は別管理。ユーザー決定）。複利で増えてランクが上がったときは上げる
  // earns は settled と同じ。日数の数え方はいちばん古い EARN から（先の日はすべての EARN が預けてあるので、ランクは合計で決める）
  function project(earns, rk, now, mode, months = 36, withdraw = 0, freq = 'month') {
    const s = settled(earns, rk, now);
    const split = s.earns[0];
    const today = addMonthsJst(now, 0);
    const points = [];
    for (let i = 0; i <= months; i++) {
      const t = i === 0 ? now : addMonthsJst(today, i);
      points.push({ t, k: Math.max(s.days, Math.floor((t - split.t) / DAY)), month: i });
    }
    const per = { day: 365, week: 52, month: 12, year: 1 }[freq] || 12;
    const each = withdraw > 0 ? withdraw / per : 0; // 1回に引く枚数
    let g = 1 + s.factor; // 保有枚数（元の1枚あたり）
    let base = 1;         // 単利の報酬の元（元の1枚あたり）
    const take = () => { const x = Math.min(each, g); g -= x; base = Math.max(0, base - x); };
    let k = s.days;
    for (const p of points) {
      for (; k < p.k; ) {
        k++;
        const table = tableOn(split, rk, k);
        if (mode === 'compound') {
          // 取り崩しで減ってもランクは下げない：今の倍率と 1（取り崩し前の元）の大きいほうで判定
          const r = rankFor(table, s.total * Math.max(g, 1));
          g += g * (r ? r.rate : 0) / 365;
        } else {
          const r = rankFor(table, s.total);
          g += base * (r ? r.rate : 0) / 365;
        }
        // 日・週の引出し（今日から数えて1日目・7日目…。その日の報酬を足したあと）
        if (each && (freq === 'day' || (freq === 'week' && (k - s.days) % 7 === 0))) take();
      }
      // 月・年の引出し（今日は引かない）
      if (each && p.month > 0 && (freq === 'month' || (freq === 'year' && p.month % 12 === 0))) take();
      p.g = g;
    }
    return points;
  }

  return { DAY, rankFor, settled, project, addMonthsJst };
})();

if (typeof module !== 'undefined') module.exports = Reward;

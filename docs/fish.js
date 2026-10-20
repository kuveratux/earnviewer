'use strict';

// 魚分類（ほかのツールでも使う共通部品。ブラウザと Node の両方で使える）
//
// ・総供給量に対する割合で分ける（下限を含む）。米ドル換算の基準もあるが、市場価格のないトークンでも使えるよう割合だけを使う
//     Whale 1%以上／Shark 0.1%以上／Dolphin 0.05%以上／Fish 0.01%以上／Crab 0.001%以上／Shrimp それ未満
// ・運営のアドレスは呼ぶ側が判断して COMMUNITY にする（このファイルはアドレスを知らない）

const Fish = (() => {
  const CLASSES = [
    { name: 'Whale', ja: 'クジラ', min: 1 },
    { name: 'Shark', ja: 'サメ', min: 0.1 },
    { name: 'Dolphin', ja: 'イルカ', min: 0.05 },
    { name: 'Fish', ja: '魚', min: 0.01 },
    { name: 'Crab', ja: 'カニ', min: 0.001 },
    { name: 'Shrimp', ja: 'エビ', min: 0 },
  ];
  const COMMUNITY = { name: 'Community', ja: '運営', min: null };
  const ORDER = [COMMUNITY.name, ...CLASSES.map((c) => c.name)]; // 円グラフ・表の並び

  // 枚数と総供給量（どちらも同じ単位の Number）から分類を返す。割合（%）にしてから比べると境目で誤差が出るので、枚数で比べる
  function classify(amount, supply) {
    for (const c of CLASSES) if (amount >= supply * c.min / 100) return c;
    return CLASSES[CLASSES.length - 1];
  }

  // 分類ごとの件数と枚数。items：[{ amount, community（true なら Community） }]
  function share(items, supply) {
    const g = new Map(ORDER.map((n) => [n, { name: n, count: 0, amount: 0 }]));
    let total = 0;
    for (const it of items) {
      if (!(it.amount > 0)) continue;
      const name = it.community ? COMMUNITY.name : classify(it.amount, supply).name;
      g.get(name).count++;
      g.get(name).amount += it.amount;
      total += it.amount;
    }
    return [...g.values()].map((x) => ({ ...x, ratio: total ? x.amount / total : 0 }));
  }

  return { CLASSES, COMMUNITY, ORDER, classify, share };
})();

if (typeof module !== 'undefined') module.exports = Fish;

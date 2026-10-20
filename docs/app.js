'use strict';

// EARN VIEWER：配布先（1人＝1アドレス）の全取引（区分つき）と、保有枚数・報酬を表示する
// ESV から分割をなくしたもの。EARN の枚数をそのまま預入枚数として使う
// 共通の処理は core.js、取引タブの部品は views.js

function renderTx() {
  renderTxTab({
    clsList: CLS_ORDER,
    amountOf: (x) => x.amount,
    mineName: (rankSelfName || '').trim() || '自分', // ランキングでの表示名（空欄なら「自分」）
    explorer: data.chain && data.chain.explorer,
  });
}
['clsSel', 'dirSel'].forEach((id) => $(id).addEventListener('change', renderTx));

function renderReward() {
  const split = data.transfers.find((x) => x.cls === 'split');
  // 名前はデータに入っていない（アドレスと名前を結び付けない）。表示は「自分」
  const me = split ? [{ id: 'me', name: '自分', share: Number(split.amount) }] : [];
  renderRewardTab(me, false);
  renderRankingTab(me);
}

// ランキングでの自分の表示名（端末の中だけ。空欄なら「自分」）
$('rankSelfName').addEventListener('change', async () => {
  rankSelfName = $('rankSelfName').value.trim();
  await putSetting('rankSelfName', rankSelfName);
  refreshAll();
});

ESV.start({
  async init() {
    rankSelfName = (await getSetting('rankSelfName')) || '';
    $('rankSelfName').value = rankSelfName;
  },
  render() { if (data) { renderTx(); renderReward(); } },
  describe() { return '　取引：' + data.transfers.length + ' 件'; },
});

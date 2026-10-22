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

// 仕分けを選ぶ画面（E-35）：選んだら保存して計算し直す。［元に戻す］はデータのままの区分に
$('clsDlg').addEventListener('close', () => {
  const dlg = $('clsDlg');
  const x = data && data.transfers.find((t) => txKey(t) === dlg.dataset.key);
  if (!x) return;
  if (dlg.returnValue === 'reset') setClsEdit(x, null);
  else if (dlg.returnValue === 'save') { const c = dlg.querySelector('input[name=clsPick]:checked'); if (c) setClsEdit(x, c.value); }
});
// 設定の「仕分けの変更」：まとめて元に戻す
$('clsResetAllBtn').addEventListener('click', () => {
  if (confirm('取引履歴で変えた仕分け（' + editCount() + ' 件）を、すべてデータのままの仕分けに戻しますか？')) clearClsEdits();
});
function renderClsEditCard() {
  const n = data ? editCount() : 0;
  $('clsEditCard').hidden = !n;
  $('clsEditCount').textContent = n + ' 件';
}

function renderReward() {
  const earns = earnList(); // 端末で変えた仕分けを当てたあとの EARN（複数なら合計。E-35）
  // 名前はデータに入っていない（アドレスと名前を結び付けない）。表示は「自分」
  const me = earns.length ? [{ id: 'me', name: '自分', share: earnTotal(earns) }] : [];
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
    clsEdits = (await getSetting('clsEdits')) || {};
    $('rankSelfName').value = rankSelfName;
  },
  render() { if (data) { renderTx(); renderReward(); } renderClsEditCard(); },
  describe() { return '　取引：' + data.transfers.length + ' 件'; },
});

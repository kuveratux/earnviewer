// アプリごとの設定（画面と Service Worker の両方で使う）
// 同じドメイン（kuveratux.github.io）で ESV（Manager・Agent）・取引ビューアと並ぶため、端末内の保存名をこのアプリだけのものにする
self.ESV_APP = {
  id: 'viewer',
  defaultName: 'EARN VIEWER',    // ホーム画面の名前
  title: 'EARN VIEWER',          // 画面上部の見出し
  db: 'ev-viewer',               // IndexedDB
  lsAppearance: 'evv-appearance', // localStorage（表示と配色の写し）
  cachePrefix: 'evv-shell-',     // Service Worker の保管庫（この接頭辞のものだけ削除する）
  filePrefix: 'ev_',             // 読み込めるデータファイルの名前の頭（ESV のファイル esv_… と見分ける）
};

'use strict';

// 表示（名前・配色）。画面が描かれる前に反映するため <head> で読み込む（app-config.js の後）
// 「表示と配色」の設定はなくした（2026-10 ユーザー指示）。名前・アイコンは標準、配色は端末の明暗に合わせる

const APPEARANCE_DEFAULT = { name: '', theme: 'auto' };
const APP_NAME_DEFAULT = self.ESV_APP.defaultName;
const THEME_COLOR = { light: '#050912', dark: '#050912' }; // 暗い配色に統一したので、どちらも同じ

function resolvedTheme() {
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyAppearance() {
  document.documentElement.removeAttribute('data-theme');
  document.title = APP_NAME_DEFAULT;
  const set = (sel, attr, v) => { const e = document.querySelector(sel); if (e) e.setAttribute(attr, v); };
  set('meta[name="apple-mobile-web-app-title"]', 'content', APP_NAME_DEFAULT);
  set('meta[name="theme-color"]', 'content', THEME_COLOR[resolvedTheme()]);
  // 画面上部の見出しは「EARN SPLIT VIEWER」（ホーム画面の名前は見分けられるよう ESV Manager／ESV Agent のまま）
  const h1 = document.querySelector('.bar h1');
  if (h1) h1.textContent = self.ESV_APP.title || APP_NAME_DEFAULT;
}

(function init() {
  // 以前の「表示と配色」で端末に残した写しは使わない（消す）
  try { localStorage.removeItem(self.ESV_APP.lsAppearance); } catch { /* 消せなくても表示には影響しない */ }
  applyAppearance();
  // 端末の明暗が変わったら、上部のバーの色も合わせる
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance());
})();

// ═══════════════════════════════════════════════════════════════
// SVG — Icons from Lucide (https://lucide.dev), MIT/ISC licensed.
// Copyright (c) 2024 Lucide Contributors.
// Uses lucide-static npm package for SVG sources.
// ═══════════════════════════════════════════════════════════════

// Vite raw imports of lucide-static SVGs
import homeRaw from 'lucide-static/icons/home.svg?raw';
import bookRaw from 'lucide-static/icons/book.svg?raw';
import targetRaw from 'lucide-static/icons/target.svg?raw';
import headphonesRaw from 'lucide-static/icons/headphones.svg?raw';
import pencilRaw from 'lucide-static/icons/pencil.svg?raw';
import settingsRaw from 'lucide-static/icons/settings.svg?raw';
import wrenchRaw from 'lucide-static/icons/wrench.svg?raw';
import chartNoAxesColumnRaw from 'lucide-static/icons/chart-no-axes-column.svg?raw';
import playRaw from 'lucide-static/icons/play.svg?raw';
import checkRaw from 'lucide-static/icons/check.svg?raw';
import xRaw from 'lucide-static/icons/x.svg?raw';
import plusRaw from 'lucide-static/icons/plus.svg?raw';
import minusRaw from 'lucide-static/icons/minus.svg?raw';
import trash2Raw from 'lucide-static/icons/trash-2.svg?raw';
import pencilLineRaw from 'lucide-static/icons/pencil-line.svg?raw';
import saveRaw from 'lucide-static/icons/save.svg?raw';
import downloadRaw from 'lucide-static/icons/download.svg?raw';
import uploadRaw from 'lucide-static/icons/upload.svg?raw';
import eyeRaw from 'lucide-static/icons/eye.svg?raw';
import eyeOffRaw from 'lucide-static/icons/eye-off.svg?raw';
import searchRaw from 'lucide-static/icons/search.svg?raw';
import chevronLeftRaw from 'lucide-static/icons/chevron-left.svg?raw';
import chevronRightRaw from 'lucide-static/icons/chevron-right.svg?raw';
import chevronDownRaw from 'lucide-static/icons/chevron-down.svg?raw';
import chevronUpRaw from 'lucide-static/icons/chevron-up.svg?raw';
import menuRaw from 'lucide-static/icons/menu.svg?raw';
import listRaw from 'lucide-static/icons/list.svg?raw';
import arrowUpRaw from 'lucide-static/icons/arrow-up.svg?raw';
import arrowRightRaw from 'lucide-static/icons/arrow-right.svg?raw';
import volume2Raw from 'lucide-static/icons/volume-2.svg?raw';
import starRaw from 'lucide-static/icons/star.svg?raw';
import zapRaw from 'lucide-static/icons/zap.svg?raw';
import clockRaw from 'lucide-static/icons/clock.svg?raw';
import calendarRaw from 'lucide-static/icons/calendar.svg?raw';
import flameRaw from 'lucide-static/icons/flame.svg?raw';
import flagRaw from 'lucide-static/icons/flag.svg?raw';
import folderOpenRaw from 'lucide-static/icons/folder-open.svg?raw';
import refreshCwRaw from 'lucide-static/icons/refresh-cw.svg?raw';
import ellipsisRaw from 'lucide-static/icons/ellipsis.svg?raw';
import shuffleRaw from 'lucide-static/icons/shuffle.svg?raw';
import cloudRaw from 'lucide-static/icons/cloud.svg?raw';
import databaseRaw from 'lucide-static/icons/database.svg?raw';
import brainRaw from 'lucide-static/icons/brain.svg?raw';
import trophyRaw from 'lucide-static/icons/trophy.svg?raw';
import mousePointer2Raw from 'lucide-static/icons/mouse-pointer-2.svg?raw';
import giftRaw from 'lucide-static/icons/gift.svg?raw';
import imageRaw from 'lucide-static/icons/image.svg?raw';
import layersRaw from 'lucide-static/icons/layers.svg?raw';
import bookmarkRaw from 'lucide-static/icons/bookmark.svg?raw';
import infoRaw from 'lucide-static/icons/info.svg?raw';
import trendingUpRaw from 'lucide-static/icons/trending-up.svg?raw';
import trendingDownRaw from 'lucide-static/icons/trending-down.svg?raw';
import slidersHorizontalRaw from 'lucide-static/icons/sliders-horizontal.svg?raw';
import wandRaw from 'lucide-static/icons/wand.svg?raw';
import arrowLeftRaw from 'lucide-static/icons/arrow-left.svg?raw';
import boxRaw from 'lucide-static/icons/box.svg?raw';
import hashRaw from 'lucide-static/icons/hash.svg?raw';
import filterRaw from 'lucide-static/icons/filter.svg?raw';
import columns2Raw from 'lucide-static/icons/columns-2.svg?raw';
import micRaw from 'lucide-static/icons/mic.svg?raw';
import rotateCwRaw from 'lucide-static/icons/rotate-cw.svg?raw';
import pipetteRaw from 'lucide-static/icons/pipette.svg?raw';
import sparklesRaw from 'lucide-static/icons/sparkles.svg?raw';
import paletteRaw from 'lucide-static/icons/palette.svg?raw';
import sunRaw from 'lucide-static/icons/sun.svg?raw';
import moonRaw from 'lucide-static/icons/moon.svg?raw';
import externalLinkRaw from 'lucide-static/icons/external-link.svg?raw';
import libraryBigRaw from 'lucide-static/icons/library-big.svg?raw';
import squareLibraryRaw from 'lucide-static/icons/square-library.svg?raw';
import formRaw from 'lucide-static/icons/form.svg?raw';
import bookOpenRaw from 'lucide-static/icons/book-open.svg?raw';
import scrollTextRaw from 'lucide-static/icons/scroll-text.svg?raw';
import galleryHorizontalEndRaw from 'lucide-static/icons/gallery-horizontal-end.svg?raw';
import cameraRaw from 'lucide-static/icons/camera.svg?raw';
import scanRaw from 'lucide-static/icons/scan.svg?raw';

/** Extract inner SVG content (strip outer <svg> tag and comments) */
function inner(raw) {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg[^>]*>/g, '')
    .replace(/<\/svg>/g, '')
    .trim();
}

const S = (raw) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner(raw)}</svg>`;

export const icons = {
  // Navigation
  home:      () => S(homeRaw),
  book:      () => S(bookRaw),
  target:    () => S(targetRaw),
  headphone: () => S(headphonesRaw),
  pencil:    () => S(pencilRaw),
  settings:  () => S(settingsRaw),
  tools:     () => S(wrenchRaw),
  chart:     () => S(chartNoAxesColumnRaw),

  // Actions
  play:      () => S(playRaw),
  check:     () => S(checkRaw),
  x:         () => S(xRaw),
  plus:      () => S(plusRaw),
  minus:     () => S(minusRaw),
  trash:     () => S(trash2Raw),
  edit:      () => S(pencilLineRaw),
  save:      () => S(saveRaw),
  download:  () => S(downloadRaw),
  upload:    () => S(uploadRaw),
  eye:       () => S(eyeRaw),
  eyeOff:    () => S(eyeOffRaw),
  search:    () => S(searchRaw),
  chevronL:  () => S(chevronLeftRaw),
  chevronR:  () => S(chevronRightRaw),
  chevronD:  () => S(chevronDownRaw),
  chevronU:  () => S(chevronUpRaw),
  menu:      () => S(menuRaw),
  list:      () => S(squareLibraryRaw),   // 使用者指定：list 全面換成 square-library 圖示
  form:      () => S(formRaw),             // 多選模式專用（form 圖示）
  arrowUp:   () => S(arrowUpRaw),
  arrowR:    () => S(arrowRightRaw),
  volume:    () => S(volume2Raw),
  star:      () => S(starRaw),
  zap:       () => S(zapRaw),
  clock:     () => S(clockRaw),
  calendar:  () => S(calendarRaw),
  flame:     () => S(flameRaw),
  flag:      () => S(flagRaw),
  folder:    () => S(folderOpenRaw),
  refresh:   () => S(refreshCwRaw),
  moreH:     () => S(ellipsisRaw),
  shuffle:   () => S(shuffleRaw),
  cloud:     () => S(cloudRaw),
  database:  () => S(databaseRaw),
  brain:     () => S(brainRaw),
  cup:       () => S(trophyRaw),
  cursor:    () => S(mousePointer2Raw),
  gift:      () => S(giftRaw),
  image:     () => S(imageRaw),
  camera:    () => S(cameraRaw),
  scan:      () => S(scanRaw),
  layers:    () => S(layersRaw),
  bookmark:  () => S(bookmarkRaw),
  info:      () => S(infoRaw),
  trendingUp:   () => S(trendingUpRaw),
  trendingDown: () => S(trendingDownRaw),
  sliders:   () => S(slidersHorizontalRaw),
  wand:      () => S(wandRaw),
  arrowLeft: () => S(arrowLeftRaw),
  box:       () => S(boxRaw),
  hash:      () => S(hashRaw),
  filter:    () => S(filterRaw),
  columns:   () => S(columns2Raw),
  mic:       () => S(micRaw),
  rotateCw:  () => S(rotateCwRaw),
  pipette:   () => S(pipetteRaw),
  sparkle:   () => S(sparklesRaw),
  palette:   () => S(paletteRaw),
  sun:       () => S(sunRaw),
  moon:      () => S(moonRaw),
  externalLink: () => S(externalLinkRaw),
  library:   () => S(libraryBigRaw),
  bookOpen:  () => S(bookOpenRaw),
  scrollText: () => S(scrollTextRaw),
  galleryHorizontalEnd: () => S(galleryHorizontalEndRaw),
};

/**
 * Render an SVG icon inline.
 * @param {string} name - Icon name from the `icons` object
 * @returns {string} HTML string
 */
export function icon(name) {
  const fn = icons[name];
  if (!fn) return '';
  return `<span class="ic">${fn()}</span>`;
}

/**
 * Render pos/definition as capsule badges.
 */
export function splitFieldsHtml(pos, def) {
  const posParts = (pos || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const defParts = (def || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (!posParts.length && !defParts.length) return '';
  let html = '<div class="split-wrap">';
  if (posParts.length) {
    html += '<div class="split-row">';
    for (const p of posParts) html += `<span class="split-badge split-badge-pos">${esc(p)}</span>`;
    html += '</div>';
  }
  if (defParts.length) {
    html += '<div class="split-row">';
    for (const d of defParts) html += `<span class="split-badge split-badge-def">${esc(d)}</span>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/**
 * Format example text: if it contains English + Chinese translation
 * separated by punctuation boundary, split onto separate lines.
 */
export function fmtExample(ex) {
  if (!ex) return '';
  const row = (html) => `<div style="display:flex;gap:.4em"><span>•</span><span>${html}</span></div>`;
  let lines = ex.split('\n').filter(Boolean);
  const max = window.__maxExampleLines || 0;
  if (max > 0 && lines.length > max) {
    lines = lines.sort(() => Math.random() - 0.5).slice(0, max);
  }
  return lines.map(l => {
    const m = l.match(/^(.+[.!?])\s*[,，]\s*([\u4e00-\u9fff].+)$/);
    if (m) {
      return `${row(esc(m[1]))}<div style="margin-top:4px;color:var(--text-tertiary);font-size:13px">${row(esc(m[2]))}</div>`;
    }
    return row(esc(l));
  }).join('');
}

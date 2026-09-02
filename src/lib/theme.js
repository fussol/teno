// ═══════════════════════════════════════════════════════════════
// Theme — Light/dark mode + HSL full-palette generator.
// Picking an accent color generates ALL CSS vars coherently.
// ═══════════════════════════════════════════════════════════════

export const ACCENTS = {
  // ── 繽紛 ──
  lemonChiffon:  '#FFFACD',
  skyBlue:       '#87CEEB',
  peach:         '#FFDAB9',
  mintGreen:     '#98FF98',
  lavender:      '#E6E6FA',
  coralPink:     '#F08080',
  springGreen:   '#00FF7F',
  sunshineYellow:'#FFD700',
  babyBlue:      '#89CFF0',
  apricot:       '#FBCEB1',
  turquoise:     '#40E0D0',
  candyPink:     '#FF91AF',
  limePunch:     '#D0F0C0',
  periwinkle:    '#CCCCFF',
  creamyOrange:  '#FFCC99',
  aquamarine:    '#7FFFD4',
  orchid:        '#DA70D6',
  buttercup:     '#F3E5AB',
  seafoam:       '#93E9BE',
  skyMagenta:    '#CF71AF',
  // ── 自然 ──
  sage:          '#8A9A5B',
  sand:          '#C2B280',
  mist:          '#BCC6CC',
  clay:          '#B47E70',
  slate:         '#708090',
  peachFuzz:     '#FFBE98',
  olive:         '#808000',
  cloud:         '#F5F5F5',
  dustyRose:     '#DCAE96',
  midnight:      '#191970',
  forestMoss:    '#6B705C',
  parchment:     '#F4EBD9',
  stormySky:     '#778DA9',
  terracotta:    '#A47148',
  lavenderMist:  '#B7B7A4',
  oceanTeal:     '#4A7C59',
  warmTaupe:     '#9C8975',
  eveningGlow:   '#C9ADA7',
  steelBlue:     '#4682B4',
  winterPine:    '#2F3E46',
};

export const ACCENT_GROUPS = [
  {
    label: '繽紛',
    items: [
      { id: 'lemonChiffon', cht: '檸檬雪紡' },
      { id: 'skyBlue', cht: '天空藍' },
      { id: 'peach', cht: '水蜜桃色' },
      { id: 'mintGreen', cht: '薄荷綠' },
      { id: 'lavender', cht: '薰衣草紫' },
      { id: 'coralPink', cht: '珊瑚粉' },
      { id: 'springGreen', cht: '春芽綠' },
      { id: 'sunshineYellow', cht: '陽光黃' },
      { id: 'babyBlue', cht: '嬰兒藍' },
      { id: 'apricot', cht: '杏桃色' },
      { id: 'turquoise', cht: '綠松石色' },
      { id: 'candyPink', cht: '糖果粉' },
      { id: 'limePunch', cht: '青檸擊' },
      { id: 'periwinkle', cht: '長春花藍' },
      { id: 'creamyOrange', cht: '奶油橘' },
      { id: 'aquamarine', cht: '海藍寶石' },
      { id: 'orchid', cht: '蘭花紫' },
      { id: 'buttercup', cht: '毛茛黃' },
      { id: 'seafoam', cht: '海泡綠' },
      { id: 'skyMagenta', cht: '天空洋紅' },
    ],
  },
  {
    label: '自然',
    items: [
      { id: 'sage', cht: '鼠尾草綠' },
      { id: 'sand', cht: '暖沙色' },
      { id: 'mist', cht: '薄霧灰' },
      { id: 'clay', cht: '陶土色' },
      { id: 'slate', cht: '石板藍' },
      { id: 'peachFuzz', cht: '蜜桃絨' },
      { id: 'olive', cht: '橄欖綠' },
      { id: 'cloud', cht: '雲朵白' },
      { id: 'dustyRose', cht: '乾燥玫瑰' },
      { id: 'midnight', cht: '深海藍' },
      { id: 'forestMoss', cht: '苔蘚綠' },
      { id: 'parchment', cht: '古紙色' },
      { id: 'stormySky', cht: '暴雨灰' },
      { id: 'terracotta', cht: '紅磚色' },
      { id: 'lavenderMist', cht: '霧紫' },
      { id: 'oceanTeal', cht: '海藻青' },
      { id: 'warmTaupe', cht: '暖褐' },
      { id: 'eveningGlow', cht: '暮光' },
      { id: 'steelBlue', cht: '鋼鐵藍' },
      { id: 'winterPine', cht: '冬松' },
    ],
  },
];

let _styleEl = null;

function hexToHSL(hex) {
  let r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h * 360, s * 100, l * 100];
}

function hslStr(h, s, l) { return `hsl(${h},${s}%,${l}%)`; }
function rgbaStr(h, s, l, a) { return `hsla(${h},${s}%,${l}%,${a})`; }

/* ── WCAG contrast helpers (G1) ─────────────────────────────── */
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r,g,b] = [c,x,0]; else if (h < 120) [r,g,b] = [x,c,0];
  else if (h < 180) [r,g,b] = [0,c,x]; else if (h < 240) [r,g,b] = [0,x,c];
  else if (h < 300) [r,g,b] = [x,0,c]; else [r,g,b] = [c,0,x];
  return [r + m, g + m, b + m];
}
function relLum(rgb) { // rgb 0-1
  const lin = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}
function contrast(a, b) {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** G1: 依序取 #160e2b → #fff → #000 第一個對渲染後 accent ≥4.5:1 的（8-bit 量化） */
function pickAccentOn(h, aSat, aL) {
  const accentRgb = hslToRgb(h, aSat, aL).map(v => Math.round(v * 255) / 255);
  const candidates = [[0x16, 0x0e, 0x2b], [0xff, 0xff, 0xff], [0, 0, 0]];
  const pick = candidates.find(c => contrast(accentRgb, c.map(v => v / 255)) >= 4.5) || [0, 0, 0];
  return `rgb(${pick.join(',')})`;
}

/** Generate ALL background/text/border vars in harmony with accent hue. */
function generatePalette(h, sat, light, isDark) {
  if (isDark) {
    return {
      '--bg-base':        hslStr(h, 14,  6),
      '--bg-surface':     hslStr(h, 16, 10),
      '--bg-surface-2':   hslStr(h, 14, 12),
      '--bg-elevated':    hslStr(h, 22, 15),
      '--bg-hover':       hslStr(h, 26, 19),
      '--bg-active':      hslStr(h, 30, 24),
      '--text-primary':   hslStr(h, 12, 94),
      '--text-secondary': hslStr(h, 9,  70),
      '--text-tertiary':  hslStr(h, 6,  50),
      '--text-disabled':  hslStr(h, 4,  30),
      '--border-subtle':  rgbaStr(h, 12, 94, 0.06),
      '--border':         rgbaStr(h, 12, 94, 0.12),
      '--border-strong':  rgbaStr(h, 12, 94, 0.20),
      '--state-hover':    rgbaStr(h, 12, 94, 0.06),
      '--state-pressed':  rgbaStr(h, 12, 94, 0.10),
    };
  }

  return {
    '--bg-base':        hslStr(h, 22, 92),
    '--bg-surface':     hslStr(h, 14, 96),
    '--bg-surface-2':   hslStr(h, 18, 94),
    '--bg-elevated':    hslStr(h, 26, 88),
    '--bg-hover':       hslStr(h, 28, 84),
    '--bg-active':      hslStr(h, 30, 80),
    '--text-primary':   hslStr(h, 14, 12),
    '--text-secondary': hslStr(h, 10, 38),
    '--text-tertiary':  hslStr(h, 7,  56),
    '--text-disabled':  hslStr(h, 5,  72),
    '--border-subtle':  rgbaStr(h, 14, 12, 0.05),
    '--border':         rgbaStr(h, 14, 12, 0.10),
    '--border-strong':  rgbaStr(h, 14, 12, 0.18),
    '--state-hover':    rgbaStr(h, 14, 12, 0.04),
    '--state-pressed':  rgbaStr(h, 14, 12, 0.08),
  };
}

/** Generate accent + semantic colors from the accent hue. */
function generateAccentVars(h, sat, light, isDark, intensity = 0.5) {
  const mul = Math.max(0.1, Math.min(2, intensity / 0.5));
  const aSat = Math.min(sat * 1.2, 100);
  let aL = isDark
    ? Math.min(Math.max(light + 12, 55), 78)
    : Math.min(Math.max(light - 12, 36), 55); // G1: 38→36 (可選項, sage 白字恢復)
  // Scale accent lightness by intensity so change is immediately visible
  const mid = 0.5;
  if (isDark) {
    aL = aL + (intensity - mid) * 40;
  } else {
    aL = aL - (intensity - mid) * 40;
  }
  aL = Math.max(25, Math.min(92, aL));
  const cSat = Math.min(sat * 0.8, 60);
  return {
    '--accent':          hslStr(h, aSat, aL),
    '--accent-dim':      hslStr(h, aSat, aL - 12),
    '--accent-deep':     hslStr(h, aSat, aL - 24),
      '--accent-bg':       hslStr(h, aSat * 0.3, isDark ? 14 : 92),
      '--accent-glow':     rgbaStr(h, aSat, aL, 0.18 * mul),
    '--accent-container':rgbaStr(h, aSat, aL, 0.14 * mul),
    '--accent-on': pickAccentOn(h, aSat, aL),
    '--state-focus':     rgbaStr(h, aSat, aL, 0.14 * mul),
    '--shadow-glow':     `0 0 28px ${rgbaStr(h, aSat, aL, 0.12 * mul)}`,
    '--accent-secondary':          hslStr((h + 45) % 360, aSat, aL),
    '--accent-secondary-dim':      hslStr((h + 45) % 360, aSat, aL - 12),
    '--accent-secondary-container':rgbaStr((h + 45) % 360, aSat, aL, 0.14 * mul),
    '--accent-secondary-glow':     rgbaStr((h + 45) % 360, aSat, aL, 0.18 * mul),
    '--accent-tertiary':           hslStr((h - 35 + 360) % 360, aSat, aL),
    '--accent-tertiary-dim':       hslStr((h - 35 + 360) % 360, aSat, aL - 12),
    '--accent-tertiary-container': rgbaStr((h - 35 + 360) % 360, aSat, aL, 0.14 * mul),
    '--accent-tertiary-glow':      rgbaStr((h - 35 + 360) % 360, aSat, aL, 0.18 * mul),
    '--green':    hslStr(h + 120, cSat, 60),
    '--amber':    hslStr(h + 40,  cSat, 65),
    '--red':      hslStr(h - 30,  cSat, 65),
    '--rose':     hslStr(h - 15,  cSat, 68),
    '--cyan':     hslStr(h + 160, cSat, 58),
    '--orange':   hslStr(h + 25,  cSat, 62),
  };
}

export function applyTheme(mode, accentName, intensity = 0.5) {
  const hex = ACCENTS[accentName] || ACCENTS.skyBlue;
  const isDark = mode === 'dark';
  const [h, sat, light] = hexToHSL(hex);
  const base = generatePalette(h, sat, light, isDark);
  const acc = generateAccentVars(h, sat, light, isDark, intensity);
  const css = ':root{\n  --color-scheme:' + (isDark ? 'dark' : 'light') + ';\n' + Object.entries({...base, ...acc}).map(([k,v]) => `  ${k}:${v};`).join('\n') + '\n}';
  if (!_styleEl) { _styleEl = document.createElement('style'); _styleEl.id = 'theme-injected'; document.head.appendChild(_styleEl); }
  _styleEl.textContent = css;
  // F7：applyTheme 已跑的單調標記——splash 遲到回調讓位，防 icon 底污染 meta theme-color 整個 session
  document.documentElement.dataset.themeInjected = '1';
  // Vercel guidelines: theme-color meta 對齊頁面背景
  const bgHex = base['--bg-base'];
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.content = bgHex;
}

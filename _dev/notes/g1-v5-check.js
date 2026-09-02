// G1 v5 independent verification — 1680 cases, 8-bit quantization, candidate chain
const ACCENTS = {
  lemonChiffon:'#FFFACD',skyBlue:'#87CEEB',peach:'#FFDAB9',mintGreen:'#98FF98',lavender:'#E6E6FA',
  coralPink:'#F08080',springGreen:'#00FF7F',sunshineYellow:'#FFD700',babyBlue:'#89CFF0',apricot:'#FBCEB1',
  turquoise:'#40E0D0',candyPink:'#FF91AF',limePunch:'#D0F0C0',periwinkle:'#CCCCFF',creamyOrange:'#FFCC99',
  aquamarine:'#7FFFD4',orchid:'#DA70D6',buttercup:'#F3E5AB',seafoam:'#93E9BE',skyMagenta:'#CF71AF',
  sage:'#8A9A5B',sand:'#C2B280',mist:'#BCC6CC',clay:'#B47E70',slate:'#708090',peachFuzz:'#FFBE98',
  olive:'#808000',cloud:'#F5F5F5',dustyRose:'#DCAE96',midnight:'#191970',forestMoss:'#6B705C',
  parchment:'#F4EBD9',stormySky:'#778DA9',terracotta:'#A47148',lavenderMist:'#B7B7A4',oceanTeal:'#4A7C59',
  warmTaupe:'#9C8975',eveningGlow:'#C9ADA7',steelBlue:'#4682B4',winterPine:'#2F3E46',
};

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

// v5 helpers (plan §1)
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
function relLum(rgb) {
  const lin = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}
function contrast(a, b) {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// replicate generateAccentVars aL computation
function accentAL(h, sat, light, isDark, intensity) {
  let aL = isDark ? Math.min(Math.max(light + 12, 55), 78) : Math.min(Math.max(light - 12, 38), 55);
  const mid = 0.5;
  if (isDark) aL = aL + (intensity - mid) * 40; else aL = aL - (intensity - mid) * 40;
  return Math.max(25, Math.min(92, aL));
}

const candidates = [[0x16,0x0e,0x2b],[0xff,0xff,0xff],[0,0,0]];
function pick(accentRgb) {
  const c = candidates.find(cd => contrast(accentRgb, cd.map(v=>v/255)) >= 4.5) || [0,0,0];
  return c;
}

let fails = [], minC = Infinity, minCase = null, worst = null;
let total = 0;
for (const [name, hex] of Object.entries(ACCENTS)) {
  const [h, sat, light] = hexToHSL(hex);
  for (const isDark of [true, false]) {
    for (let i = 0; i <= 20; i++) {
      const intensity = i / 20;
      const aL = accentAL(h, sat, light, isDark, intensity);
      const aSat = Math.min(sat * 1.2, 100);
      const accentRgb = hslToRgb(h, aSat, aL).map(v => Math.round(v * 255) / 255);
      const c = pick(accentRgb);
      const cr = contrast(accentRgb, c.map(v=>v/255));
      total++;
      if (cr < minC) { minC = cr; minCase = {name,isDark,intensity,aL,aSat,accentRgb,c,cr}; }
      if (cr < 4.5) fails.push({name,isDark,intensity,cr});
    }
  }
}
console.log('TOTAL cases:', total);
console.log('FAIL <4.5:', fails.length);
if (fails.length) console.log('first fails:', fails.slice(0,10));
console.log('WORST margin:', minC, JSON.stringify(minCase));

// -- grayscale (aSat=0) full hue sweep
let gmin = Infinity, gminH = null;
for (let h = 0; h < 360; h++) {
  for (const isDark of [true,false]) {
    for (let i = 0; i <= 20; i++) {
      const intensity = i/20;
      const aL = accentAL(h, 0, 95, isDark, intensity); // cloud-like light
      const accentRgb = hslToRgb(h, 0, aL).map(v => Math.round(v*255)/255);
      const c = pick(accentRgb);
      const cr = contrast(accentRgb, c.map(v=>v/255));
      if (cr < gmin) { gmin = cr; gminH = h; }
    }
  }
}
console.log('GRAYSWEEP min:', gmin, 'h=', gminH);

// -- full hue sweep (claim: worst 4.500 @ h=108 s=100 aL=27)
let smin = Infinity, sminCase = null;
for (let h = 0; h < 360; h++) {
  for (const s of [50, 100]) {
    for (let aL = 25; aL <= 92; aL++) {
      const accentRgb = hslToRgb(h, s, aL).map(v => Math.round(v*255)/255);
      const c = pick(accentRgb);
      const cr = contrast(accentRgb, c.map(v=>v/255));
      if (cr < smin) { smin = cr; sminCase = {h,s,aL,c,cr}; }
    }
  }
}
console.log('HUESWEEP min:', smin, JSON.stringify(sminCase));

// -- 8-bit vs float check on the claimed babyBlue light@0.95 edge
{
  const [h, sat, light] = hexToHSL('#89CFF0');
  const aL = accentAL(h, sat, light, false, 0.95);
  const aSat = Math.min(sat*1.2, 100);
  const floatRgb = hslToRgb(h, aSat, aL);
  const qRgb = floatRgb.map(v => Math.round(v*255)/255);
  const c = pick(qRgb);
  console.log('babyBlue light 0.95: aL=', aL, 'floatContrast=', contrast(floatRgb, [0,0,0]).toFixed(4),
    '8bitContrast=', contrast(qRgb, c.map(v=>v/255)).toFixed(4), 'pick=', c);
}

// -- :active sRGB composite model (v5: no opacity on accent consumers; verify model as plan states)
// composite: text over accent over page-bg at alpha a; sRGB space: C = a*T + (1-a)*(a*Bg + (1-a)*Pg)? 
// Standard: layered alpha compositing in sRGB (non-linear) per plan's "sRGB 合成模型"
function srgbComposite(top, bottom, a) { return top.map((t,i)=>a*t + (1-a)*bottom[i]); }
// worst historical case: candyPink light@0.65 opacity .85 — recompute what v4 would have been vs v5 (no opacity)
{
  const [h, sat, light] = hexToHSL('#FF91AF');
  const aL = accentAL(h, sat, light, false, 0.65);
  const aSat = Math.min(sat*1.2,100);
  const q = hslToRgb(h, aSat, aL).map(v=>Math.round(v*255)/255);
  const bg = hslToRgb(h, 22, 92).map(v=>Math.round(v*255)/255);
  const txt = pick(q).map(v=>v/255);
  const comp = srgbComposite(q, bg, 0.85);
  console.log('candyPink light 0.65: static pick contrast=', contrast(q, txt).toFixed(3),
    'opacity.85 composite (txt vs comp bg)=', contrast(comp, txt).toFixed(3));
}

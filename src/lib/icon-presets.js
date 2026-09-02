// ═══════════════════════════════════════════════════════════════
// Icon presets — shared by settings.js (picker) and main.js (splash).
// Keys map to Android activity-aliases (ic_launcher_2..20) — see
// settings.js icon switching and IconPlugin.kt.
// ═══════════════════════════════════════════════════════════════

export const ICON_PRESETS = [
  { key: 'original', label: '杏桃',  bg: '#F4C182', main: '#E13D3D' },
  { key: 'ocean',    label: '深海藍', bg: '#1E3A5F', main: '#4FC3F7' },
  { key: 'forest',   label: '森林綠', bg: '#2E5D3A', main: '#81C784' },
  { key: 'sunset',   label: '日落橘', bg: '#FF9A62', main: '#FF5252' },
  { key: 'midnight', label: '午夜紫', bg: '#121826', main: '#7C4DFF' },
  { key: 'lemon',    label: '檸檬黃', bg: '#FFF3B0', main: '#F9A825' },
  { key: 'mint',     label: '薄荷',  bg: '#A8E6CF', main: '#1B9C85' },
  { key: 'rose',     label: '玫瑰粉', bg: '#FFD6E0', main: '#D6336C' },
  { key: 'graphite', label: '石墨',  bg: '#2B2B2B', main: '#E0E0E0' },
  { key: 'cream',    label: '奶油',  bg: '#FAF0E6', main: '#C0392B' },
  // Color Hunt 前 10 名（2026 人氣排行）
  { key: 'ch1',  label: 'CH藍',     bg: '#E3F2FD', main: '#0D47A1' },
  { key: 'ch2',  label: 'CH粉彩',   bg: '#EEF8CD', main: '#FF9D9D' },
  { key: 'ch3',  label: 'CH薄荷藍', bg: '#D9FFF4', main: '#321E48' },
  { key: 'ch4',  label: 'CH粉紫',   bg: '#F8B2B2', main: '#403D88' },
  { key: 'ch5',  label: 'CH海軍鮭', bg: '#0F3040', main: '#D99B7F' },
  { key: 'ch6',  label: 'CH翠綠',   bg: '#E8F5E9', main: '#1B5E20' },
  { key: 'ch7',  label: 'CH卡其',   bg: '#F7F4ED', main: '#8FA28A' },
  { key: 'ch8',  label: 'CH橘紅',   bg: '#FFDD9C', main: '#E73F1E' },
  { key: 'ch9',  label: 'CH黃綠',   bg: '#E1E100', main: '#063B00' },
  { key: 'ch10', label: 'CH玫瑰棕', bg: '#F6D8BD', main: '#5D3140' },
];

/** Android res 檔名（mipmap-xxxhdpi / anydpi-v26）。original 無編號。 */
export function iconResName(key) {
  const i = ICON_PRESETS.findIndex(p => p.key === key);
  if (i <= 0) return 'ic_launcher';            // original
  return `ic_launcher_${i + 1}`;               // ocean=_2 … ch10=_20
}

/** 前端 splash 用圖片路徑（public/icons/）。 */
export function iconImgPath(key) {
  const k = ICON_PRESETS.some(p => p.key === key) ? key : 'original';
  return `/icons/icon-${k}.png`;
}

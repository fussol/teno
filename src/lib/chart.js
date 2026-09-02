// ═══════════════════════════════════════════════════════════════
// Charts — Pure-SVG data-visualization helpers for BETA-B.
//   - barChart: discrete bars (e.g. daily review counts)
//   - lineChart: trend line with optional area fill (e.g. retention %)
// No external chart library; returns an <svg> string.
// ═══════════════════════════════════════════════════════════════

/**
 * Render a bar chart SVG.
 * @param {{label:string,value:number}[]} data
 * @param {{width?:number,height?:number,max?:number,color?:string,barColorDim?:string}} [opts]
 */
export function barChart(data, opts = {}) {
  const width = opts.width || 460;
  const height = opts.height || 120;
  const pad = { l: 4, r: 4, t: 12, b: 22 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const values = data.map(d => d.value);
  const max = opts.max != null ? opts.max : Math.max(1, ...values);
  const n = data.length;
  const bw = n > 0 ? innerW / n : innerW;
  const color = opts.color || 'var(--accent)';
  const axisColor = 'rgba(128,120,153,0.35)';

  const bars = data.map((d, i) => {
    const v = Math.max(0, d.value);
    const h = max > 0 ? Math.max(v / max, 0.02) * innerH : 0;
    const x = pad.l + i * bw + bw * 0.15;
    const y = pad.t + (innerH - h);
    const w = bw * 0.7;
    return { x, y, w, h, d, v };
  });

  const barSvg = bars.map(b => `
    <rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="2" fill="${color}" opacity="${b.v > 0 ? 0.9 : 0.25}"/>
  `).join('');

  // 依畫面寬度決定 label 間隔（尺式）：每個 label 最少要 minGap 水平間距才不會疊
  const minGap = 38;
  const maxLabels = Math.max(1, Math.floor(innerW / minGap));
  const labelStep = Math.max(1, Math.ceil(n / maxLabels));
  const labels = data.map((d, i) => {
    if (i % labelStep !== 0) return '';
    const cx = pad.l + i * bw + bw / 2;
    return `<text x="${cx.toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="rgba(128,120,153,0.9)">${escapeXml(d.label || '')}</text>`;
  }).join('');

  const maxLabel = `<text x="${pad.l + innerW}" y="${pad.t - 3}" text-anchor="end" font-size="9" fill="rgba(128,120,153,0.7)">${max}</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-height:${height}px;display:block">
    <line x1="${pad.l}" y1="${pad.t + innerH}" x2="${pad.l + innerW}" y2="${pad.t + innerH}" stroke="${axisColor}" stroke-width="1"/>
    ${barSvg}
    ${labels}
    ${maxLabel}
  </svg>`;
}

/**
 * Render a line chart SVG with optional area fill.
 * Null values are treated as gaps: the line breaks there (no dot, no segment).
 * @param {{label:string,value:(number|null)}[]} data
 * @param {{width?:number,height?:number,min?:number,max?:number,color?:string,fmt?:function}} [opts]
 */
export function lineChart(data, opts = {}) {
  const width = opts.width || 460;
  const height = opts.height || 120;
  const pad = { l: 4, r: 4, t: 12, b: 22 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const values = data.map(d => (typeof d.value === 'number' ? d.value : NaN));
  const min = opts.min != null ? opts.min : 0;
  const max = opts.max != null ? opts.max : Math.max(1, ...values.filter(Number.isFinite));
  const span = Math.max(1e-9, max - min);
  const n = data.length;
  const color = opts.color || '#5ed98f';
  const axisColor = 'rgba(128,120,153,0.35)';

  const pts = data.map((d, i) => {
    const x = pad.l + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
    const v = typeof d.value === 'number' ? d.value : NaN;
    const y = Number.isFinite(v) ? pad.t + innerH - ((v - min) / span) * innerH : NaN;
    return { x, y, d, v };
  });

  // Split into contiguous runs of finite points so gaps stay gaps.
  const segments = [];
  let cur = [];
  for (const p of pts) {
    if (Number.isFinite(p.y)) cur.push(p);
    else if (cur.length) { segments.push(cur); cur = []; }
  }
  if (cur.length) segments.push(cur);

  const pathD = segments.map(seg =>
    seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  ).join(' ');
  const areaD = segments.map(seg =>
    `${seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L ${seg[seg.length - 1].x.toFixed(1)} ${pad.t + innerH} L ${seg[0].x.toFixed(1)} ${pad.t + innerH} Z`
  ).join(' ');
  const dots = pts.filter(p => Number.isFinite(p.y)).map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}"/>`).join('');
  const labels = pts.filter((_, i) => i % Math.max(1, Math.ceil(n / 8)) === 0).map(p => {
    return `<text x="${p.x.toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="rgba(128,120,153,0.9)">${escapeXml(p.d.label || '')}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-height:${height}px;display:block">
    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + innerH}" stroke="${axisColor}" stroke-width="1"/>
    <line x1="${pad.l}" y1="${pad.t + innerH}" x2="${pad.l + innerW}" y2="${pad.t + innerH}" stroke="${axisColor}" stroke-width="1"/>
    ${areaD ? `<path d="${areaD}" fill="${color}" opacity="0.12"/>` : ''}
    ${pathD ? `<path d="${pathD}" stroke="${color}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
    ${dots}
    ${labels}
  </svg>`;
}

/**
 * Render a pie chart SVG.
 * @param {{label:string,value:number,color:string}[]} data
 * @param {{width?:number,height?:number}} [opts]
 */
export function pieChart(data, opts = {}) {
  const width = opts.width || 200;
  const height = opts.height || 200;
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(cx, cy) - 20;
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-height:${height}px"><text x="${cx}" y="${cy}" text-anchor="middle" fill="rgba(128,120,153,0.5)" font-size="12">No data</text></svg>`;

  let angle = -Math.PI / 2;
  const slices = data.filter(d => d.value > 0).map(d => {
    const sliceAngle = (d.value / total) * 2 * Math.PI;
    const startAngle = angle;
    const endAngle = angle + sliceAngle;
    angle = endAngle;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = sliceAngle > Math.PI ? 1 : 0;
    const midAngle = startAngle + sliceAngle / 2;
    const labelR = r + 14;
    const lx = cx + labelR * Math.cos(midAngle);
    const ly = cy + labelR * Math.sin(midAngle);
    const pct = Math.round((d.value / total) * 100);
    return { x1, y1, x2, y2, largeArc, color: d.color, label: d.label, pct, lx, ly, value: d.value };
  });

  const sliceSvg = slices.map(s => {
    if (slices.length === 1) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.color}" opacity="0.85"/>`;
    }
    return `<path d="M${cx},${cy} L${s.x1.toFixed(1)},${s.y1.toFixed(1)} A${r},${r} 0 ${s.largeArc},1 ${s.x2.toFixed(1)},${s.y2.toFixed(1)} Z" fill="${s.color}" opacity="0.85"/>`;
  }).join('');

  const labelSvg = slices.filter(s => s.pct >= 5).map(s =>
    `<text x="${s.lx.toFixed(1)}" y="${s.ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="9" fill="rgba(200,195,220,0.8)">${s.pct}%</text>`
  ).join('');

  const legendItems = data.filter(d => d.value > 0);
  const maxLegend = 6;
  const legend = opts.noLegend ? '' : legendItems.slice(0, maxLegend).map((d, i) => {
    const y = height - 10;
    const x = 8 + i * (width / Math.max(maxLegend, 1));
    return `<rect x="${x}" y="${y - 6}" width="8" height="8" rx="2" fill="${d.color}" opacity="0.85"/>
      <text x="${x + 11}" y="${y + 1}" font-size="9" fill="rgba(128,120,153,0.9)">${escapeXml(d.label)} (${d.value})</text>`;
  }).join('') + (legendItems.length > maxLegend
    ? `<text x="${8 + maxLegend * (width / maxLegend)}" y="${height - 10 + 1}" font-size="9" fill="rgba(128,120,153,0.6)">+${legendItems.length - maxLegend} more</text>`
    : '');

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-height:${height}px;display:block">
    ${sliceSvg}
    ${labelSvg}
    ${legend}
  </svg>`;
}

export function pieLegend(data) {
  return data.filter(d => d.value > 0).map(d =>
    `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:rgba(128,120,153,0.9)">
      <span style="width:8px;height:8px;border-radius:2px;background:${d.color};opacity:0.85;display:inline-block"></span>
      ${escapeXml(d.label)} (${d.value})
    </span>`
  ).join('');
}

function escapeXml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
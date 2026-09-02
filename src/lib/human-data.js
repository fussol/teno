// ═══════════════════════════════════════════════════════════════
// Human Data — Behavior tracking for human-mode noise.
// Stores up to 3 months of events. Computes multi-factor profile.
// Factors: circadian, fatigue, familiarity, weekend, consistency.
// Pure data layer — no DOM, no UI.
// ═══════════════════════════════════════════════════════════════

const STORAGE_KEY = 'humanEvents';
const PROFILE_KEY = 'humanProfile';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const PROFILE_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 50000;

let _eventsCache = null;

export function track(type, data) {
  try {
    const events = load();
    events.push({ t: Date.now(), type, data });
    prune(events);
    save(events);
  } catch (_) {}
}

let _cachedEvents = null;
export function getEvents() {
  if (_cachedEvents) return _cachedEvents;
  _cachedEvents = load();
  return _cachedEvents;
}
export function clearEventsCache() { _cachedEvents = null; }

export function getProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

export function computeProfile() {
  const events = load();
  if (events.length < 10) return null;
  const oldest = events[0].t;
  if (Date.now() - oldest < PROFILE_MIN_AGE_MS) return null;

  const days = Math.round((Date.now() - oldest) / 86400000) || 1;
  const hourDist = Array(24).fill(0);
  const dayOfWeekDist = Array(7).fill(0); // 0=Sun..6=Sat
  const pages = {};
  let studyCount = 0, examCount = 0, addCount = 0;

  for (const e of events) {
    const d = new Date(e.t);
    hourDist[d.getHours()]++;
    dayOfWeekDist[d.getDay()]++;
    if (e.type.startsWith('page:')) {
      const p = e.type.slice(5);
      pages[p] = (pages[p] || 0) + 1;
    } else if (e.type === 'study:card') studyCount++;
    else if (e.type === 'exam:complete') examCount++;
    else if (e.type === 'add:word') addCount++;
  }

  const peakHour = hourDist.indexOf(Math.max(...hourDist));
  const total = events.length;
  const avgPerDay = total / days;

  // Weekend vs weekday: compare avg Sat+Sun vs Mon-Fri
  const weekAvg = (dayOfWeekDist[1]+dayOfWeekDist[2]+dayOfWeekDist[3]+dayOfWeekDist[4]+dayOfWeekDist[5]) / 5;
  const weekendAvg = (dayOfWeekDist[0]+dayOfWeekDist[6]) / 2;
  const weekendRatio = weekAvg > 0 ? weekendAvg / weekAvg : 1;

  // Consistency: coefficient of variation across hours (lower = more consistent)
  const meanH = total / 24;
  const variance = hourDist.reduce((s, v) => s + (v - meanH) ** 2, 0) / 24;
  const consistency = Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / (meanH + 1)));

  const sortedPages = Object.entries(pages).sort((a, b) => b[1] - a[1]);

  const profile = {
    computedAt: Date.now(),
    totalDays: days,
    totalEvents: total,
    avgPerDay,
    peakHour,
    hourDist,
    dayOfWeekDist,
    weekendRatio,
    consistency,
    topPages: sortedPages.slice(0, 3).map(([p]) => p),
    studyCount, examCount, addCount,
    activityLevel: Math.min(total / 1000, 1),
  };

  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (_) {}
  return profile;
}

export function invalidateProfile() {
  try { localStorage.removeItem(PROFILE_KEY); } catch (_) {}
}

/**
 * Return all factor scores for the current moment.
 * Each factor is 0.5~1.5, centered at 1.0 (neutral).
 * Returns null if profile not ready.
 */
export function getFactors() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    const isWeekend = day === 0 || day === 6;

    // ── 1. Circadian — closer to peak hour → more alert ──
    const peakHour = p.peakHour ?? 14;
    const peakDiff = Math.abs(hour - peakHour);
    const circadian = 1.5 - (peakDiff / 12) * 0.8;
    // clamp 0.7-1.5

    // ── 2. Fatigue — events today vs avg → more done → more tired ──
    const todayEvents = getEvents().filter(e => {
      const d = new Date(e.t);
      const now2 = new Date();
      return d.getFullYear() === now2.getFullYear() && d.getMonth() === now2.getMonth() && d.getDate() === now2.getDate();
    }).length;
    const avgPerDay = p.avgPerDay ?? 20;
    const todayRatio = avgPerDay > 0 ? todayEvents / avgPerDay : 0.5;
    const fatigue = Math.max(0.6, Math.min(1.4, 1.4 - todayRatio * 0.5));

    // ── 3. Familiarity — experienced users get more stable noise ──
    const consistency = p.consistency ?? 0.5;
    const familiarity = Math.max(0.7, Math.min(1.3, 0.7 + consistency * 0.5));

    // ── 4. Weekend effect — weekend users behave differently ──
    let weekend = 1.0;
    const weekendRatio = p.weekendRatio ?? 0.2;
    if (weekendRatio > 0.3) {
      if (isWeekend) weekend = Math.min(1.3, 1.0 + weekendRatio * 0.3);
      else weekend = Math.max(0.7, 1.0 - weekendRatio * 0.2);
    }

    // ── 5. Consistency — irregular usage → more erratic noise ──
    const consistencyFactor = 1.0 + (1 - consistency) * 0.4; // less consistent → higher multiplier

    // ── Composite (weighted average) ──
    const composite = (
      circadian * 0.30 +
      fatigue * 0.20 +
      familiarity * 0.15 +
      weekend * 0.15 +
      consistencyFactor * 0.20
    );

    return {
      circadian: Math.max(0.5, Math.min(1.5, circadian)),
      fatigue: Math.max(0.5, Math.min(1.5, fatigue)),
      familiarity: Math.max(0.5, Math.min(1.5, familiarity)),
      weekend: Math.max(0.5, Math.min(1.5, weekend)),
      consistencyFactor: Math.max(0.5, Math.min(1.5, consistencyFactor)),
      composite: Math.max(0.5, Math.min(1.5, composite)),
    };
  } catch (_) { return null; }
}

function load() {
  if (_eventsCache) return _eventsCache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _eventsCache = raw ? JSON.parse(raw) : [];
    return _eventsCache;
  } catch (_) { return []; }
}

function save(events) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(events)); } catch (_) {}
}

function prune(events) {
  const cutoff = Date.now() - MAX_AGE_MS;
  while (events.length && events[0].t < cutoff) events.shift();
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

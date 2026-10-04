// ═══════════════════════════════════════════════════════════════
// Human Data — Behavior tracking for human-mode noise.
// Stores up to 3 months of events (fire-and-forget telemetry).
// Pure data layer — no DOM, no UI.
// ═══════════════════════════════════════════════════════════════

const STORAGE_KEY = 'humanEvents';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
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

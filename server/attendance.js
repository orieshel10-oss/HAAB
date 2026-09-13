function pad(n) {
  return String(n).padStart(2, '0');
}

function toDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowIso() {
  return new Date().toISOString();
}

// Pairs sequential 'in' -> 'out' events (already sorted by ts) and returns total minutes.
// An unmatched trailing 'in' (still clocked in) is not counted.
function computeMinutes(events) {
  let total = 0;
  let openIn = null;
  for (const ev of events) {
    if (ev.type === 'in') {
      openIn = ev.ts;
    } else if (ev.type === 'out' && openIn) {
      total += (new Date(ev.ts) - new Date(openIn)) / 60000;
      openIn = null;
    }
  }
  return Math.round(total);
}

function minutesToLabel(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${pad(m)}`;
}

module.exports = { pad, toDateKey, nowIso, computeMinutes, minutesToLabel };

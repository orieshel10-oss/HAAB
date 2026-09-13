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

function shiftDateStr(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Saturday is the weekly rest day; Friday is the shortened day before it (7h standard instead of 8h).
// This is a uniform, law-based approximation (no weekly aggregation, no per-employee agreement yet).
function dayTypeFromDate(year, month, day) {
  const dow = new Date(year, month - 1, day).getDay(); // 0=Sun ... 6=Sat (local)
  if (dow === 6) return 'rest';
  if (dow === 5) return 'shortened';
  return 'regular';
}

function standardDayMinutes(dayType) {
  if (dayType === 'rest') return 0;
  return dayType === 'shortened' ? 7 * 60 : 8 * 60;
}

// Splits a day's worked minutes into legal pay categories:
// regular (100%), first 2 overtime hours (125%), further overtime (150%),
// and hours worked on the weekly rest day (shabbat - requires special permit, paid at a premium).
function splitDayMinutes(totalMinutes, dayType) {
  if (dayType === 'rest') {
    return { regular: 0, ot125: 0, ot150: 0, shabbat: totalMinutes };
  }
  const standard = dayType === 'shortened' ? 7 * 60 : 8 * 60;
  const regular = Math.min(totalMinutes, standard);
  let remaining = totalMinutes - regular;
  const ot125 = Math.min(remaining, 120);
  remaining -= ot125;
  const ot150 = Math.max(remaining, 0);
  return { regular, ot125, ot150, shabbat: 0 };
}

module.exports = {
  pad,
  toDateKey,
  nowIso,
  computeMinutes,
  minutesToLabel,
  shiftDateStr,
  dayTypeFromDate,
  splitDayMinutes,
  standardDayMinutes
};

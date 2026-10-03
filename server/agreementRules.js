// Agreement-driven attendance split - replaces the plain generic rule in attendance.js
// (dayTypeFromDate/splitDayMinutes/standardDayMinutes) for any employee with an agreement_code
// assigned. An employee with no agreement keeps using the generic rule untouched (the sheet
// handler only calls into this module when an agreement row was found).
//
// Every row's `minutes` object always carries the same 6 keys: regular/ot125/ot150 (100%/125%/
// 150%, normal weekday rates) and shabbat150/shabbat175/shabbat200 (150%/175%/200%, Shabbat-
// window rates) - even branches that only ever populate a subset keep the full shape so the
// sheet handler's accumulation code never has to special-case which keys exist.
//
// Known simplification (documented, not a bug): if a merged group (groupSessionsIntoRows) ever
// contains both a night-qualifying session and a non-night one on the same date, the whole
// group's standard is treated as the night standard - mixed day+night sessions merging into one
// group under the existing <8h-gap rule is an edge case with no described rule of its own. The
// weekend (Friday/Saturday) computation below never applies the night-shift standard at all -
// another documented simplification, since no agreement currently combines both rules.

const { toDateKey, pairSessions, groupSessionsIntoRows, shiftDateStr } = require('./attendance');

const EMPTY_MINUTES = { regular: 0, ot125: 0, ot150: 0, shabbat150: 0, shabbat175: 0, shabbat200: 0 };

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Sums overlap between [inTs, outTs] and every instance of the recurring daily window
// [nightStart, nightEnd) (which may cross midnight) that the session could touch.
function nightOverlapMinutes(inTs, outTs, nightStart, nightEnd) {
  const inDate = new Date(inTs);
  const outDate = new Date(outTs);
  const startMin = timeToMinutes(nightStart);
  const endMin = timeToMinutes(nightEnd);

  const dateKeys = new Set([toDateKey(inTs), toDateKey(outTs)]);
  // also check the day before, in case the night window starts "yesterday" and the session
  // starts after local midnight while still inside that window.
  const dayBefore = new Date(inDate);
  dayBefore.setDate(dayBefore.getDate() - 1);
  dateKeys.add(toDateKey(dayBefore));

  let overlap = 0;
  for (const dateKey of dateKeys) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const windowStart = new Date(y, m - 1, d, Math.floor(startMin / 60), startMin % 60);
    const windowEnd = new Date(y, m - 1, d, Math.floor(endMin / 60), endMin % 60);
    if (endMin <= startMin) windowEnd.setDate(windowEnd.getDate() + 1);
    const overlapStart = Math.max(inDate.getTime(), windowStart.getTime());
    const overlapEnd = Math.min(outDate.getTime(), windowEnd.getTime());
    if (overlapEnd > overlapStart) overlap += (overlapEnd - overlapStart) / 60000;
  }
  return Math.round(overlap);
}

function isNightShift(session, agreement) {
  if (!agreement.night_start_time || !agreement.night_end_time || !agreement.night_min_overlap_minutes) return false;
  const overlap = nightOverlapMinutes(session.inTs, session.outTs, agreement.night_start_time, agreement.night_end_time);
  return overlap >= agreement.night_min_overlap_minutes;
}

function minutesOf(session) {
  return Math.round((new Date(session.outTs) - new Date(session.inTs)) / 60000);
}

function splitMinutesIntoTiers(totalMinutes, standardMinutes, agreement) {
  const tier1Minutes = Number.isInteger(agreement.ot_tier1_minutes) ? agreement.ot_tier1_minutes : 120;
  const regular = Math.min(totalMinutes, standardMinutes);
  let remaining = totalMinutes - regular;
  const ot125 = Math.min(remaining, tier1Minutes);
  remaining -= ot125;
  const ot150 = Math.max(remaining, 0);
  return { ...EMPTY_MINUTES, regular, ot125, ot150 };
}

// Determines which weekday is the "eve" (day before the weekly rest day) for this agreement -
// the day shortened_day_standard_minutes applies to, independent of the AI-era short_weekday
// concept below.
function weeklyRestEveWeekday(agreement) {
  return (agreement.weekly_rest_day + 6) % 7;
}

function standardMinutesForDay({ agreement, weekday, isHolidayEve }) {
  if (agreement.short_weekday !== null && agreement.short_weekday !== undefined && weekday === agreement.short_weekday) {
    return agreement.short_weekday_standard_minutes || agreement.day_standard_minutes;
  }
  if (isHolidayEve || weekday === weeklyRestEveWeekday(agreement)) {
    return agreement.shortened_day_standard_minutes;
  }
  return agreement.day_standard_minutes;
}

// Computes a non-weekend day's rows: standard/break/night/tier split only (no Shabbat-window
// concept - that's computeWeekendRows below). Shared by resolveDayPlan's regular-day branch and
// by computeAverageRegularMinutes.
function computeRegularDayRows({ agreement, group, weekday, isHolidayEve }) {
  const standard = standardMinutesForDay({ agreement, weekday, isHolidayEve });
  const anyNight = group.sessions.some((s) => isNightShift(s, agreement)) && agreement.night_standard_minutes;
  const effectiveStandard = anyNight ? agreement.night_standard_minutes : standard;

  const totalWorked = group.sessions.reduce((sum, s) => sum + minutesOf(s), 0);
  const breakAdjusted = Math.max(0, totalWorked - (agreement.break_minutes || 0));
  const split = splitMinutesIntoTiers(breakAdjusted, effectiveStandard, agreement);

  const rows = group.sessions.map((s, i) => ({
    firstIn: s.inTs,
    lastOut: s.outTs,
    type: s.type,
    note: s.note,
    minutes: i === group.sessions.length - 1 ? split : { ...EMPTY_MINUTES },
    showTotals: i === group.sessions.length - 1
  }));

  return { rows, regularMinutes: split.regular };
}

function toAbsoluteTime(dateKey, hhmm) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, h, min).getTime();
}

// Splits a session into up to 3 chronological chunks relative to [rangeStart, rangeEnd):
// before, inside, and after the range.
function splitSessionByRange(session, rangeStart, rangeEnd) {
  const inMs = new Date(session.inTs).getTime();
  const outMs = new Date(session.outTs).getTime();
  const chunks = [];
  const preEnd = Math.min(outMs, rangeStart);
  if (preEnd > inMs) chunks.push({ minutes: (preEnd - inMs) / 60000, inRange: false });
  const midStart = Math.max(inMs, rangeStart);
  const midEnd = Math.min(outMs, rangeEnd);
  if (midEnd > midStart) chunks.push({ minutes: (midEnd - midStart) / 60000, inRange: true });
  const postStart = Math.max(inMs, rangeEnd);
  if (outMs > postStart) chunks.push({ minutes: (outMs - postStart) / 60000, inRange: false });
  return chunks;
}

// Friday (eve) and Saturday (rest day) for a Saturday-rest agreement share one computation: a
// single "Shabbat window" [eve 16:00, rest-day 20:00) (both overridable, defaults per the user's
// own spec), applied against whichever of the two calendar dates a session-group actually starts
// on. Minutes are classified chronologically into regular/tier1/tier2 exactly like a normal day
// (the window boundary never resets that running total - hours already in progress when Shabbat
// starts simply continue their existing classification) and each minute's PAY RATE then depends
// separately on whether it fell inside the window: outside -> the normal regular/ot125/ot150
// buckets, inside -> shabbat150/shabbat175/shabbat200 (same tier thresholds, Shabbat rates).
function computeWeekendRows({ agreement, group, weekday }) {
  const eveWeekday = weeklyRestEveWeekday(agreement);
  const eveDateKey = weekday === eveWeekday ? group.date : shiftDateStr(group.date, -1);
  const restDateKey = shiftDateStr(eveDateKey, 1);
  const entryTime = agreement.weekly_rest_entry_time || '16:00';
  const exitTime = agreement.weekly_rest_exit_time || '20:00';
  const shabbatStart = toAbsoluteTime(eveDateKey, entryTime);
  const shabbatEnd = toAbsoluteTime(restDateKey, exitTime);

  let chunks = [];
  group.sessions.forEach((s) => { chunks.push(...splitSessionByRange(s, shabbatStart, shabbatEnd)); });
  chunks = chunks.filter((c) => c.minutes > 0);

  // Break is trimmed off the front of the chronological chunk list - same "as if taken right at
  // the start of the shift" simplification used elsewhere in this module.
  let remainingBreak = agreement.break_minutes || 0;
  const trimmed = [];
  for (const c of chunks) {
    if (remainingBreak <= 0) { trimmed.push(c); continue; }
    if (c.minutes <= remainingBreak) { remainingBreak -= c.minutes; continue; }
    trimmed.push({ ...c, minutes: c.minutes - remainingBreak });
    remainingBreak = 0;
  }

  const standard = agreement.day_standard_minutes;
  const tier1Cap = Number.isInteger(agreement.ot_tier1_minutes) ? agreement.ot_tier1_minutes : 120;

  const totals = { ...EMPTY_MINUTES };
  let running = 0;
  for (const c of trimmed) {
    let remaining = c.minutes;
    while (remaining > 0.000001) {
      let bucketKey, capRemaining;
      if (running < standard) {
        capRemaining = standard - running;
        bucketKey = c.inRange ? 'shabbat150' : 'regular';
      } else if (running < standard + tier1Cap) {
        capRemaining = standard + tier1Cap - running;
        bucketKey = c.inRange ? 'shabbat175' : 'ot125';
      } else {
        capRemaining = remaining;
        bucketKey = c.inRange ? 'shabbat200' : 'ot150';
      }
      const take = Math.min(remaining, capRemaining);
      totals[bucketKey] += take;
      running += take;
      remaining -= take;
    }
  }
  Object.keys(totals).forEach((k) => { totals[k] = Math.round(totals[k]); });

  const rows = group.sessions.map((s, i) => ({
    firstIn: s.inTs,
    lastOut: s.outTs,
    type: s.type,
    note: s.note,
    minutes: i === group.sessions.length - 1 ? totals : { ...EMPTY_MINUTES },
    showTotals: i === group.sessions.length - 1
  }));

  return { rows, regularMinutes: totals.regular };
}

async function computeAverageRegularMinutes(pool, employeeId, beforeDate, months, agreement) {
  const since = new Date(beforeDate);
  since.setMonth(since.getMonth() - months);
  const sinceStr = toDateKey(since);

  const { rows: events } = await pool.query(
    'SELECT type, ts FROM attendance_events WHERE employee_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts',
    [employeeId, `${sinceStr}T00:00:00.000Z`, `${beforeDate}T00:00:00.000Z`]
  );
  const { rows: reports } = await pool.query(
    `SELECT date, entry_ts, exit_ts, type, note FROM attendance_reports
     WHERE employee_id = $1 AND date >= $2 AND date < $3 AND entry_ts IS NOT NULL AND exit_ts IS NOT NULL`,
    [employeeId, sinceStr, beforeDate]
  );
  const { rows: holidayRows } = await pool.query(
    'SELECT date FROM holidays WHERE calendar_type = $1 AND is_eve = false AND date >= $2 AND date < $3',
    [agreement.holiday_calendar, sinceStr, beforeDate]
  );
  const holidaySet = new Set(holidayRows.map((h) => h.date));

  const clockSessions = pairSessions(events);
  const reportSessions = reports.map((r) => ({ inTs: r.entry_ts, outTs: r.exit_ts, type: r.type, note: r.note }));
  const allSessions = [...clockSessions, ...reportSessions].sort((a, b) => new Date(a.inTs) - new Date(b.inTs));
  const groups = groupSessionsIntoRows(allSessions);

  // Weekend days (eve + rest day) are excluded from the average pool entirely - their "regular
  // minutes" figure is entangled with the Shabbat-window split, not a plain standard-day number,
  // so they're not a meaningful ingredient for a "trailing average regular day" figure.
  const eveWeekday = weeklyRestEveWeekday(agreement);
  const values = [];
  for (const group of groups) {
    if (holidaySet.has(group.date)) continue;
    const [y, m, d] = group.date.split('-').map(Number);
    const weekday = new Date(y, m - 1, d).getDay();
    if (weekday === agreement.weekly_rest_day || weekday === eveWeekday) continue;
    const { regularMinutes } = computeRegularDayRows({ agreement, group, weekday, isHolidayEve: false });
    values.push(regularMinutes);
  }
  if (!values.length) return agreement.day_standard_minutes;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

// Main entry point, called once per date-group by the sheet handler. Mirrors the generic
// engine's { rows } shape exactly so the sheet handler's own accumulation code is unchanged.
function resolveDayPlan({ agreement, group, isHoliday, isHolidayEve, hasApprovedAbsence, employmentStartDate, holidayAverageRegularMinutes }) {
  const [y, m, d] = group.date.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const eveWeekday = weeklyRestEveWeekday(agreement);

  if (agreement.weekly_rest_day === 6 && (weekday === 6 || weekday === eveWeekday)) {
    const { rows } = computeWeekendRows({ agreement, group, weekday });
    return { rows };
  }

  if (weekday === agreement.weekly_rest_day) {
    // Non-Saturday rest day: no Shabbat-window concept, same flat full-credit behavior as before
    // (minus break), now in the shabbat150 bucket for shape consistency.
    const total = group.sessions.reduce((sum, s) => sum + minutesOf(s), 0);
    const breakAdjusted = Math.max(0, total - (agreement.break_minutes || 0));
    return {
      rows: [{
        firstIn: group.sessions[0].inTs,
        lastOut: group.sessions[group.sessions.length - 1].outTs,
        type: group.sessions[group.sessions.length - 1].type,
        note: group.sessions[group.sessions.length - 1].note,
        minutes: { ...EMPTY_MINUTES, shabbat150: breakAdjusted },
        showTotals: true
      }]
    };
  }

  if (isHoliday) {
    let eligible = false;
    if (agreement.holiday_pay_seniority_months && employmentStartDate) {
      const senior = new Date(employmentStartDate);
      senior.setMonth(senior.getMonth() + agreement.holiday_pay_seniority_months);
      eligible = senior <= new Date(group.date);
    }
    if (!eligible && hasApprovedAbsence) eligible = true;
    const credit = eligible ? (holidayAverageRegularMinutes ?? agreement.day_standard_minutes) : 0;
    return {
      rows: [{
        firstIn: null,
        lastOut: null,
        type: null,
        note: null,
        minutes: { ...EMPTY_MINUTES, regular: credit },
        showTotals: true
      }]
    };
  }

  const { rows } = computeRegularDayRows({ agreement, group, weekday, isHolidayEve });
  return { rows };
}

function hasAgreement(agreement) {
  return !!agreement;
}

module.exports = {
  resolveDayPlan,
  computeAverageRegularMinutes,
  hasAgreement,
  isNightShift,
  nightOverlapMinutes,
  standardMinutesForDay,
  weeklyRestEveWeekday,
  EMPTY_MINUTES
};

// Agreement-driven attendance split - replaces the plain generic rule in attendance.js
// (dayTypeFromDate/splitDayMinutes/standardDayMinutes) for any employee with an agreement_code
// assigned. An employee with no agreement keeps using the generic rule untouched (the sheet
// handler only calls into this module when an agreement row was found).
//
// Known simplification (documented, not a bug): if a merged group (groupSessionsIntoRows) ever
// contains both a night-qualifying session and a non-night one on the same date, the whole
// group's standard is treated as the night standard - mixed day+night sessions merging into one
// group under the existing <8h-gap rule is an edge case with no described rule of its own.

const { toDateKey, pairSessions, groupSessionsIntoRows } = require('./attendance');

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

// Splits a session into a pre-boundary and post-boundary part at a given clock time on the
// session's own calendar date (dateKey). Used for weekly_rest_entry_time blending (eve-of-rest
// hours after e.g. 16:00 count as rest-day hours even though the calendar date hasn't changed).
function splitSessionAtTime(session, dateKey, hhmm) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const boundary = new Date(y, m - 1, d, h, min).getTime();
  const inMs = new Date(session.inTs).getTime();
  const outMs = new Date(session.outTs).getTime();
  if (boundary <= inMs) return { pre: null, post: session };
  if (boundary >= outMs) return { pre: session, post: null };
  const boundaryIso = new Date(boundary).toISOString();
  return {
    pre: { ...session, outTs: boundaryIso },
    post: { ...session, inTs: boundaryIso }
  };
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
  return { regular, ot125, ot150, shabbat: 0 };
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

// Computes a non-holiday day's rows: standard/break/night/tier split, plus weekly-rest-entry
// blending (a single session on the eve day can become two rows, one of them a 'shabbat' row).
// Shared by resolveDayPlan's regular-day branch and by computeAverageRegularMinutes (which needs
// the same "regular minutes earned that day" figure for days inside its trailing window).
function computeRegularDayRows({ agreement, group, weekday, isHolidayEve }) {
  const standard = standardMinutesForDay({ agreement, weekday, isHolidayEve });
  const isEveDay = isHolidayEve || weekday === weeklyRestEveWeekday(agreement);
  const rows = [];
  const expanded = [];

  for (const session of group.sessions) {
    if (isEveDay && agreement.weekly_rest_entry_time) {
      const { pre, post } = splitSessionAtTime(session, group.date, agreement.weekly_rest_entry_time);
      if (pre) expanded.push({ session: pre, night: isNightShift(pre, agreement) });
      if (post) expanded.push({ session: post, shabbat: true });
    } else {
      expanded.push({ session, night: isNightShift(session, agreement) });
    }
  }

  const splitPortion = expanded.filter((e) => !e.shabbat);
  const shabbatPortion = expanded.filter((e) => e.shabbat);
  const anyNight = splitPortion.some((e) => e.night) && agreement.night_standard_minutes;
  const effectiveStandard = anyNight ? agreement.night_standard_minutes : standard;

  const totalWorked = splitPortion.reduce((sum, e) => sum + minutesOf(e.session), 0);
  const breakAdjusted = Math.max(0, totalWorked - (agreement.break_minutes || 0));
  const split = splitMinutesIntoTiers(breakAdjusted, effectiveStandard, agreement);

  // Each sub-session gets its own display row (firstIn/lastOut), but only the group's very last
  // row carries the real computed numbers - every earlier row shows zeroed minutes, same
  // convention the generic multi-session engine already uses (server/attendance.js).
  splitPortion.forEach((e) => {
    rows.push({
      firstIn: e.session.inTs,
      lastOut: e.session.outTs,
      type: e.session.type,
      note: e.session.note,
      minutes: { regular: 0, ot125: 0, ot150: 0, shabbat: 0 },
      showTotals: false
    });
  });
  const totalShabbatMinutes = shabbatPortion.reduce((sum, e) => sum + minutesOf(e.session), 0);
  shabbatPortion.forEach((e) => {
    rows.push({
      firstIn: e.session.inTs,
      lastOut: e.session.outTs,
      type: e.session.type,
      note: e.session.note,
      minutes: { regular: 0, ot125: 0, ot150: 0, shabbat: 0 },
      showTotals: false
    });
  });
  if (rows.length) {
    const last = rows[rows.length - 1];
    last.showTotals = true;
    last.minutes = shabbatPortion.length
      ? { regular: split.regular, ot125: split.ot125, ot150: split.ot150, shabbat: totalShabbatMinutes }
      : split;
  }

  return { rows, regularMinutes: split.regular };
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

  const values = [];
  for (const group of groups) {
    if (holidaySet.has(group.date)) continue;
    const [y, m, d] = group.date.split('-').map(Number);
    const weekday = new Date(y, m - 1, d).getDay();
    if (weekday === agreement.weekly_rest_day) continue;
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

  if (weekday === agreement.weekly_rest_day) {
    const total = group.sessions.reduce((sum, s) => sum + minutesOf(s), 0);
    const breakAdjusted = Math.max(0, total - (agreement.break_minutes || 0));
    return {
      rows: [{
        firstIn: group.sessions[0].inTs,
        lastOut: group.sessions[group.sessions.length - 1].outTs,
        type: group.sessions[group.sessions.length - 1].type,
        note: group.sessions[group.sessions.length - 1].note,
        minutes: { regular: 0, ot125: 0, ot150: 0, shabbat: breakAdjusted },
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
        minutes: { regular: credit, ot125: 0, ot150: 0, shabbat: 0 },
        showTotals: true
      }]
    };
  }

  const { rows } = computeRegularDayRows({ agreement, group, weekday, isHolidayEve });
  return { rows };
}

// True once an agreement has at least the 5 Phase-3 basic fields - which is every row today
// (they're NOT NULL with defaults) - so this always returns true for a real agreement row. Kept
// as a named check so the sheet handler's intent ("use the engine whenever an agreement exists")
// stays explicit rather than implicit.
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
  weeklyRestEveWeekday
};

const WEEKDAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const WEEKDAYS_LONG = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
const MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'
];

// Populated from GET /api/employee/report-types (the org's currently-whitelisted types) right
// after login/session-restore - replaces what used to be a hardcoded 5-entry object, since the
// actual list is now an admin-managed catalog (product level + org whitelist).
let REPORT_TYPES_BY_CODE = {};
async function loadReportTypes() {
  const types = await api('/api/employee/report-types');
  REPORT_TYPES_BY_CODE = {};
  types.forEach((t) => { REPORT_TYPES_BY_CODE[t.code] = t; });
}

// Mobile keyboards (confirmed on-device: a numeric keypad inside this app's RTL-dir page) can
// silently insert invisible Unicode bidi/formatting marks around typed or pasted digits -
// invisible on screen, but they break an exact-string server-side lookup/comparison. Strip those
// plus surrounding whitespace before sending or storing any login-identifier field. Mirrors the
// same sanitizeIdentifier() in server/auth.js, which is still the authoritative defense. Built
// from numeric code points (not literal \u escapes) so no invisible character ever lands in this
// source file itself.
const INVISIBLE_CHAR_CODES = [
  0x200B, 0x200C, 0x200D, 0x200E, 0x200F, // zero-width space/joiners, LTR/RTL marks
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E, // bidi embedding/override
  0x2066, 0x2067, 0x2068, 0x2069, // bidi isolate
  0xFEFF // BOM / zero-width no-break space
];
const INVISIBLE_CHARS_RE = new RegExp(`[${INVISIBLE_CHAR_CODES.map((c) => String.fromCharCode(c)).join('')}]`, 'g');
function sanitizeIdentifier(value) {
  return typeof value === 'string' ? value.replace(INVISIBLE_CHARS_RE, '').trim() : value;
}

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function todayStr() {
  const d = new Date();
  return dateStr(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401) { showAuthGate(); throw new Error('not authenticated'); }
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/* ---------- navigation ---------- */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  // Every entry starts fresh on today/the current month - whatever day or month was last
  // viewed before leaving these screens doesn't carry over.
  if (name === 'update') { updateCal.resetToToday(); updateCal.refresh(); loadDayPanel(updateCal.getSelectedDate()); }
  if (name === 'sheet') { sheetView.resetToCurrentMonth(); sheetView.refresh(); }
  if (name === 'approvals') { approvalsView.resetToCurrentMonth(); approvalsView.refresh(); }
  resetIdleTimer();
}

document.querySelectorAll('[data-nav]').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.nav));
});
document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => showScreen('home'));
});

/* ---------- home screen: status + clock in/out ---------- */
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statusSub = document.getElementById('status-sub');
const btnIn = document.getElementById('btn-in');
const btnOut = document.getElementById('btn-out');

function fmtTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function refreshStatus() {
  const { lastEvent, isIn } = await api('/api/status');
  statusDot.className = 'status-dot ' + (isIn ? 'in' : 'out');
  if (!lastEvent) {
    statusText.textContent = 'לא נרשמה נוכחות עדיין';
    statusSub.textContent = '';
  } else if (isIn) {
    statusText.textContent = 'מחובר';
    statusSub.textContent = `מאז השעה ${fmtTime(lastEvent.ts)}`;
  } else {
    statusText.textContent = 'לא מחובר';
    statusSub.textContent = `יציאה אחרונה בשעה ${fmtTime(lastEvent.ts)}`;
  }
  btnIn.disabled = isIn;
  btnOut.disabled = !isIn;
}

async function clock(type) {
  btnIn.disabled = true;
  btnOut.disabled = true;
  try {
    await api('/api/clock', { method: 'POST', body: JSON.stringify({ type }) });
  } finally {
    await refreshStatus();
  }
}
btnIn.addEventListener('click', () => clock('in'));
btnOut.addEventListener('click', () => clock('out'));

/* ---------- digital clock ---------- */
const clockTimeEl = document.getElementById('clock-time');
const clockDateEl = document.getElementById('clock-date');
function tickClock() {
  const d = new Date();
  clockTimeEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  clockDateEl.textContent = `${WEEKDAYS_LONG[d.getDay()]}, ${d.getDate()} ב${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}
tickClock();
setInterval(tickClock, 1000);

/* ---------- generic calendar controller ---------- */
function createCalendarController({ containerId, titleId, onRender, onDayClick }) {
  const container = document.getElementById(containerId);
  const titleEl = document.getElementById(titleId);
  const state = { year: new Date().getFullYear(), month: new Date().getMonth() + 1, selectedDate: todayStr() };

  function setMonth(delta) {
    state.month += delta;
    if (state.month > 12) { state.month = 1; state.year++; }
    if (state.month < 1) { state.month = 12; state.year--; }
    refresh();
  }

  function resetToToday() {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth() + 1;
    state.selectedDate = todayStr();
  }

  async function refresh() {
    titleEl.textContent = `${MONTH_NAMES[state.month - 1]} ${state.year}`;
    const cellData = await onRender(state.year, state.month);
    render(cellData);
  }

  function render(cellData) {
    const { year, month } = state;
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();

    let html = '<div class="cal-weekdays">' + WEEKDAYS.map(w => `<div>${w}</div>`).join('') + '</div>';
    html += '<div class="cal-days">';
    for (let i = 0; i < firstWeekday; i++) html += '<div class="cal-day empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = dateStr(year, month, d);
      const info = (cellData && cellData[ds]) || {};
      const classes = ['cal-day'];
      // "today" doubles as the visual "selected day" highlight here - the square moves to
      // whichever day was last tapped rather than always marking the literal current date.
      if (ds === state.selectedDate) classes.push('today');
      if (info.hoursLabel) classes.push('has-hours');
      if (info.isDayOff) classes.push('day-off');
      html += `<button class="${classes.join(' ')}" data-date="${ds}">
        <span class="day-dot ${info.dotGroup || ''}"></span>
        <span class="day-num">${d}</span>
        <span class="day-hours">${info.hoursLabel || ''}</span>
        <span class="day-holiday-label">${info.holidayLabel || ''}</span>
      </button>`;
    }
    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.cal-day:not(.empty)').forEach(el => {
      el.addEventListener('click', () => {
        state.selectedDate = el.dataset.date;
        render(cellData);
        onDayClick(el.dataset.date);
      });
    });
  }

  return { refresh, setMonth, resetToToday, getSelectedDate: () => state.selectedDate };
}

/* ---------- update-attendance screen (inline day panel: list of reports + one editor) ---------- */
let cachedSheetByDate = {};
const updateCal = createCalendarController({
  containerId: 'update-calendar',
  titleId: 'update-cal-title',
  onRender: async (year, month) => {
    const sheet = await api(`/api/attendance/sheet?year=${year}&month=${month}`);
    cachedSheetByDate = {};
    const cellData = {};
    sheet.days.forEach(day => {
      cachedSheetByDate[day.date] = day;
      const totalMinutes = day.rows.reduce((sum, r) =>
        sum + r.minutes.regular + r.minutes.ot125 + r.minutes.ot150 + r.minutes.shabbat150 + r.minutes.shabbat175 + r.minutes.shabbat200, 0);
      const reportTypes = day.rows.map(r => r.type).filter(t => t && t !== 'attendance');
      let dotGroup = null;
      if (reportTypes.some(t => (REPORT_TYPES_BY_CODE[t] || {}).category === 'absence')) dotGroup = 'sick';
      else if (reportTypes.length) dotGroup = 'vacation';
      cellData[day.date] = {
        hoursLabel: totalMinutes ? minutesToLabel(totalMinutes) : '',
        holidayLabel: day.isHoliday ? 'חג' : (day.isHolidayEve ? 'ערב חג' : ''),
        isDayOff: day.isDayOff,
        dotGroup
      };
    });
    return cellData;
  },
  onDayClick: loadDayPanel
});
document.querySelector('[data-cal-prev="update"]').addEventListener('click', () => updateCal.setMonth(-1));
document.querySelector('[data-cal-next="update"]').addEventListener('click', () => updateCal.setMonth(1));

function shiftIsoDate(iso, deltaDays) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return dateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

// Saturday-only standard-day length, mirroring server/attendance.js's dayTypeFromDate +
// standardDayMinutes exactly (the actual pay-category split stays this simple for now - see the
// sheet's own note) - used only for the day panel's quick total, not for law-based OT splitting.
function standardMinutesForDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  if (dow === 6) return 0;
  return dow === 5 ? 420 : 480;
}

function reportTypeLabel(type) {
  if (type === 'attendance') return 'נוכחות';
  return (REPORT_TYPES_BY_CODE[type] || {}).name || type;
}

/* ---------- update-attendance day panel: list of independent reports + one editor ---------- */
let panelDate = null;
let panelReports = [];
let editingReportId = null;
// Whether the exit field's value should actually be submitted. The field itself always shows a
// real time (never blank - see openEditor), so "no exit yet" can no longer be read off the
// string being empty; this flag is the real source of truth, flipped only by actually
// interacting with the field (see its 'change' listener below).
let exitTimeConfirmed = false;

async function loadDayPanel(date) {
  panelDate = date;
  editingReportId = null;
  const day = await api(`/api/attendance/day?date=${date}`);
  panelReports = day.reports;

  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  document.getElementById('day-panel-weekday').textContent = WEEKDAYS_LONG[weekday];
  document.getElementById('day-panel-date').textContent = `${pad(d)}.${pad(m)}.${y}`;

  const clockSessions = [];
  let openIn = null;
  day.events.forEach(ev => {
    if (ev.type === 'in') { openIn = ev.ts; }
    else if (ev.type === 'out' && openIn) { clockSessions.push(`${fmtTime(openIn)}-${fmtTime(ev.ts)}`); openIn = null; }
  });
  if (openIn) clockSessions.push(`${fmtTime(openIn)}-`);
  document.getElementById('day-panel-clock-events').textContent = clockSessions.length ? clockSessions.join(', ') : 'אין';

  // Only the independent reports count toward the total shown here - real clock punches (shown
  // read-only above) aren't reflected in this quick sum, matching how the two are kept separate
  // throughout this screen.
  let totalMinutes = 0;
  panelReports.forEach(r => {
    if (!r.entryTs) totalMinutes += standardMinutesForDate(date);
    else if (r.exitTs) totalMinutes += Math.round((new Date(r.exitTs) - new Date(r.entryTs)) / 60000);
  });
  document.getElementById('day-panel-total').textContent = totalMinutes ? `סה"כ ${minutesToLabel(totalMinutes)} שעות` : '';

  renderReportsList();
  closeEditor();
}

function renderReportsList() {
  const list = document.getElementById('day-panel-reports-list');
  if (!panelReports.length) {
    list.innerHTML = '<div class="day-panel-empty">לא דווחה נוכחות</div>';
    return;
  }
  list.innerHTML = panelReports.map(r => {
    const timeLabel = !r.entryTs ? 'יום שלם' : (r.exitTs ? `${fmtTime(r.entryTs)} - ${fmtTime(r.exitTs)}` : `${fmtTime(r.entryTs)} -`);
    return `
      <div class="day-panel-report-row" data-id="${r.id}">
        <button type="button" class="day-panel-report-delete" data-id="${r.id}" title="מחיקה">🗑</button>
        <span class="day-panel-report-type">${reportTypeLabel(r.type)}</span>
        <span class="day-panel-report-time">${timeLabel}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.day-panel-report-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('למחוק את הדיווח?')) return;
      await api(`/api/attendance/reports/${btn.dataset.id}`, { method: 'DELETE' });
      await loadDayPanel(panelDate);
      updateCal.refresh();
    });
  });
  list.querySelectorAll('.day-panel-report-row').forEach(row => {
    row.addEventListener('click', () => openEditor(panelReports.find(r => String(r.id) === row.dataset.id)));
  });
}

function buildTypeOptions(selected) {
  return [
    { value: 'attendance', label: 'נוכחות' },
    ...Object.values(REPORT_TYPES_BY_CODE).map(t => ({ value: t.code, label: t.name }))
  ].map(o => `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`).join('');
}

function syncEditorVisibility() {
  const type = document.getElementById('editor-type').value;
  const wholeDayWrap = document.getElementById('editor-wholeday-wrap');
  const wholeDayChecked = document.getElementById('editor-wholeday').checked;
  wholeDayWrap.classList.toggle('hidden', type === 'attendance');
  if (type === 'attendance') document.getElementById('editor-wholeday').checked = false;
  document.getElementById('editor-time-row').style.display = (type !== 'attendance' && wholeDayChecked) ? 'none' : 'flex';
}

function openEditor(report) {
  editingReportId = report ? report.id : null;
  const editor = document.getElementById('day-panel-editor');
  document.getElementById('editor-type').innerHTML = buildTypeOptions(report ? report.type : 'attendance');
  document.getElementById('editor-wholeday').checked = !!(report && !report.entryTs);
  // An empty time input lets the browser's native picker default its scroll/highlight position
  // to the current clock time when tapped, which is irrelevant here (clocking the *actual*
  // current time has its own buttons on the home screen) - both fields always show a real value
  // (00:00 default) to avoid that. "Exit not known yet" is tracked separately via
  // exitTimeConfirmed below, not by leaving this field blank.
  document.getElementById('editor-entry').value = report && report.entryTs ? fmtTime(report.entryTs) : '00:00';
  document.getElementById('editor-exit').value = report && report.exitTs ? fmtTime(report.exitTs) : '00:00';
  exitTimeConfirmed = !!(report && report.exitTs);
  const note = document.getElementById('editor-note');
  note.value = (report && report.note) || '';
  note.classList.toggle('hidden', !(report && report.note));
  document.getElementById('editor-note-toggle').classList.toggle('hidden', !!(report && report.note));
  syncEditorVisibility();
  editor.classList.remove('hidden');
  editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeEditor() {
  editingReportId = null;
  exitTimeConfirmed = false;
  const editor = document.getElementById('day-panel-editor');
  editor.reset();
  // Native form.reset() clears the time inputs to empty, not the app's own "00:00" convention -
  // reassert it explicitly so a cancelled/cleared editor doesn't reintroduce the native
  // current-time-picker-defaults-to-now quirk either field was fixed against.
  document.getElementById('editor-entry').value = '00:00';
  document.getElementById('editor-exit').value = '00:00';
  document.getElementById('editor-note').classList.add('hidden');
  document.getElementById('editor-note-toggle').classList.remove('hidden');
  editor.classList.add('hidden');
}

// The browser's own native time-picker widget (opened by tapping the field) has its own
// internal Clear/Cancel/Set buttons that a web page cannot see, label, or hook into directly -
// but using its own "Clear" does fire a change event with an empty value, which this catches.
// Both fields always snap back to 00:00 rather than staying blank: an empty time input makes the
// native picker default its highlight to the *current* clock time next time it's opened, which
// is wrong here regardless of which field it is. Native "Cancel" typically closes the picker
// without firing any event at all, so the field is left exactly as it was before - no handling
// needed for that case.
document.getElementById('editor-entry').addEventListener('change', (e) => {
  if (!e.target.value) e.target.value = '00:00';
});
// Exit's "not known yet" state can no longer be "the field is blank" (that's what caused the
// native-picker-jumps-to-now bug above) - it's tracked by this flag instead, set only by an
// actual interaction with the field. Using native Clear counts as "un-confirming" it, same as
// never having touched it.
document.getElementById('editor-exit').addEventListener('change', (e) => {
  if (!e.target.value) { e.target.value = '00:00'; exitTimeConfirmed = false; }
  else exitTimeConfirmed = true;
});

document.getElementById('day-panel-add-btn').addEventListener('click', () => openEditor(null));
document.getElementById('editor-cancel').addEventListener('click', closeEditor);
document.getElementById('editor-type').addEventListener('change', syncEditorVisibility);
document.getElementById('editor-wholeday').addEventListener('change', syncEditorVisibility);
document.getElementById('editor-note-toggle').addEventListener('click', () => {
  document.getElementById('editor-note').classList.remove('hidden');
  document.getElementById('editor-note-toggle').classList.add('hidden');
});

document.getElementById('day-panel-editor').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = document.getElementById('editor-type').value;
  const wholeDay = type !== 'attendance' && document.getElementById('editor-wholeday').checked;
  const entry = document.getElementById('editor-entry').value;
  const exit = document.getElementById('editor-exit').value;
  const note = document.getElementById('editor-note').value.trim();

  if (!wholeDay && !entry) {
    alert('יש להזין שעת כניסה, או לסמן יום שלם');
    return;
  }

  // exit's field value is never blank anymore (see the change listener above) - whether to
  // actually submit it is tracked by exitTimeConfirmed, not by the string itself.
  const exitGiven = !wholeDay && exitTimeConfirmed;
  const body = { date: panelDate, type, wholeDay, entry: wholeDay ? null : entry, exit: exitGiven ? exit : null, note: note || null };
  if (exitGiven) {
    // Cross-midnight: an exit earlier than its own entry happened the next day - the entry
    // always keeps this panel's own date, only the exit's date ever rolls over.
    body.exitDate = exit < entry ? shiftIsoDate(panelDate, 1) : panelDate;
  }

  if (editingReportId) {
    await api(`/api/attendance/reports/${editingReportId}`, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    await api('/api/attendance/reports', { method: 'POST', body: JSON.stringify(body) });
  }

  await loadDayPanel(panelDate);
  updateCal.refresh();
  refreshStatus();
});

/* ---------- analyzed sheet screen ---------- */
function createSheetController() {
  const titleEl = document.getElementById('sheet-cal-title');
  const tbody = document.getElementById('sheet-tbody');
  const totalsLabel = document.getElementById('sheet-totals-label');
  const totalsRow = document.getElementById('sheet-totals-row');
  const statStandardDays = document.getElementById('sheet-stat-standard-days');
  const statStandardHours = document.getElementById('sheet-stat-standard-hours');
  const statActualHours = document.getElementById('sheet-stat-actual-hours');
  const statActualDays = document.getElementById('sheet-stat-actual-days');
  const state = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };

  function setMonth(delta) {
    state.month += delta;
    if (state.month > 12) { state.month = 1; state.year++; }
    if (state.month < 1) { state.month = 12; state.year--; }
    refresh();
  }

  function resetToCurrentMonth() {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth() + 1;
  }

  async function refresh() {
    titleEl.textContent = `${MONTH_NAMES[state.month - 1]} ${state.year}`;
    const data = await api(`/api/attendance/sheet?year=${state.year}&month=${state.month}`);
    render(data);
  }

  function hoursCell(minutes) {
    return minutes ? minutesToLabel(minutes) : '';
  }

  // green = a plain attendance report/clock session; blue = a presence-category report (off-site,
  // e.g. conference/company event); red = an absence-category report. Each row carries its own
  // type now, so this is per-row, not a single day-level indicator.
  function dotClassForRow(row) {
    if (!row.type || row.type === 'attendance') return row.firstIn ? 'presence-dot-green' : '';
    const category = (REPORT_TYPES_BY_CODE[row.type] || {}).category;
    return category === 'presence' ? 'presence-dot-blue' : 'presence-dot-red';
  }

  let reasonByDate = {};

  function render(data) {
    const today = todayStr();
    reasonByDate = {};
    data.days.forEach((d) => { if (d.approvalStatus === 'rejected') reasonByDate[d.date] = d.rejectionReason; });

    tbody.innerHTML = data.days.map(day => {
      const rowClasses = [];
      if (day.date === today) rowClasses.push('today');
      if (day.isDayOff) rowClasses.push('day-off');
      const rejected = day.approvalStatus === 'rejected';

      const dayBadges = [];
      if (day.isHoliday) dayBadges.push('חג');
      else if (day.isHolidayEve) dayBadges.push('ערב חג');
      else if (day.isDayOff) dayBadges.push('שבת');
      const weekdayCell = dayBadges.length
        ? `${WEEKDAYS[day.weekday]}<br><small>${dayBadges.join(', ')}</small>`
        : WEEKDAYS[day.weekday];
      const dateCell = `${Number(day.date.slice(8, 10))}${rejected ? `<span class="rejection-dot" data-date="${day.date}" title="נדחה - הקש לצפייה בהערה">●</span>` : ''}`;

      return day.rows.map((row, i) => {
        const noteParts = [];
        if (row.type && row.type !== 'attendance') noteParts.push(reportTypeLabel(row.type));
        if (row.note) noteParts.push(row.note);
        const noteClass = row.type && row.type !== 'attendance'
          ? ((REPORT_TYPES_BY_CODE[row.type] || {}).category === 'presence' ? 'note-vacation' : 'note-sick')
          : '';
        const totalHoursCell = row.firstIn && row.lastOut ? hoursCell(Math.round((new Date(row.lastOut) - new Date(row.firstIn)) / 60000)) : '';
        // A rejected day's hours aren't broken into pay categories at all here - only the raw
        // total, shown in red, so it can't be mistaken for an approved/pending analysis.
        return `
        <tr class="${rowClasses.join(' ')}">
          ${i === 0 ? `<td rowspan="${day.rows.length}">${dateCell}</td>` : ''}
          ${i === 0 ? `<td rowspan="${day.rows.length}">${weekdayCell}</td>` : ''}
          <td><span class="presence-dot ${dotClassForRow(row)}"></span></td>
          <td>${row.firstIn ? fmtTime(row.firstIn) : ''}</td>
          <td>${row.lastOut ? fmtTime(row.lastOut) : ''}</td>
          <td class="${rejected ? 'rejected-hours' : ''}">${totalHoursCell}</td>
          <td>${rejected ? '' : hoursCell(row.minutes.regular)}</td>
          <td>${rejected ? '' : hoursCell(row.minutes.ot125)}</td>
          <td>${rejected ? '' : hoursCell(row.minutes.ot150)}</td>
          <td>${rejected ? '' : hoursCell(row.minutes.shabbat150)}</td>
          <td>${rejected ? '' : hoursCell(row.minutes.shabbat175)}</td>
          <td>${rejected ? '' : hoursCell(row.minutes.shabbat200)}</td>
          <td class="${noteClass}">${noteParts.join(' - ')}</td>
        </tr>`;
      }).join('');
    }).join('');

    tbody.querySelectorAll('.rejection-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        alert(reasonByDate[dot.dataset.date] || 'הדיווח נדחה');
      });
    });

    statStandardDays.textContent = data.totals.standardDays;
    statStandardHours.textContent = hoursCell(data.totals.standardMinutes) || '0:00';
    statActualHours.textContent = hoursCell(data.totals.actualMinutes) || '0:00';
    statActualDays.textContent = data.totals.actualDays;

    const absenceSummary = Object.entries(data.totals.absenceCounts)
      .map(([type, count]) => `${count} ${(REPORT_TYPES_BY_CODE[type] || { name: type }).name}`)
      .join(', ');
    totalsLabel.textContent = `סה"כ שעות מאושרות${absenceSummary ? ` (${absenceSummary})` : ''}`;
    totalsRow.innerHTML = `
      <td>${hoursCell(data.totals.regular)}</td>
      <td>${hoursCell(data.totals.ot125)}</td>
      <td>${hoursCell(data.totals.ot150)}</td>
      <td>${hoursCell(data.totals.shabbat150)}</td>
      <td>${hoursCell(data.totals.shabbat175)}</td>
      <td>${hoursCell(data.totals.shabbat200)}</td>`;
  }

  return { refresh, setMonth, resetToCurrentMonth };
}
const sheetView = createSheetController();
document.querySelector('[data-cal-prev="sheet"]').addEventListener('click', () => sheetView.setMonth(-1));
document.querySelector('[data-cal-next="sheet"]').addEventListener('click', () => sheetView.setMonth(1));

function minutesToLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${pad(m)}`;
}

/* ---------- attendance-approval screen: shown only to an employee also linked to an
   org_admin/time_admin row (home screen's "approvals-menu-item"). Reuses the same
   /api/employee/approvals* endpoints (server/routes/employeePortal.js), which derive the
   reviewer's org/sub-org scope from that link - no separate admin session is ever created. ---------- */
const STATUS_LABELS = { pending: 'ממתין לאישור', approved: 'מאושר', rejected: 'נדחה' };

function createApprovalsController() {
  const titleEl = document.getElementById('appr-month-title');
  const listEl = document.getElementById('appr-list');
  const state = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  let filter = 'pending';
  let rowsCache = [];

  function setMonth(delta) {
    state.month += delta;
    if (state.month > 12) { state.month = 1; state.year++; }
    if (state.month < 1) { state.month = 12; state.year--; }
    refresh();
  }

  function resetToCurrentMonth() {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth() + 1;
  }

  function toggleFilter() {
    filter = filter === 'pending' ? 'all' : 'pending';
    document.getElementById('appr-filter-toggle').textContent = filter === 'pending' ? 'הצגת הכל' : 'רק ממתינים לאישור';
    render();
  }

  function fmtApprDate(iso) {
    const [y, mo, d] = iso.split('-').map(Number);
    const weekday = new Date(y, mo - 1, d).getDay();
    return `${WEEKDAYS[weekday]} ${pad(d)}/${pad(mo)}`;
  }

  async function refresh() {
    titleEl.textContent = `${MONTH_NAMES[state.month - 1]} ${state.year}`;
    listEl.innerHTML = '<div class="day-panel-empty">טוען...</div>';
    rowsCache = await api(`/api/employee/approvals?year=${state.year}&month=${state.month}`);
    render();
  }

  function render() {
    const rows = filter === 'pending' ? rowsCache.filter(r => r.status === 'pending') : rowsCache;
    if (!rows.length) {
      listEl.innerHTML = `<div class="day-panel-empty">${filter === 'pending' ? 'אין דיווחים הממתינים לאישור' : 'אין דיווחים בחודש זה'}</div>`;
      return;
    }
    listEl.innerHTML = rows.map(r => {
      const summary = r.summary.map(s => `${reportTypeLabel(s.type)}: ${s.timeLabel}`).join(', ');
      return `
      <div class="appr-card" data-employee="${r.employeeId}" data-date="${r.date}">
        <div class="appr-card-head">
          <span class="appr-card-employee">${r.employeeName}</span>
          <span class="appr-card-date">${fmtApprDate(r.date)}</span>
        </div>
        <div class="appr-card-summary">${summary}${r.totalMinutes ? ` (${minutesToLabel(r.totalMinutes)})` : ''}</div>
        <div class="appr-card-status status-${r.status}">
          ${STATUS_LABELS[r.status]}
          ${r.status === 'rejected' ? `<div class="appr-card-reason">${r.rejectionReason}</div>` : ''}
          ${r.status !== 'pending' ? `<div class="appr-card-reason">${r.reviewedByName || ''}</div>` : ''}
        </div>
        <div class="appr-card-actions">
          ${r.status === 'pending' ? `
            <button type="button" class="appr-approve-btn">אשר</button>
            <button type="button" class="appr-reject-btn">דחה</button>` : ''}
          ${r.status === 'rejected' ? `<button type="button" class="appr-unreject-btn">ביטול דחייה</button>` : ''}
          <button type="button" class="appr-edit-btn" data-name="${r.employeeName}">עריכה</button>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.appr-approve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.appr-card');
        btn.disabled = true;
        try {
          await api('/api/employee/approvals/approve', {
            method: 'POST',
            body: JSON.stringify({ employeeId: Number(card.dataset.employee), date: card.dataset.date })
          });
          await refresh();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
    listEl.querySelectorAll('.appr-reject-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.appr-card');
        openRejectModal(Number(card.dataset.employee), card.dataset.date);
      });
    });
    listEl.querySelectorAll('.appr-unreject-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.appr-card');
        btn.disabled = true;
        try {
          await api('/api/employee/approvals/unreject', {
            method: 'POST',
            body: JSON.stringify({ employeeId: Number(card.dataset.employee), date: card.dataset.date })
          });
          await refresh();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
    listEl.querySelectorAll('.appr-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.appr-card');
        openDayEditor(Number(card.dataset.employee), btn.dataset.name, card.dataset.date);
      });
    });
  }

  let rejectTarget = null;
  function openRejectModal(employeeId, date) {
    rejectTarget = { employeeId, date };
    document.getElementById('appr-reject-reason').value = '';
    document.getElementById('appr-reject-msg').textContent = '';
    document.getElementById('appr-reject-overlay').classList.remove('hidden');
  }

  document.getElementById('appr-reject-cancel').addEventListener('click', () => {
    document.getElementById('appr-reject-overlay').classList.add('hidden');
  });
  document.getElementById('appr-reject-confirm').addEventListener('click', async () => {
    const reason = document.getElementById('appr-reject-reason').value.trim();
    const msg = document.getElementById('appr-reject-msg');
    if (!reason) { msg.textContent = 'נדרש לציין סיבת דחייה'; return; }
    const btn = document.getElementById('appr-reject-confirm');
    btn.disabled = true;
    try {
      await api('/api/employee/approvals/reject', {
        method: 'POST',
        body: JSON.stringify({ employeeId: rejectTarget.employeeId, date: rejectTarget.date, reason })
      });
      document.getElementById('appr-reject-overlay').classList.add('hidden');
      await refresh();
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('appr-approve-all-btn').addEventListener('click', async () => {
    if (!confirm(`לאשר את כל הדיווחים הממתינים של ${MONTH_NAMES[state.month - 1]} ${state.year}?`)) return;
    const btn = document.getElementById('appr-approve-all-btn');
    btn.disabled = true;
    try {
      const result = await api('/api/employee/approvals/approve-all', {
        method: 'POST',
        body: JSON.stringify({ year: state.year, month: state.month })
      });
      await refresh();
      alert(`אושרו ${result.count} דיווחים`);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('appr-prev').addEventListener('click', () => setMonth(-1));
  document.getElementById('appr-next').addEventListener('click', () => setMonth(1));
  document.getElementById('appr-filter-toggle').addEventListener('click', toggleFilter);

  /* ---------- admin day editor (Phase 4f): mirrors #screen-update's own day-panel editor, but
     for a different employee's day, via /api/employee/approvals/day + /approvals/reports*. ---------- */
  let editorEmployeeId = null;
  let editorDate = null;
  let editorReports = [];
  let editingReportId = null;
  let editorExitConfirmed = false;

  async function openDayEditor(employeeId, employeeName, date) {
    editorEmployeeId = employeeId;
    editorDate = date;
    editingReportId = null;
    const day = await api(`/api/employee/approvals/day?employeeId=${employeeId}&date=${date}`);
    editorReports = day.reports;

    document.getElementById('appr-editor-employee-name').textContent = employeeName;
    const [y, mo, d] = date.split('-').map(Number);
    document.getElementById('appr-editor-date-label').textContent = `${pad(d)}.${pad(mo)}.${y}`;

    const clockSessions = [];
    let openIn = null;
    day.events.forEach(ev => {
      if (ev.type === 'in') { openIn = ev.ts; }
      else if (ev.type === 'out' && openIn) { clockSessions.push(`${fmtTime(openIn)}-${fmtTime(ev.ts)}`); openIn = null; }
    });
    if (openIn) clockSessions.push(`${fmtTime(openIn)}-`);
    document.getElementById('appr-editor-clock-events').textContent = clockSessions.length ? clockSessions.join(', ') : 'אין';

    renderEditorReportsList();
    closeReportForm();
    document.getElementById('appr-day-editor').classList.remove('hidden');
    document.getElementById('appr-day-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderEditorReportsList() {
    const list = document.getElementById('appr-editor-reports-list');
    if (!editorReports.length) {
      list.innerHTML = '<div class="day-panel-empty">לא דווחה נוכחות</div>';
      return;
    }
    list.innerHTML = editorReports.map(r => {
      const timeLabel = !r.entryTs ? 'יום שלם' : (r.exitTs ? `${fmtTime(r.entryTs)} - ${fmtTime(r.exitTs)}` : `${fmtTime(r.entryTs)} -`);
      return `
        <div class="day-panel-report-row" data-id="${r.id}">
          <button type="button" class="day-panel-report-delete" data-id="${r.id}" title="מחיקה">🗑</button>
          <span class="day-panel-report-type">${reportTypeLabel(r.type)}</span>
          <span class="day-panel-report-time">${timeLabel}</span>
        </div>`;
    }).join('');

    list.querySelectorAll('.day-panel-report-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('למחוק את הדיווח?')) return;
        await api(`/api/employee/approvals/reports/${btn.dataset.id}`, { method: 'DELETE' });
        await openDayEditor(editorEmployeeId, document.getElementById('appr-editor-employee-name').textContent, editorDate);
        await refresh();
      });
    });
    list.querySelectorAll('.day-panel-report-row').forEach(row => {
      row.addEventListener('click', () => openReportForm(editorReports.find(r => String(r.id) === row.dataset.id)));
    });
  }

  function syncReportFormVisibility() {
    const type = document.getElementById('appr-report-type').value;
    const wholeDayWrap = document.getElementById('appr-report-wholeday-wrap');
    const wholeDayChecked = document.getElementById('appr-report-wholeday').checked;
    wholeDayWrap.classList.toggle('hidden', type === 'attendance');
    if (type === 'attendance') document.getElementById('appr-report-wholeday').checked = false;
    document.getElementById('appr-report-time-row').style.display = (type !== 'attendance' && wholeDayChecked) ? 'none' : 'flex';
  }

  function openReportForm(report) {
    editingReportId = report ? report.id : null;
    const form = document.getElementById('appr-report-form');
    document.getElementById('appr-report-type').innerHTML = buildTypeOptions(report ? report.type : 'attendance');
    document.getElementById('appr-report-wholeday').checked = !!(report && !report.entryTs);
    document.getElementById('appr-report-entry').value = report && report.entryTs ? fmtTime(report.entryTs) : '00:00';
    document.getElementById('appr-report-exit').value = report && report.exitTs ? fmtTime(report.exitTs) : '00:00';
    editorExitConfirmed = !!(report && report.exitTs);
    const note = document.getElementById('appr-report-note');
    note.value = (report && report.note) || '';
    note.classList.toggle('hidden', !(report && report.note));
    document.getElementById('appr-report-note-toggle').classList.toggle('hidden', !!(report && report.note));
    syncReportFormVisibility();
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeReportForm() {
    editingReportId = null;
    editorExitConfirmed = false;
    const form = document.getElementById('appr-report-form');
    form.reset();
    document.getElementById('appr-report-entry').value = '00:00';
    document.getElementById('appr-report-exit').value = '00:00';
    document.getElementById('appr-report-note').classList.add('hidden');
    document.getElementById('appr-report-note-toggle').classList.remove('hidden');
    form.classList.add('hidden');
  }

  document.getElementById('appr-report-entry').addEventListener('change', (e) => {
    if (!e.target.value) e.target.value = '00:00';
  });
  document.getElementById('appr-report-exit').addEventListener('change', (e) => {
    if (!e.target.value) { e.target.value = '00:00'; editorExitConfirmed = false; }
    else editorExitConfirmed = true;
  });

  document.getElementById('appr-editor-add-btn').addEventListener('click', () => openReportForm(null));
  document.getElementById('appr-report-cancel').addEventListener('click', closeReportForm);
  document.getElementById('appr-report-type').addEventListener('change', syncReportFormVisibility);
  document.getElementById('appr-report-wholeday').addEventListener('change', syncReportFormVisibility);
  document.getElementById('appr-report-note-toggle').addEventListener('click', () => {
    document.getElementById('appr-report-note').classList.remove('hidden');
    document.getElementById('appr-report-note-toggle').classList.add('hidden');
  });
  document.getElementById('appr-editor-close').addEventListener('click', () => {
    document.getElementById('appr-day-editor').classList.add('hidden');
  });

  document.getElementById('appr-report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('appr-report-type').value;
    const wholeDay = type !== 'attendance' && document.getElementById('appr-report-wholeday').checked;
    const entry = document.getElementById('appr-report-entry').value;
    const exit = document.getElementById('appr-report-exit').value;
    const note = document.getElementById('appr-report-note').value.trim();

    if (!wholeDay && !entry) {
      alert('יש להזין שעת כניסה, או לסמן יום שלם');
      return;
    }

    const exitGiven = !wholeDay && editorExitConfirmed;
    const body = {
      employeeId: editorEmployeeId, date: editorDate, type, wholeDay,
      entry: wholeDay ? null : entry, exit: exitGiven ? exit : null, note: note || null
    };
    if (exitGiven) body.exitDate = exit < entry ? shiftIsoDate(editorDate, 1) : editorDate;

    if (editingReportId) {
      await api(`/api/employee/approvals/reports/${editingReportId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/employee/approvals/reports', { method: 'POST', body: JSON.stringify(body) });
    }

    await openDayEditor(editorEmployeeId, document.getElementById('appr-editor-employee-name').textContent, editorDate);
    await refresh();
  });

  return { refresh, resetToCurrentMonth };
}
const approvalsView = createApprovalsController();

/* ---------- auth: org selection + employee login ---------- */
const ORG_CODE_STORAGE_KEY = 'haab_org_code';
const EMPLOYEE_ID_STORAGE_KEY = 'haab_employee_id';
const EMPLOYEE_NAME_STORAGE_KEY = 'haab_employee_name';

function greetingForHour(hour) {
  if (hour >= 5 && hour < 10) return 'בוקר טוב';
  if (hour >= 10 && hour < 18) return 'שלום';
  if (hour >= 18 && hour < 21) return 'ערב טוב';
  return 'לילה טוב';
}

function showOrgLoginBranding(org) {
  document.getElementById('employee-login-org-name').textContent = org.name;
  const logoImg = document.getElementById('employee-login-org-logo');
  if (org.logoDataUrl) {
    logoImg.src = org.logoDataUrl;
    logoImg.classList.remove('hidden');
  } else {
    logoImg.classList.add('hidden');
  }
}

// After a first successful login the id-number is remembered too, so returning visits only ask
// for the password - the id input stays in the DOM (hidden, pre-filled) so the submit handler
// doesn't need two code paths.
function syncRememberedIdUi() {
  const savedId = localStorage.getItem(EMPLOYEE_ID_STORAGE_KEY);
  const savedName = localStorage.getItem(EMPLOYEE_NAME_STORAGE_KEY);
  const remembered = document.getElementById('employee-login-id-remembered');
  const field = document.getElementById('employee-login-id-field');
  const input = document.getElementById('employee-login-id');
  if (savedId) {
    input.value = savedId;
    const greeting = greetingForHour(new Date().getHours());
    remembered.textContent = savedName ? `${greeting}, ${savedName}` : greeting;
    remembered.classList.remove('hidden');
    field.classList.add('hidden');
  } else {
    input.value = '';
    remembered.classList.add('hidden');
    field.classList.remove('hidden');
  }
}

// Re-entry point whenever we're not authenticated (cold start with no session, or a 401 from
// any API call mid-use e.g. an expired session) - decides between the org-select screen and the
// login screen based on whether an org code is already remembered on this device.
async function showAuthGate() {
  const savedCode = localStorage.getItem(ORG_CODE_STORAGE_KEY);
  if (!savedCode) {
    showScreen('org-select');
    return;
  }
  try {
    const res = await fetch(`/api/employee/organizations/${savedCode}`);
    if (!res.ok) throw new Error('org lookup failed');
    showOrgLoginBranding(await res.json());
    syncRememberedIdUi();
    showScreen('employee-login');
  } catch (e) {
    // The remembered org code no longer resolves (e.g. deleted) - fall back to org-select
    // rather than getting stuck showing a login form with no branding.
    localStorage.removeItem(ORG_CODE_STORAGE_KEY);
    localStorage.removeItem(EMPLOYEE_ID_STORAGE_KEY);
    localStorage.removeItem(EMPLOYEE_NAME_STORAGE_KEY);
    showScreen('org-select');
  }
}

const orgSelectForm = document.getElementById('org-select-form');
orgSelectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('org-select-msg');
  msg.textContent = '';
  const code = sanitizeIdentifier(document.getElementById('org-select-code').value);
  try {
    const res = await fetch(`/api/employee/organizations/${code}`);
    if (!res.ok) { msg.textContent = 'קוד ארגון לא נמצא'; return; }
    const org = await res.json();
    localStorage.setItem(ORG_CODE_STORAGE_KEY, code);
    showOrgLoginBranding(org);
    syncRememberedIdUi();
    showScreen('employee-login');
  } catch (e2) {
    msg.textContent = 'שגיאת תקשורת - נסו שוב';
  }
});

const employeeLoginForm = document.getElementById('employee-login-form');
employeeLoginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('employee-login-msg');
  msg.textContent = '';
  const orgCode = localStorage.getItem(ORG_CODE_STORAGE_KEY);
  const idNumber = sanitizeIdentifier(document.getElementById('employee-login-id').value);
  const password = sanitizeIdentifier(document.getElementById('employee-login-password').value);
  try {
    const res = await fetch('/api/employee/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgCode, idNumber, password })
    });
    if (!res.ok) { msg.textContent = 'פרטי התחברות שגויים'; return; }
    const loginData = await res.json();
    localStorage.setItem(EMPLOYEE_ID_STORAGE_KEY, idNumber);
    const fullName = [loginData.firstName, loginData.lastName].filter(Boolean).join(' ');
    if (fullName) localStorage.setItem(EMPLOYEE_NAME_STORAGE_KEY, fullName);
    employeeLoginForm.reset();
    await loadReportTypes();
    showScreen('home');
    refreshStatus();
    checkApprovalsAccess();
  } catch (e2) {
    msg.textContent = 'שגיאת תקשורת - נסו שוב';
  }
});

document.getElementById('employee-login-password-toggle').addEventListener('click', () => {
  const input = document.getElementById('employee-login-password');
  const btn = document.getElementById('employee-login-password-toggle');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
});

document.getElementById('change-org-btn').addEventListener('click', () => {
  localStorage.removeItem(ORG_CODE_STORAGE_KEY);
  localStorage.removeItem(EMPLOYEE_ID_STORAGE_KEY);
  localStorage.removeItem(EMPLOYEE_NAME_STORAGE_KEY);
  document.getElementById('org-select-code').value = '';
  document.getElementById('org-select-msg').textContent = '';
  showScreen('org-select');
});

document.getElementById('employee-logout-btn').addEventListener('click', async () => {
  await fetch('/api/employee/logout', { method: 'POST' });
  showAuthGate();
});

/* ---------- attendance-approval menu item: shown only for an employee also linked to an
   org_admin/time_admin row (server/routes/employeePortal.js's GET /admin-link). No separate
   login step or TOTP prompt - the employee's own login already proved who they are, so being
   linked is all it takes to also see this menu item and screen. Checked once right after a
   fresh login and once after a restored session's GET /api/employee/me. ---------- */
async function checkApprovalsAccess() {
  let linked = false;
  try {
    const res = await fetch('/api/employee/admin-link');
    if (res.ok) linked = (await res.json()).linked;
  } catch (e) {}
  document.getElementById('approvals-menu-item').classList.toggle('hidden', !linked);
}

/* ---------- idle auto-logout: 10 minutes with no interaction while an authenticated screen is
   showing logs the employee out back to the password-only login screen (org/id stay remembered).
   Explicitly not needed if the user would instead use the home screen's own in/out buttons for a
   real clock punch - this only guards an unattended, already-open session. ---------- */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const AUTHENTICATED_SCREENS = ['home', 'update', 'sheet', 'approvals'];
let idleTimer = null;

function isOnAuthenticatedScreen() {
  const active = document.querySelector('.screen.active');
  return !!active && AUTHENTICATED_SCREENS.includes(active.id.replace('screen-', ''));
}

async function handleIdleTimeout() {
  if (!isOnAuthenticatedScreen()) return;
  try { await fetch('/api/employee/logout', { method: 'POST' }); } catch (e) {}
  await showAuthGate();
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!isOnAuthenticatedScreen()) return;
  idleTimer = setTimeout(handleIdleTimeout, IDLE_TIMEOUT_MS);
}

['click', 'touchstart', 'keydown', 'scroll'].forEach((evt) => {
  document.addEventListener(evt, resetIdleTimer, { passive: true });
});

/* ---------- init ---------- */
(async () => {
  try {
    const res = await fetch('/api/employee/me');
    if (res.ok) {
      await loadReportTypes();
      showScreen('home');
      refreshStatus();
      checkApprovalsAccess();
    } else {
      await showAuthGate();
    }
  } catch (e) {
    await showAuthGate();
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

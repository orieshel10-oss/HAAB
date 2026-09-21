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
  if (name === 'update') updateCal.refresh();
  if (name === 'sheet') sheetView.refresh();
}

document.querySelectorAll('[data-nav]').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.nav));
});
document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => showScreen('home'));
});

/* ---------- modal ---------- */
const modalOverlay = document.getElementById('modal-overlay');
const modalEl = document.getElementById('modal');
function openModal(html) {
  modalEl.innerHTML = html;
  modalOverlay.classList.remove('hidden');
}
function closeModal() {
  modalOverlay.classList.add('hidden');
  modalEl.innerHTML = '';
}
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
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
      html += `<button class="${classes.join(' ')}" data-date="${ds}">
        <span class="day-dot ${info.dotGroup || ''}"></span>
        <span class="day-num">${d}</span>
        <span class="day-hours">${info.hoursLabel || ''}</span>
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

  return { refresh, setMonth };
}

/* ---------- update-attendance screen (type/absence report + editing, one form per day) ---------- */
const updateCal = createCalendarController({
  containerId: 'update-calendar',
  titleId: 'update-cal-title',
  onRender: async (year, month) => {
    const sheet = await api(`/api/attendance/sheet?year=${year}&month=${month}`);
    const cellData = {};
    sheet.days.forEach(day => {
      const totalMinutes = day.rows.reduce((sum, r) => sum + r.minutes.regular + r.minutes.ot125 + r.minutes.ot150 + r.minutes.shabbat, 0);
      const category = day.absence ? (REPORT_TYPES_BY_CODE[day.absence.type] || {}).category : null;
      cellData[day.date] = {
        hoursLabel: totalMinutes ? minutesToLabel(totalMinutes) : '',
        dotGroup: category === 'absence' ? 'sick' : (category === 'presence' ? 'vacation' : null)
      };
    });
    return cellData;
  },
  onDayClick: openUpdateModal
});
document.querySelector('[data-cal-prev="update"]').addEventListener('click', () => updateCal.setMonth(-1));
document.querySelector('[data-cal-next="update"]').addEventListener('click', () => updateCal.setMonth(1));

// Saturday has no standard hours (it's the rest day); Friday is the shortened 7h day; else 8h.
// Mirrors server/attendance.js's dayTypeFromDate+standardDayMinutes for the "whole day" default.
function standardHoursForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  if (dow === 6) return 0;
  return dow === 5 ? 7 : 8;
}

async function openUpdateModal(date) {
  const day = await api(`/api/attendance/day?date=${date}`);

  const initialType = day.absence ? day.absence.type : 'attendance';
  const initialWholeDay = day.absence ? day.events.length === 0 : false;
  const firstIn = day.events.find(e => e.type === 'in');
  const lastOutList = day.events.filter(e => e.type === 'out');
  const lastOut = lastOutList[lastOutList.length - 1];
  const initialEntry = firstIn ? fmtTime(firstIn.ts) : '08:00';
  const initialExit = lastOut ? fmtTime(lastOut.ts) : '17:00';
  const initialNote = day.absence && day.absence.note ? day.absence.note : '';

  const typeOptions = [
    { value: 'attendance', label: 'נוכחות' },
    ...Object.values(REPORT_TYPES_BY_CODE).map(t => ({ value: t.code, label: t.name }))
  ].map(o => `<option value="${o.value}" ${o.value === initialType ? 'selected' : ''}>${o.label}</option>`).join('');

  openModal(`
    <h2>${date}</h2>
    <select class="report-select" id="report-type">${typeOptions}</select>
    <label class="whole-day-toggle">
      <input type="checkbox" id="report-whole-day" ${initialWholeDay ? 'checked' : ''} />
      <span>יום שלם</span>
    </label>
    <div class="time-row" id="report-time-row">
      <div class="time-field">
        <label>שעת כניסה</label>
        <input type="time" id="report-entry" value="${initialEntry}" />
      </div>
      <div class="time-field">
        <label>שעת יציאה</label>
        <input type="time" id="report-exit" value="${initialExit}" />
      </div>
    </div>
    <textarea id="report-note" placeholder="הערה (לא חובה)">${initialNote}</textarea>
    <div class="modal-actions">
      <button class="modal-secondary" id="report-cancel">ביטול</button>
      <button class="modal-primary" id="report-save">שמירה</button>
    </div>
  `);

  const wholeDayCheckbox = document.getElementById('report-whole-day');
  const timeRow = document.getElementById('report-time-row');
  function syncTimeRowVisibility() {
    timeRow.style.display = wholeDayCheckbox.checked ? 'none' : 'flex';
  }
  syncTimeRowVisibility();
  wholeDayCheckbox.addEventListener('change', syncTimeRowVisibility);

  document.getElementById('report-cancel').addEventListener('click', closeModal);

  document.getElementById('report-save').addEventListener('click', async () => {
    const type = document.getElementById('report-type').value;
    const wholeDay = wholeDayCheckbox.checked;
    const entry = document.getElementById('report-entry').value;
    const exit = document.getElementById('report-exit').value;
    const note = document.getElementById('report-note').value.trim();

    if (!wholeDay && (!entry || !exit)) {
      alert('יש להזין שעת כניסה ושעת יציאה, או לסמן יום שלם');
      return;
    }

    await api(`/api/attendance/day/${date}/events`, { method: 'DELETE' });

    if (type === 'attendance') {
      await api(`/api/absences/${date}`, { method: 'DELETE' });
      if (wholeDay) {
        const hours = standardHoursForDate(date);
        await api('/api/attendance/manual', { method: 'POST', body: JSON.stringify({ date, type: 'in', time: '08:00' }) });
        await api('/api/attendance/manual', { method: 'POST', body: JSON.stringify({ date, type: 'out', time: `${pad(8 + hours)}:00` }) });
      } else {
        await api('/api/attendance/manual', { method: 'POST', body: JSON.stringify({ date, type: 'in', time: entry }) });
        await api('/api/attendance/manual', { method: 'POST', body: JSON.stringify({ date, type: 'out', time: exit }) });
      }
    } else {
      await api('/api/absences', { method: 'POST', body: JSON.stringify({ date, type, note }) });
      if (!wholeDay) {
        await api('/api/attendance/manual', { method: 'POST', body: JSON.stringify({ date, type: 'in', time: entry }) });
        await api('/api/attendance/manual', { method: 'POST', body: JSON.stringify({ date, type: 'out', time: exit }) });
      }
    }

    closeModal();
    updateCal.refresh();
    refreshStatus();
  });
}

/* ---------- analyzed sheet screen ---------- */
function createSheetController() {
  const titleEl = document.getElementById('sheet-cal-title');
  const tbody = document.getElementById('sheet-tbody');
  const tfoot = document.getElementById('sheet-tfoot');
  const state = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };

  function setMonth(delta) {
    state.month += delta;
    if (state.month > 12) { state.month = 1; state.year++; }
    if (state.month < 1) { state.month = 12; state.year--; }
    refresh();
  }

  async function refresh() {
    titleEl.textContent = `${MONTH_NAMES[state.month - 1]} ${state.year}`;
    const data = await api(`/api/attendance/sheet?year=${state.year}&month=${state.month}`);
    render(data);
  }

  function hoursCell(minutes) {
    return minutes ? minutesToLabel(minutes) : '';
  }

  // green = real clock punches with no report overriding the day; blue = a presence-category
  // report (off-site, e.g. conference/company event); red = an absence-category report.
  function dotClassForDay(day) {
    if (day.absence) {
      const category = (REPORT_TYPES_BY_CODE[day.absence.type] || {}).category;
      return category === 'presence' ? 'presence-dot-blue' : 'presence-dot-red';
    }
    if (day.rows.some(r => r.firstIn)) return 'presence-dot-green';
    return '';
  }

  function render(data) {
    const today = todayStr();
    tbody.innerHTML = data.days.map(day => {
      const rowClasses = [];
      if (day.date === today) rowClasses.push('today');
      if (day.dayType === 'rest') rowClasses.push('rest-day');

      const badges = [];
      if (day.isHoliday) badges.push('חג');
      if (day.isHolidayEve) badges.push('ערב חג');
      let noteClass = '';
      if (day.absence) {
        const meta = REPORT_TYPES_BY_CODE[day.absence.type];
        badges.push(meta ? meta.name : day.absence.type);
        noteClass = meta && meta.category === 'presence' ? 'note-vacation' : 'note-sick';
      } else if (day.dayType === 'rest') {
        badges.push('שבת');
      }
      const note = badges.join(', ');
      const dotClass = dotClassForDay(day);

      return day.rows.map((row, i) => `
        <tr class="${rowClasses.join(' ')}">
          ${i === 0 ? `<td rowspan="${day.rows.length}">${Number(day.date.slice(8, 10))}</td>` : ''}
          ${i === 0 ? `<td rowspan="${day.rows.length}">${WEEKDAYS[day.weekday]}</td>` : ''}
          <td><span class="presence-dot ${dotClass}"></span></td>
          <td>${row.firstIn ? fmtTime(row.firstIn) : ''}</td>
          <td>${row.lastOut ? fmtTime(row.lastOut) : ''}</td>
          <td>${hoursCell(row.minutes.regular)}</td>
          <td>${hoursCell(row.minutes.ot125)}</td>
          <td>${hoursCell(row.minutes.ot150)}</td>
          <td>${hoursCell(row.minutes.shabbat)}</td>
          ${i === 0 ? `<td class="${noteClass}" rowspan="${day.rows.length}">${note}</td>` : ''}
        </tr>`).join('');
    }).join('');

    const absenceSummary = Object.entries(data.totals.absenceCounts)
      .map(([type, count]) => `${count} ${(REPORT_TYPES_BY_CODE[type] || { name: type }).name}`)
      .join(', ');
    tfoot.innerHTML = `
      <tr>
        <td colspan="5">סה"כ${absenceSummary ? ` (${absenceSummary})` : ''}</td>
        <td>${hoursCell(data.totals.regular)}</td>
        <td>${hoursCell(data.totals.ot125)}</td>
        <td>${hoursCell(data.totals.ot150)}</td>
        <td>${hoursCell(data.totals.shabbat)}</td>
        <td></td>
      </tr>`;
  }

  return { refresh, setMonth };
}
const sheetView = createSheetController();
document.querySelector('[data-cal-prev="sheet"]').addEventListener('click', () => sheetView.setMonth(-1));
document.querySelector('[data-cal-next="sheet"]').addEventListener('click', () => sheetView.setMonth(1));

function minutesToLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${pad(m)}`;
}

/* ---------- auth: org selection + employee login ---------- */
const ORG_CODE_STORAGE_KEY = 'haab_org_code';
const EMPLOYEE_ID_STORAGE_KEY = 'haab_employee_id';

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
  const remembered = document.getElementById('employee-login-id-remembered');
  const field = document.getElementById('employee-login-id-field');
  const input = document.getElementById('employee-login-id');
  if (savedId) {
    input.value = savedId;
    remembered.textContent = `מחוברים כ: ${savedId}`;
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
    showScreen('org-select');
  }
}

const orgSelectForm = document.getElementById('org-select-form');
orgSelectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('org-select-msg');
  msg.textContent = '';
  const code = document.getElementById('org-select-code').value.trim();
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
  const idNumber = document.getElementById('employee-login-id').value.trim();
  const password = document.getElementById('employee-login-password').value;
  try {
    const res = await fetch('/api/employee/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgCode, idNumber, password })
    });
    if (!res.ok) { msg.textContent = 'פרטי התחברות שגויים'; return; }
    localStorage.setItem(EMPLOYEE_ID_STORAGE_KEY, idNumber);
    employeeLoginForm.reset();
    await loadReportTypes();
    showScreen('home');
    refreshStatus();
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
  document.getElementById('org-select-code').value = '';
  document.getElementById('org-select-msg').textContent = '';
  showScreen('org-select');
});

document.getElementById('employee-logout-btn').addEventListener('click', async () => {
  await fetch('/api/employee/logout', { method: 'POST' });
  showAuthGate();
});

/* ---------- init ---------- */
(async () => {
  try {
    const res = await fetch('/api/employee/me');
    if (res.ok) {
      await loadReportTypes();
      showScreen('home');
      refreshStatus();
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

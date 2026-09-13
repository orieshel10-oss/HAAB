const WEEKDAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const WEEKDAYS_LONG = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
const MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'
];

const ABSENCE_META = {
  vacation: { label: 'חופשה', group: 'vacation' },
  sick: { label: 'מחלה', group: 'sick' },
  child_sick: { label: 'מחלת ילד', group: 'sick' },
  spouse_sick: { label: 'מחלת בן זוג', group: 'sick' },
  conference: { label: 'כנס', group: 'vacation' }
};

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
  const state = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };

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
    const today = todayStr();

    let html = '<div class="cal-weekdays">' + WEEKDAYS.map(w => `<div>${w}</div>`).join('') + '</div>';
    html += '<div class="cal-days">';
    for (let i = 0; i < firstWeekday; i++) html += '<div class="cal-day empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = dateStr(year, month, d);
      const info = (cellData && cellData[ds]) || {};
      const classes = ['cal-day'];
      if (ds === today) classes.push('today');
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
      el.addEventListener('click', () => onDayClick(el.dataset.date));
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
      const totalMinutes = day.minutes.regular + day.minutes.ot125 + day.minutes.ot150 + day.minutes.shabbat;
      cellData[day.date] = {
        hoursLabel: totalMinutes ? minutesToLabel(totalMinutes) : '',
        dotGroup: day.absence ? (ABSENCE_META[day.absence.type] || {}).group || 'vacation' : null
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
    { value: 'vacation', label: ABSENCE_META.vacation.label },
    { value: 'sick', label: ABSENCE_META.sick.label },
    { value: 'child_sick', label: ABSENCE_META.child_sick.label },
    { value: 'spouse_sick', label: ABSENCE_META.spouse_sick.label },
    { value: 'conference', label: ABSENCE_META.conference.label }
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

  function render(data) {
    const today = todayStr();
    tbody.innerHTML = data.days.map(day => {
      const rowClasses = [];
      if (day.date === today) rowClasses.push('today');
      if (day.dayType === 'rest') rowClasses.push('rest-day');
      let note = '';
      let noteClass = '';
      if (day.absence) {
        const meta = ABSENCE_META[day.absence.type] || { label: day.absence.type, group: 'vacation' };
        note = meta.label;
        noteClass = meta.group === 'sick' ? 'note-sick' : 'note-vacation';
      } else if (day.dayType === 'rest') {
        note = 'שבת';
      }
      return `
        <tr class="${rowClasses.join(' ')}">
          <td>${Number(day.date.slice(8, 10))}</td>
          <td>${WEEKDAYS[day.weekday]}</td>
          <td>${day.firstIn ? fmtTime(day.firstIn) : ''}</td>
          <td>${day.lastOut ? fmtTime(day.lastOut) : ''}</td>
          <td>${hoursCell(day.minutes.regular)}</td>
          <td>${hoursCell(day.minutes.ot125)}</td>
          <td>${hoursCell(day.minutes.ot150)}</td>
          <td>${hoursCell(day.minutes.shabbat)}</td>
          <td class="${noteClass}">${note}</td>
        </tr>`;
    }).join('');

    const absenceSummary = Object.entries(data.totals.absenceCounts)
      .map(([type, count]) => `${count} ${(ABSENCE_META[type] || { label: type }).label}`)
      .join(', ');
    tfoot.innerHTML = `
      <tr>
        <td colspan="4">סה"כ${absenceSummary ? ` (${absenceSummary})` : ''}</td>
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

/* ---------- init ---------- */
refreshStatus();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

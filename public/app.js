const WEEKDAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const WEEKDAYS_LONG = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
const MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'
];

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
      if (info.className) classes.push(info.className);
      if (info.hoursLabel) classes.push('has-hours');
      html += `<button class="${classes.join(' ')}" data-date="${ds}">
        <span class="day-num">${d}</span>
        ${info.hoursLabel ? `<span class="day-hours">${info.hoursLabel}</span>` : ''}
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

async function loadAbsenceMap(year, month) {
  const rows = await api(`/api/absences?year=${year}&month=${month}`);
  const map = {};
  rows.forEach(r => { map[r.date] = r; });
  return map;
}
async function loadSummaryMap(year, month) {
  const rows = await api(`/api/attendance/summary?year=${year}&month=${month}`);
  const map = {};
  rows.forEach(r => { map[r.date] = r; });
  return map;
}

/* ---------- update-attendance screen (absence + manual entries + editing) ---------- */
const updateCal = createCalendarController({
  containerId: 'update-calendar',
  titleId: 'update-cal-title',
  onRender: async (year, month) => {
    const [absences, summary] = await Promise.all([loadAbsenceMap(year, month), loadSummaryMap(year, month)]);
    const cellData = {};
    Object.entries(summary).forEach(([ds, s]) => {
      cellData[ds] = cellData[ds] || {};
      if (s.label) cellData[ds].hoursLabel = s.label;
    });
    Object.entries(absences).forEach(([ds, a]) => {
      cellData[ds] = { ...(cellData[ds] || {}), className: a.type };
    });
    return cellData;
  },
  onDayClick: openUpdateModal
});
document.querySelector('[data-cal-prev="update"]').addEventListener('click', () => updateCal.setMonth(-1));
document.querySelector('[data-cal-next="update"]').addEventListener('click', () => updateCal.setMonth(1));

async function openUpdateModal(date) {
  const day = await api(`/api/attendance/day?date=${date}`);
  let absenceSelected = day.absence ? day.absence.type : null;

  function render(day, editingId) {
    absenceSelected = day.absence ? day.absence.type : absenceSelected;
    const noteValue = day.absence && day.absence.note ? day.absence.note : '';

    const rows = day.events.map(ev => {
      if (ev.id === editingId) {
        return `
          <li>
            <input type="time" id="edit-time-${ev.id}" value="${fmtTime(ev.ts)}" />
            <span class="ev-type ${ev.type}">${ev.type === 'in' ? 'כניסה' : 'יציאה'}</span>
            <span class="ev-actions">
              <button class="ev-del ev-save" data-id="${ev.id}">✓</button>
            </span>
          </li>`;
      }
      return `
        <li>
          <span>${fmtTime(ev.ts)} ${ev.source === 'manual' ? '(ידני)' : ''}</span>
          <span class="ev-type ${ev.type}">${ev.type === 'in' ? 'כניסה' : 'יציאה'}</span>
          <span class="ev-actions">
            <button class="ev-del ev-edit" data-id="${ev.id}">✎</button>
            <button class="ev-del ev-remove" data-id="${ev.id}">✕</button>
          </span>
        </li>`;
    }).join('') || '<li>אין דיווחי נוכחות ביום זה</li>';

    openModal(`
      <h2>${date}</h2>

      <div class="modal-section-title">היעדרות</div>
      <div class="modal-row">
        <button class="modal-btn vacation ${absenceSelected === 'vacation' ? 'selected vacation' : ''}" id="opt-vacation">חופשה</button>
        <button class="modal-btn sick ${absenceSelected === 'sick' ? 'selected sick' : ''}" id="opt-sick">מחלה</button>
      </div>
      <textarea id="absence-note" placeholder="הערה (לא חובה)">${noteValue}</textarea>
      <div class="modal-actions">
        ${day.absence ? '<button class="modal-danger" id="absence-clear">נקה היעדרות</button>' : ''}
        <button class="modal-primary" id="absence-save">שמירת היעדרות</button>
      </div>

      <div class="modal-section-title">דיווחי נוכחות</div>
      <ul class="event-list">${rows}</ul>
      <div class="add-event-row">
        <select id="new-ev-type">
          <option value="in">כניסה</option>
          <option value="out">יציאה</option>
        </select>
        <input type="time" id="new-ev-time" value="08:00" />
        <button class="modal-primary" id="new-ev-add" style="flex:0 0 auto; padding:10px 16px;">הוסף</button>
      </div>

      <div class="modal-actions">
        <button class="modal-secondary" id="update-close">סגירה</button>
      </div>
    `);

    document.getElementById('opt-vacation').addEventListener('click', () => { absenceSelected = 'vacation'; render(day, null); });
    document.getElementById('opt-sick').addEventListener('click', () => { absenceSelected = 'sick'; render(day, null); });
    const clearBtn = document.getElementById('absence-clear');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      await api(`/api/absences/${date}`, { method: 'DELETE' });
      absenceSelected = null;
      const fresh = await api(`/api/attendance/day?date=${date}`);
      render(fresh, null);
      updateCal.refresh();
    });
    document.getElementById('absence-save').addEventListener('click', async () => {
      if (!absenceSelected) return;
      const note = document.getElementById('absence-note').value.trim();
      await api('/api/absences', { method: 'POST', body: JSON.stringify({ date, type: absenceSelected, note }) });
      const fresh = await api(`/api/attendance/day?date=${date}`);
      render(fresh, null);
      updateCal.refresh();
    });

    modalEl.querySelectorAll('.ev-edit').forEach(btn => {
      btn.addEventListener('click', () => render(day, Number(btn.dataset.id)));
    });
    modalEl.querySelectorAll('.ev-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const time = document.getElementById(`edit-time-${id}`).value;
        if (!time) return;
        await api(`/api/attendance/event/${id}`, { method: 'PUT', body: JSON.stringify({ time }) });
        const fresh = await api(`/api/attendance/day?date=${date}`);
        render(fresh, null);
        updateCal.refresh();
      });
    });
    modalEl.querySelectorAll('.ev-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api(`/api/attendance/event/${btn.dataset.id}`, { method: 'DELETE' });
        const fresh = await api(`/api/attendance/day?date=${date}`);
        render(fresh, null);
        updateCal.refresh();
      });
    });
    document.getElementById('new-ev-add').addEventListener('click', async () => {
      const type = document.getElementById('new-ev-type').value;
      const time = document.getElementById('new-ev-time').value;
      if (!time) return;
      await api('/api/attendance/manual', { method: 'POST', body: JSON.stringify({ date, type, time }) });
      const fresh = await api(`/api/attendance/day?date=${date}`);
      render(fresh, null);
      updateCal.refresh();
    });
    document.getElementById('update-close').addEventListener('click', () => {
      closeModal();
      refreshStatus();
    });
  }
  render(day, null);
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
        note = day.absence.type === 'vacation' ? 'חופשה' : 'מחלה';
        noteClass = day.absence.type === 'vacation' ? 'note-vacation' : 'note-sick';
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

    tfoot.innerHTML = `
      <tr>
        <td colspan="4">סה"כ (${data.totals.vacationDays} חופשה, ${data.totals.sickDays} מחלה)</td>
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

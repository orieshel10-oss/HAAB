const WEEKDAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
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
  if (name === 'absence') absenceCal.refresh();
  if (name === 'manual') manualCal.refresh();
  if (name === 'reports') reportsCal.refresh();
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

/* ---------- absence screen ---------- */
const absenceCal = createCalendarController({
  containerId: 'absence-calendar',
  titleId: 'absence-cal-title',
  onRender: async (year, month) => {
    const absences = await loadAbsenceMap(year, month);
    const cellData = {};
    Object.entries(absences).forEach(([ds, a]) => { cellData[ds] = { className: a.type }; });
    return cellData;
  },
  onDayClick: openAbsenceModal
});
document.querySelector('[data-cal-prev="absence"]').addEventListener('click', () => absenceCal.setMonth(-1));
document.querySelector('[data-cal-next="absence"]').addEventListener('click', () => absenceCal.setMonth(1));

async function openAbsenceModal(date) {
  const absences = await api(`/api/absences?year=${date.slice(0, 4)}&month=${Number(date.slice(5, 7))}`);
  const existing = absences.find(a => a.date === date) || null;
  let selected = existing ? existing.type : null;

  function render() {
    openModal(`
      <h2>${date}</h2>
      <div class="modal-row">
        <button class="modal-btn vacation ${selected === 'vacation' ? 'selected vacation' : ''}" id="opt-vacation">חופשה</button>
        <button class="modal-btn sick ${selected === 'sick' ? 'selected sick' : ''}" id="opt-sick">מחלה</button>
      </div>
      <textarea id="absence-note" placeholder="הערה (לא חובה)">${existing && existing.note ? existing.note : ''}</textarea>
      <div class="modal-actions">
        ${existing ? '<button class="modal-danger" id="absence-clear">נקה</button>' : ''}
        <button class="modal-secondary" id="absence-cancel">ביטול</button>
        <button class="modal-primary" id="absence-save">שמירה</button>
      </div>
    `);
    document.getElementById('opt-vacation').addEventListener('click', () => { selected = 'vacation'; render(); });
    document.getElementById('opt-sick').addEventListener('click', () => { selected = 'sick'; render(); });
    document.getElementById('absence-cancel').addEventListener('click', closeModal);
    const clearBtn = document.getElementById('absence-clear');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      await api(`/api/absences/${date}`, { method: 'DELETE' });
      closeModal();
      absenceCal.refresh();
    });
    document.getElementById('absence-save').addEventListener('click', async () => {
      if (!selected) return;
      const note = document.getElementById('absence-note').value.trim();
      await api('/api/absences', { method: 'POST', body: JSON.stringify({ date, type: selected, note }) });
      closeModal();
      absenceCal.refresh();
    });
  }
  render();
}

/* ---------- manual attendance screen ---------- */
const manualCal = createCalendarController({
  containerId: 'manual-calendar',
  titleId: 'manual-cal-title',
  onRender: async (year, month) => {
    const [absences, summary] = await Promise.all([loadAbsenceMap(year, month), loadSummaryMap(year, month)]);
    const cellData = {};
    Object.entries(absences).forEach(([ds, a]) => { cellData[ds] = { className: a.type }; });
    Object.entries(summary).forEach(([ds, s]) => {
      cellData[ds] = cellData[ds] || {};
      if (s.label) cellData[ds].hoursLabel = s.label;
    });
    return cellData;
  },
  onDayClick: openManualModal
});
document.querySelector('[data-cal-prev="manual"]').addEventListener('click', () => manualCal.setMonth(-1));
document.querySelector('[data-cal-next="manual"]').addEventListener('click', () => manualCal.setMonth(1));

async function openManualModal(date) {
  const day = await api(`/api/attendance/day?date=${date}`);

  function render(day) {
    const rows = day.events.map(ev => `
      <li>
        <span>${fmtTime(ev.ts)} ${ev.source === 'manual' ? '(ידני)' : ''}</span>
        <span class="ev-type ${ev.type}">${ev.type === 'in' ? 'כניסה' : 'יציאה'}</span>
        <button class="ev-del" data-id="${ev.id}">✕</button>
      </li>
    `).join('') || '<li>אין דיווחים ביום זה</li>';

    openModal(`
      <h2>${date}</h2>
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
        <button class="modal-secondary" id="manual-close">סגירה</button>
      </div>
    `);

    modalEl.querySelectorAll('.ev-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api(`/api/attendance/event/${btn.dataset.id}`, { method: 'DELETE' });
        const fresh = await api(`/api/attendance/day?date=${date}`);
        render(fresh);
        manualCal.refresh();
      });
    });
    document.getElementById('new-ev-add').addEventListener('click', async () => {
      const type = document.getElementById('new-ev-type').value;
      const time = document.getElementById('new-ev-time').value;
      if (!time) return;
      await api('/api/attendance/manual', { method: 'POST', body: JSON.stringify({ date, type, time }) });
      const fresh = await api(`/api/attendance/day?date=${date}`);
      render(fresh);
      manualCal.refresh();
    });
    document.getElementById('manual-close').addEventListener('click', () => {
      closeModal();
      refreshStatus();
    });
  }
  render(day);
}

/* ---------- reports screen ---------- */
const reportsCal = createCalendarController({
  containerId: 'reports-calendar',
  titleId: 'reports-cal-title',
  onRender: async (year, month) => {
    const [absences, summary] = await Promise.all([loadAbsenceMap(year, month), loadSummaryMap(year, month)]);
    const cellData = {};
    Object.entries(summary).forEach(([ds, s]) => {
      if (s.label) cellData[ds] = { hoursLabel: s.label };
    });
    Object.entries(absences).forEach(([ds, a]) => {
      cellData[ds] = { ...(cellData[ds] || {}), className: a.type };
    });
    return cellData;
  },
  onDayClick: openReportModal
});
document.querySelector('[data-cal-prev="reports"]').addEventListener('click', () => reportsCal.setMonth(-1));
document.querySelector('[data-cal-next="reports"]').addEventListener('click', () => reportsCal.setMonth(1));

async function openReportModal(date) {
  const day = await api(`/api/attendance/day?date=${date}`);
  const rows = day.events.map(ev => `
    <li>
      <span>${fmtTime(ev.ts)}</span>
      <span class="ev-type ${ev.type}">${ev.type === 'in' ? 'כניסה' : 'יציאה'}</span>
    </li>
  `).join('') || '<li>אין דיווחי נוכחות ביום זה</li>';

  const absenceLine = day.absence
    ? `<div class="summary-line">${day.absence.type === 'vacation' ? 'חופשה' : 'מחלה'}${day.absence.note ? ' – ' + day.absence.note : ''}</div>`
    : '';
  const totalH = Math.floor(day.minutes / 60);
  const totalM = day.minutes % 60;
  const totalLine = day.minutes ? `<div class="summary-line">סה"כ שעות: ${totalH}:${pad(totalM)}</div>` : '';

  openModal(`
    <h2>${date}</h2>
    ${absenceLine}
    ${totalLine}
    <ul class="event-list">${rows}</ul>
    <div class="modal-actions">
      <button class="modal-secondary" id="report-close">סגירה</button>
    </div>
  `);
  document.getElementById('report-close').addEventListener('click', closeModal);
}

/* ---------- init ---------- */
refreshStatus();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

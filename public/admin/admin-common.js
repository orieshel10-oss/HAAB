// Shared helpers used across the admin pages (login/dashboard/organization).

// Wires an eye-icon toggle button next to a password input. Call after both elements exist
// in the DOM. Expects markup: <div class="pw-wrap"><input id=inputId type="password">
// <button type="button" id=btnId class="pw-toggle">👁</button></div>
function wirePasswordToggle(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
  });
}

// Logging out of a System Admin session asks for confirmation first (the user's own request -
// scoped specifically to System Admin; Org Admin/Time Admin logout stays a single click).
async function confirmSystemLogout() {
  if (!confirm('האם להתנתק?')) return;
  await fetch('/api/system/logout', { method: 'POST' });
  window.location.href = 'login.html';
}

const ORG_NAV_ITEMS = [
  { key: 'home', href: 'organization.html', label: 'בית' },
  { key: 'employees', href: 'employees.html', label: 'עובדים' },
  { key: 'agreements', href: 'org-agreements.html', label: 'הסכמים בארגון' },
  { key: 'report-types', href: 'org-report-types.html', label: 'סוגי נוכחות' },
  { key: 'admins', href: 'org-admins.html', label: 'מנהלים' }
];

// Renders the two-tier org header (small HAAB brand row, then org name/logo row) plus the
// persistent nav shared by every org-context page (Home/Employees/Org-agreements/Admins), into
// a placeholder element. `me` is the standard /api/org/me response shape (orgId, role, orgName,
// orgCode, orgLogoDataUrl, adminName). Centralizing this is what makes "Home always reachable"
// and "org identity always visible" true across employees.html/org-agreements.html/org-admins.html
// instead of each page re-implementing its own header/back-link logic.
function renderOrgHeader({ me, active, rootId }) {
  const root = document.getElementById(rootId || 'org-header-root');
  if (!root) return;

  const ROLE_LABELS = { system_admin: 'System Admin', org_admin: 'Org Admin', time_admin: 'Time Admin' };
  const showAdminsNav = me.role === 'system_admin' || me.role === 'org_admin';
  const showBackToSystem = me.role === 'system_admin';
  const showLogoUpload = me.role === 'system_admin';

  const navHtml = ORG_NAV_ITEMS
    .filter((item) => item.key !== 'admins' || showAdminsNav)
    .map((item) => `<a href="${item.href}" class="${item.key === active ? 'active' : ''}">${item.label}</a>`)
    .join('');

  root.innerHTML = `
    <header class="admin-header admin-header-brand">
      <img src="../icons/icon-192.png" alt="HAAB" class="brand-logo-sm" />
      <span class="brand-name-sm">HAAB</span>
    </header>
    <div class="org-banner">
      <img class="org-logo ${me.orgLogoDataUrl ? '' : 'hidden'}" id="org-banner-logo" src="${me.orgLogoDataUrl || ''}" alt="" />
      <div class="org-banner-info">
        <h1>${me.orgName || ''}${me.orgCode ? ` (${me.orgCode})` : ''}</h1>
        <div class="role-badge">${ROLE_LABELS[me.role] || me.role}${me.adminName ? ' — ' + me.adminName : ''}</div>
      </div>
      ${showLogoUpload ? `
        <label class="btn btn-secondary btn-small org-logo-upload-label">
          העלאת לוגו
          <input type="file" accept="image/png,image/jpeg,image/webp" id="org-logo-upload-input" hidden />
        </label>` : ''}
    </div>
    <nav class="org-nav">
      ${navHtml}
      ${showBackToSystem ? '<a href="dashboard.html" class="org-nav-back">חזרה למסכי ניהול מערכת</a>' : ''}
      <button id="org-header-logout-btn">יציאה</button>
    </nav>
  `;

  document.getElementById('org-header-logout-btn').addEventListener('click', async () => {
    if (me.role === 'system_admin') {
      await confirmSystemLogout();
    } else {
      await fetch('/api/org/logout', { method: 'POST' });
      window.location.href = 'org-login.html';
    }
  });

  if (showLogoUpload) {
    const input = document.getElementById('org-logo-upload-input');
    input.addEventListener('change', () => uploadOrgLogo(input, me.orgId));
  }
}

// Downscales the chosen image client-side (max 200x200, preserving aspect ratio) and stores it
// as a small PNG data: URI - keeps the upload well under the server's size cap without needing
// a separate file-storage service (consistent with this app's other DB-only asset choices).
function uploadOrgLogo(input, orgId) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      const maxSize = 200;
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      try {
        const res = await fetch(`/api/system/organizations/${orgId}/logo`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logoDataUrl: dataUrl })
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'error');
        const logoImg = document.getElementById('org-banner-logo');
        if (logoImg) { logoImg.src = dataUrl; logoImg.classList.remove('hidden'); }
      } catch (err) {
        alert('שגיאה בהעלאת הלוגו: ' + err.message);
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Shows a small modal with a readonly, easily-copyable text field - used for TOTP enrollment
// links, which are too long/awkward to hand over via alert() (not reliably selectable there).
function showLinkModal(title, link) {
  let overlay = document.getElementById('shared-link-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'shared-link-modal-overlay';
    overlay.className = 'modal-overlay-simple';
    overlay.innerHTML = `
      <div class="modal-card-simple">
        <h3 id="shared-link-modal-title"></h3>
        <input type="text" id="shared-link-modal-input" readonly />
        <div class="form-msg success" id="shared-link-modal-msg"></div>
        <div class="form-actions">
          <button class="btn btn-primary" id="shared-link-modal-copy">העתקת הקישור</button>
          <button class="btn btn-secondary" id="shared-link-modal-close">סגירה</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('shared-link-modal-close').addEventListener('click', () => overlay.classList.add('hidden'));
    document.getElementById('shared-link-modal-copy').addEventListener('click', async () => {
      const input = document.getElementById('shared-link-modal-input');
      input.focus();
      input.select();
      const msg = document.getElementById('shared-link-modal-msg');
      try {
        await navigator.clipboard.writeText(input.value);
        msg.textContent = 'הקישור הועתק ללוח';
      } catch (e) {
        const copied = document.execCommand('copy');
        msg.textContent = copied ? 'הקישור הועתק ללוח' : 'לא ניתן להעתיק אוטומטית - הטקסט מסומן, אפשר להעתיק ידנית (Ctrl+C)';
      }
    });
  }
  document.getElementById('shared-link-modal-title').textContent = title;
  document.getElementById('shared-link-modal-input').value = link;
  document.getElementById('shared-link-modal-msg').textContent = '';
  overlay.classList.remove('hidden');
}

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

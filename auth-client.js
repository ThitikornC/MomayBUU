// ==================== MomayBUU Auth Client ====================
// Shared by the main app and /dashboard: attaches the JWT from the auth backend
// to API calls, and asks the user to log in when the server answers 401.
// Uses the same storage keys as dashboard/auth.js so one login works on both pages.
(function () {
  'use strict';

  const AUTH_BASE = 'https://aut-production.up.railway.app';
  const TOKEN_KEY = 'buu_token';
  const USER_KEY  = 'buu_user';

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); }
    catch (e) { return null; }
  }

  function setSession(token, user, remember) {
    try {
      const store = remember ? localStorage : sessionStorage;
      store.setItem(TOKEN_KEY, token);
      store.setItem(USER_KEY, JSON.stringify({ id: user.id, name: user.name, email: user.email }));
    } catch (e) { /* storage blocked */ }
  }

  function clearSession() {
    [TOKEN_KEY, USER_KEY].forEach(k => {
      try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch (e) {}
    });
  }

  // ==================== Login modal ====================
  let modalPromise = null;

  function injectStyles() {
    if (document.getElementById('momayAuthStyles')) return;
    const style = document.createElement('style');
    style.id = 'momayAuthStyles';
    style.textContent = `
      .momay-auth-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center;
        justify-content: center; background: rgba(0,0,0,.55); padding: 16px; font-family: inherit; }
      .momay-auth-card { width: 100%; max-width: 360px; background: #fff; color: #222; border-radius: 14px;
        padding: 22px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
      .momay-auth-card h2 { margin: 0 0 4px; font-size: 20px; }
      .momay-auth-card p { margin: 0 0 14px; font-size: 14px; color: #555; }
      .momay-auth-card label { display: block; font-size: 13px; margin: 10px 0 4px; }
      .momay-auth-card input[type=email], .momay-auth-card input[type=password] { width: 100%; box-sizing: border-box;
        padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; }
      .momay-auth-remember { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-top: 10px; }
      .momay-auth-error { color: #c62828; font-size: 13px; min-height: 18px; margin-top: 8px; }
      .momay-auth-actions { display: flex; gap: 8px; margin-top: 12px; }
      .momay-auth-actions button { flex: 1; padding: 10px; border-radius: 8px; border: 0; font-size: 15px; cursor: pointer; }
      .momay-auth-submit { background: #FBBF32; color: #222; font-weight: 600; }
      .momay-auth-cancel { background: #eee; color: #333; }
      .momay-auth-links { margin-top: 12px; font-size: 13px; text-align: center; }
      .momay-auth-links a { color: #1565c0; }
    `;
    document.head.appendChild(style);
  }

  function showLoginModal(message) {
    if (modalPromise) return modalPromise;
    injectStyles();

    modalPromise = new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'momay-auth-backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.innerHTML = `
        <form class="momay-auth-card" novalidate>
          <h2>เข้าสู่ระบบ</h2>
          <p></p>
          <label for="momayAuthEmail">อีเมล</label>
          <input type="email" id="momayAuthEmail" autocomplete="username" required>
          <label for="momayAuthPw">รหัสผ่าน</label>
          <input type="password" id="momayAuthPw" autocomplete="current-password" required>
          <label class="momay-auth-remember"><input type="checkbox" id="momayAuthRemember"> จดจำฉันไว้</label>
          <div class="momay-auth-error" aria-live="polite"></div>
          <div class="momay-auth-actions">
            <button type="button" class="momay-auth-cancel">ยกเลิก</button>
            <button type="submit" class="momay-auth-submit">เข้าสู่ระบบ</button>
          </div>
          <div class="momay-auth-links">ยังไม่มีบัญชี? <a href="/dashboard/" target="_blank" rel="noopener">สมัครสมาชิก</a></div>
        </form>`;
      backdrop.querySelector('p').textContent = message || 'กรุณาเข้าสู่ระบบเพื่อดำเนินการต่อ';
      document.body.appendChild(backdrop);

      const form     = backdrop.querySelector('form');
      const emailEl  = backdrop.querySelector('#momayAuthEmail');
      const pwEl     = backdrop.querySelector('#momayAuthPw');
      const errEl    = backdrop.querySelector('.momay-auth-error');
      const submitEl = backdrop.querySelector('.momay-auth-submit');

      function close(ok) {
        backdrop.remove();
        modalPromise = null;
        resolve(ok);
      }

      backdrop.querySelector('.momay-auth-cancel').addEventListener('click', () => close(false));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = emailEl.value.trim().toLowerCase();
        const password = pwEl.value;
        if (!email || !password) { errEl.textContent = 'กรุณากรอกอีเมลและรหัสผ่าน'; return; }

        submitEl.disabled = true;
        errEl.textContent = '';
        try {
          const res = await fetch(AUTH_BASE + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          const data = await res.json();
          if (data.token && data.user) {
            setSession(data.token, data.user, backdrop.querySelector('#momayAuthRemember').checked);
            close(true);
            return;
          }
          if (data.requiresVerification) {
            errEl.textContent = 'บัญชียังไม่ได้ยืนยันอีเมล กรุณายืนยันที่หน้าแดชบอร์ด';
          } else {
            errEl.textContent = data.message || 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
          }
        } catch (err) {
          errEl.textContent = 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง';
        }
        submitEl.disabled = false;
      });

      emailEl.focus();
    });
    return modalPromise;
  }

  // ==================== fetch wrapper ====================
  // Like fetch(), but sends the JWT and, on 401, shows the login modal and retries once.
  // If the user cancels the login, the original 401 response is returned.
  async function authFetch(url, options) {
    const send = () => {
      const opts = Object.assign({}, options);
      const headers = new Headers(opts.headers || {});
      const token = getToken();
      if (token) headers.set('Authorization', 'Bearer ' + token);
      opts.headers = headers;
      return fetch(url, opts);
    };

    const res = await send();
    if (res.status !== 401) return res;

    clearSession();
    const loggedIn = await showLoginModal();
    return loggedIn ? send() : res;
  }

  window.MomayAuth = { getToken, authFetch, login: showLoginModal, logout: clearSession };
})();

// ==================== MomayBUU Auth — JWT Backend ====================
// รหัสผ่านจัดการโดย backend (bcrypt cost=12) — ไม่เก็บอะไรใน browser นอกจาก JWT token
(function () {
  'use strict';

  // ==================== Config ====================
  // เปลี่ยนเป็น URL ของ auth-backend ที่ deploy บน Railway
  const AUTH_BASE   = 'https://aut-production.up.railway.app';
  const TOKEN_KEY   = 'buu_token';
  const USER_KEY    = 'buu_user';
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MS   = 30 * 1000;

  let failedAttempts  = 0;
  let lockoutUntil    = 0;
  let pendingEmail    = '';
  let pendingRemember = false;
  let resendTimer     = null;

  // ==================== Token Storage ====================
  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  }

  function setToken(token, remember) {
    if (remember) localStorage.setItem(TOKEN_KEY, token);
    else          sessionStorage.setItem(TOKEN_KEY, token);
  }

  function setUser(user) {
    const safe = JSON.stringify({ id: user.id, name: user.name, email: user.email });
    sessionStorage.setItem(USER_KEY, safe);
    if (localStorage.getItem(TOKEN_KEY)) localStorage.setItem(USER_KEY, safe);
  }

  function clearAuth() {
    [TOKEN_KEY, USER_KEY].forEach(k => {
      sessionStorage.removeItem(k);
      localStorage.removeItem(k);
    });
  }

  // ==================== JWT expiry check (client-side only for UX) ====================
  function isTokenExpired(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      return !payload.exp || payload.exp * 1000 < Date.now();
    } catch { return true; }
  }

  // ==================== Input Validation ====================
// ==================== Input Validation ====================
function validateEmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email.trim());
}

function validatePassword(pw) {
  const errs = [];
  if (pw.length < 8)     errs.push('ต้องมีอย่างน้อย 8 ตัวอักษร');
  if (!/[A-Z]/.test(pw)) errs.push('ต้องมีตัวพิมพ์ใหญ่ (A–Z)');
  if (!/[a-z]/.test(pw)) errs.push('ต้องมีตัวพิมพ์เล็ก (a–z)');
  if (!/[0-9]/.test(pw)) errs.push('ต้องมีตัวเลข (0–9)');
  return errs;
}

function pwStrength(pw) {
  let s = 0;
  if (pw.length >= 8)          s++;
  if (pw.length >= 12)         s++;
  if (/[A-Z]/.test(pw))        s++;
  if (/[a-z]/.test(pw))        s++;
  if (/[0-9]/.test(pw))        s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (s <= 2) return { pct: 25,  label: 'อ่อนแอ',   color: '#e53935' };
  if (s <= 3) return { pct: 50,  label: 'พอใช้',     color: '#f57c00' };
  if (s <= 4) return { pct: 75,  label: 'ดี',         color: '#388e3c' };
  return           { pct: 100, label: 'แข็งแกร่ง', color: '#1565c0' };
}

// ==================== API Calls ====================
async function apiPost(path, body) {
  const res = await fetch(AUTH_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function apiVerify(token) {
  const res = await fetch(AUTH_BASE + '/api/auth/me', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('unauthorized');
  return res.json();
}

// ==================== UI Helpers ====================
function showDashboard(user) {
  const overlay = document.getElementById('authOverlay');
  const page    = document.querySelector('.dash-page');
  if (overlay) overlay.style.display = 'none';
  if (page)    page.style.display    = 'block';
  const nameEl = document.getElementById('authUserName');
  if (nameEl) nameEl.textContent = user.name || user.email;
  const widget = document.getElementById('authUserWidget');
  if (widget) widget.style.display = 'flex';
}

function showAuth() {
  const overlay = document.getElementById('authOverlay');
  const page    = document.querySelector('.dash-page');
  if (overlay) overlay.style.display = 'flex';
  if (page)    page.style.display    = 'none';
  const widget = document.getElementById('authUserWidget');
  if (widget)  widget.style.display  = 'none';
}

function showOtpPanel(email) {
  pendingEmail = email;
  // ซ่อน tabs + panels ทั้งหมด แสดงเฉพาะ OTP panel
  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.style.display = 'none';
  document.querySelectorAll('.auth-panel').forEach(p => {
    p.style.display = 'none';
    p.classList.remove('active');
  });
  const otpPanel = document.getElementById('panel-otp');
  if (otpPanel) otpPanel.style.display = 'block';
  const emailEl = document.getElementById('otpEmailDisplay');
  if (emailEl) emailEl.textContent = email;
  // Reset input
  const codeInput = document.getElementById('otpCode');
  if (codeInput) { codeInput.value = ''; codeInput.focus(); }
  setBanner('otpBanner', '');
  // Start resend countdown
  startResendCountdown();
}

function hideOtpPanel() {
  if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.style.display = '';
  const otpPanel = document.getElementById('panel-otp');
  if (otpPanel) otpPanel.style.display = 'none';
  // แสดง login panel
  document.querySelectorAll('.auth-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === 'login'));
  document.querySelectorAll('.auth-panel').forEach(p =>
    p.classList.toggle('active', p.id === 'panel-login'));
}

function startResendCountdown() {
  if (resendTimer) clearInterval(resendTimer);
  const btn = document.getElementById('resendBtn');
  const cdEl = document.getElementById('resendCountdown');
  if (!btn || !cdEl) return;
  btn.disabled = true;
  let secs = 60;
  cdEl.textContent = secs;
  resendTimer = setInterval(() => {
    secs--;
    cdEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(resendTimer);
      resendTimer = null;
      btn.disabled = false;
      btn.textContent = 'ส่งรหัสใหม่';
    }
  }, 1000);
}

function setFieldError(id, msg) {
  const el = document.getElementById(id + 'Err');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function setBanner(id, msg, isSuccess) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
  el.className = 'auth-banner ' + (isSuccess ? 'auth-banner-success' : 'auth-banner-error');
}

function setLoading(btnId, on) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = on;
  if (!btn._orig) btn._orig = btn.textContent;
  btn.textContent = on ? 'กรุณารอ...' : btn._orig;
}

function setupToggle(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn   = document.getElementById(btnId);
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const show  = input.type === 'password';
    input.type  = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
  });
}

// ==================== Tabs ====================
function setupTabs() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const t = tab.dataset.tab;
      document.querySelectorAll('.auth-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === t));
      document.querySelectorAll('.auth-panel').forEach(p =>
        p.classList.toggle('active', p.id === 'panel-' + t));
    });
  });
}

// ==================== Login ====================
function setupLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;
  setupToggle('loginPw', 'loginPwToggle');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setBanner('loginBanner', '');

    if (Date.now() < lockoutUntil) {
      const secs = Math.ceil((lockoutUntil - Date.now()) / 1000);
      setBanner('loginBanner', `พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอ ${secs} วินาที`);
      return;
    }

    const email    = document.getElementById('loginEmail').value.trim();
    const pw       = document.getElementById('loginPw').value;
    const remember = document.getElementById('loginRemember').checked;

    let valid = true;
    if (!validateEmail(email)) { setFieldError('loginEmail', 'รูปแบบอีเมลไม่ถูกต้อง'); valid = false; }
    else setFieldError('loginEmail', '');
    if (!pw) { setFieldError('loginPw', 'กรุณากรอกรหัสผ่าน'); valid = false; }
    else setFieldError('loginPw', '');
    if (!valid) return;

    setLoading('loginBtn', true);
    try {
      const data = await apiPost('/api/auth/login', { email: email.toLowerCase(), password: pw });
      if (data.token && data.user) {
        failedAttempts = 0;
        setToken(data.token, remember);
        setUser(data.user);
        showDashboard(data.user);
      } else if (data.requiresVerification) {
        failedAttempts = 0;
        pendingRemember = remember;
        showOtpPanel(data.email);
      } else {
        failedAttempts++;
        if (failedAttempts >= MAX_ATTEMPTS) { lockoutUntil = Date.now() + LOCKOUT_MS; failedAttempts = 0; }
        setBanner('loginBanner', data.message || 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
      }
    } catch {
      setBanner('loginBanner', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    setLoading('loginBtn', false);
  });
}

// ==================== Register ====================
function setupRegister() {
  const form = document.getElementById('registerForm');
  if (!form) return;
  setupToggle('registerPw', 'registerPwToggle');
  setupToggle('registerPwConfirm', 'registerPwConfirmToggle');

  const pwInput = document.getElementById('registerPw');
  if (pwInput) {
    pwInput.addEventListener('input', () => {
      const s   = pwStrength(pwInput.value);
      const bar = document.getElementById('pwBar');
      const lbl = document.getElementById('pwLabel');
      if (bar) { bar.style.width = s.pct + '%'; bar.style.background = s.color; }
      if (lbl) { lbl.textContent = pwInput.value ? s.label : ''; lbl.style.color = s.color; }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setBanner('registerBanner', '');

    const name  = document.getElementById('registerName').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const pw    = document.getElementById('registerPw').value;
    const pwc   = document.getElementById('registerPwConfirm').value;

    let valid = true;
    if (name.length < 2) { setFieldError('registerName', 'กรุณากรอกชื่อ (อย่างน้อย 2 ตัวอักษร)'); valid = false; }
    else setFieldError('registerName', '');
    if (!validateEmail(email)) { setFieldError('registerEmail', 'รูปแบบอีเมลไม่ถูกต้อง'); valid = false; }
    else setFieldError('registerEmail', '');
    const pwErrs = validatePassword(pw);
    if (pwErrs.length) { setFieldError('registerPw', pwErrs[0]); valid = false; }
    else setFieldError('registerPw', '');
    if (pw !== pwc) { setFieldError('registerPwConfirm', 'รหัสผ่านไม่ตรงกัน'); valid = false; }
    else setFieldError('registerPwConfirm', '');
    if (!valid) return;

    setLoading('registerBtn', true);
    try {
      const data = await apiPost('/api/auth/register', { name, email: email.toLowerCase(), password: pw });
      if (data.requiresVerification) {
        pendingRemember = false;
        showOtpPanel(data.email);
      } else if (data.token && data.user) {
        setToken(data.token, false);
        setUser(data.user);
        showDashboard(data.user);
      } else {
        setBanner('registerBanner', data.message || 'ไม่สามารถสมัครสมาชิกได้');
      }
    } catch {
      setBanner('registerBanner', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    setLoading('registerBtn', false);
  });
}

// ==================== OTP Verify ====================
function setupVerify() {
  const form = document.getElementById('otpForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setBanner('otpBanner', '');
    const code = document.getElementById('otpCode').value.trim();
    if (!/^[0-9]{6}$/.test(code)) {
      setFieldError('otpCode', 'กรุณากรอกตัวเลข 6 หลัก');
      return;
    }
    setFieldError('otpCode', '');
    setLoading('otpBtn', true);
    try {
      const data = await apiPost('/api/auth/verify-email', { email: pendingEmail, code });
      if (data.token && data.user) {
        setToken(data.token, pendingRemember);
        setUser(data.user);
        showDashboard(data.user);
      } else {
        setBanner('otpBanner', data.message || 'รหัสยืนยันไม่ถูกต้อง');
      }
    } catch {
      setBanner('otpBanner', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    setLoading('otpBtn', false);
  });

  const resendBtn = document.getElementById('resendBtn');
  if (resendBtn) {
    resendBtn.addEventListener('click', async () => {
      resendBtn.disabled = true;
      try {
        await apiPost('/api/auth/resend-otp', { email: pendingEmail });
        setBanner('otpBanner', 'ส่งรหัสใหม่แล้ว กรุณาตรวจสอบอีเมล', true);
      } catch {
        setBanner('otpBanner', 'ไม่สามารถส่งรหัสใหม่ได้ กรุณาลองอีกครั้ง');
      }
      startResendCountdown();
    });
  }

  const backBtn = document.getElementById('otpBackBtn');
  if (backBtn) backBtn.addEventListener('click', hideOtpPanel);
}

// ==================== Forgot Password ====================
function showForgotPanel() {
  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.style.display = 'none';
  document.querySelectorAll('.auth-panel').forEach(p => {
    p.style.display = 'none'; p.classList.remove('active');
  });
  const panel = document.getElementById('panel-forgot');
  if (panel) panel.style.display = 'block';
  const input = document.getElementById('forgotEmail');
  if (input) input.focus();
  setBanner('forgotBanner', '');
}

function showResetPanel(email) {
  pendingEmail = email;
  document.querySelectorAll('.auth-panel').forEach(p => {
    p.style.display = 'none'; p.classList.remove('active');
  });
  const panel = document.getElementById('panel-reset');
  if (panel) panel.style.display = 'block';
  const emailEl = document.getElementById('resetEmailDisplay');
  if (emailEl) emailEl.textContent = email;
  const codeInput = document.getElementById('resetCode');
  if (codeInput) { codeInput.value = ''; codeInput.focus(); }
  setBanner('resetBanner', '');
  startResetCountdown();
}

function startResetCountdown() {
  const btn  = document.getElementById('resetResendBtn');
  const cdEl = document.getElementById('resetCountdown');
  if (!btn || !cdEl) return;
  btn.disabled = true;
  let secs = 60;
  cdEl.textContent = secs;
  const t = setInterval(() => {
    secs--;
    cdEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(t);
      btn.disabled = false;
      btn.textContent = 'ส่งรหัสใหม่';
    }
  }, 1000);
}

function setupForgot() {
  const forgotLink = document.getElementById('forgotLink');
  if (forgotLink) forgotLink.addEventListener('click', showForgotPanel);

  const forgotBackBtn = document.getElementById('forgotBackBtn');
  if (forgotBackBtn) forgotBackBtn.addEventListener('click', hideOtpPanel);

  const form = document.getElementById('forgotForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setBanner('forgotBanner', '');
    const email = document.getElementById('forgotEmail').value.trim();
    if (!validateEmail(email)) { setFieldError('forgotEmail', 'รูปแบบอีเมลไม่ถูกต้อง'); return; }
    setFieldError('forgotEmail', '');
    setLoading('forgotBtn', true);
    try {
      await apiPost('/api/auth/forgot-password', { email: email.toLowerCase() });
      showResetPanel(email.toLowerCase());
    } catch {
      setBanner('forgotBanner', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    setLoading('forgotBtn', false);
  });
}

function setupReset() {
  setupToggle('resetPw', 'resetPwToggle');

  const resetBackBtn = document.getElementById('resetBackBtn');
  if (resetBackBtn) resetBackBtn.addEventListener('click', hideOtpPanel);

  const resetResendBtn = document.getElementById('resetResendBtn');
  if (resetResendBtn) {
    resetResendBtn.addEventListener('click', async () => {
      resetResendBtn.disabled = true;
      try {
        await apiPost('/api/auth/forgot-password', { email: pendingEmail });
        setBanner('resetBanner', 'ส่งรหัสใหม่แล้ว กรุณาตรวจสอบอีเมล', true);
      } catch {
        setBanner('resetBanner', 'ไม่สามารถส่งรหัสใหม่ได้');
      }
      startResetCountdown();
    });
  }

  const form = document.getElementById('resetForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setBanner('resetBanner', '');
    const code = document.getElementById('resetCode').value.trim();
    const pw   = document.getElementById('resetPw').value;
    let valid = true;
    if (!/^[0-9]{6}$/.test(code)) { setFieldError('resetCode', 'กรุณากรอกตัวเลข 6 หลัก'); valid = false; }
    else setFieldError('resetCode', '');
    const pwErrs = validatePassword(pw);
    if (pwErrs.length) { setFieldError('resetPw', pwErrs[0]); valid = false; }
    else setFieldError('resetPw', '');
    if (!valid) return;
    setLoading('resetBtn', true);
    try {
      const data = await apiPost('/api/auth/reset-password', { email: pendingEmail, code, password: pw });
      if (data.message && !data.token) {
        // success
        setBanner('resetBanner', 'ตั้งรหัสผ่านใหม่สำเร็จ! กำลังพาไปหน้าเข้าสู่ระบบ...', true);
        setTimeout(() => hideOtpPanel(), 2000);
      } else {
        setBanner('resetBanner', data.message || 'เกิดข้อผิดพลาด');
      }
    } catch {
      setBanner('resetBanner', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    setLoading('resetBtn', false);
  });
}

// ==================== Logout ====================
function setupLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn) return;
  btn.addEventListener('click', () => { clearAuth(); showAuth(); });
}

// ==================== Boot ====================
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupLogin();
  setupRegister();
  setupVerify();
  setupForgot();
  setupReset();
  setupLogout();

  // TEMPORARY: bypass auth — ลบบรรทัดนี้เมื่อต้องการเปิด login คืน
  showDashboard({ name: 'Guest', email: '' }); return;

  const token = getToken();
  if (token && !isTokenExpired(token)) {
    try {
      const data = await apiVerify(token);
      if (data && data.user) { showDashboard(data.user); return; }
    } catch { /* token invalid or server down */ }
  }
  clearAuth();
  showAuth();
});

})();

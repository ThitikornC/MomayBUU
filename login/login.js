// ==================== Momay login / sign-up page ====================
// Log in, sign up (with email verification code) and reset a password against the JWT auth
// backend, then go to ?next= (a path on this site) or the account page.
(function () {
  'use strict';

  const Auth = window.MomayAuth;
  const params = new URLSearchParams(location.search);
  let pendingEmail = '';
  let remember = false;

  const $ = id => document.getElementById(id);

  function nextUrl() {
    const next = params.get('next') || '';
    // only paths on this site, never another origin
    if (next.startsWith('/') && !next.startsWith('//')) return next;
    return Auth.pageUrl('account/');
  }

  async function post(path, body) {
    const res = await fetch(Auth.AUTH_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  function say(id, text, ok) {
    const el = $(id);
    el.textContent = text || '';
    el.classList.toggle('ok', !!ok);
  }

  function busy(form, on) {
    form.querySelectorAll('button').forEach(b => { b.disabled = on; });
  }

  function validEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  }

  function passwordProblem(pw) {
    if (pw.length < 8) return 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร';
    if (!/[A-Z]/.test(pw)) return 'รหัสผ่านต้องมีตัวพิมพ์ใหญ่ (A–Z)';
    if (!/[a-z]/.test(pw)) return 'รหัสผ่านต้องมีตัวพิมพ์เล็ก (a–z)';
    if (!/[0-9]/.test(pw)) return 'รหัสผ่านต้องมีตัวเลข (0–9)';
    return '';
  }

  function show(panel) {
    ['panelMain', 'panelOtp', 'panelForgot', 'panelReset'].forEach(id => $(id).classList.toggle('hidden', id !== panel));
  }

  function showTab(tab) {
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('loginForm').classList.toggle('hidden', tab !== 'login');
    $('registerForm').classList.toggle('hidden', tab !== 'register');
    show('panelMain');
  }

  function done(data) {
    Auth.setSession(data.token, data.user, remember);
    location.href = nextUrl();
  }

  function showOtp(email) {
    pendingEmail = email;
    $('otpEmail').textContent = email;
    $('otpCode').value = '';
    say('otpMsg', '');
    show('panelOtp');
    $('otpCode').focus();
  }

  // ─── Log in ───
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('loginEmail').value.trim().toLowerCase();
    const password = $('loginPw').value;
    if (!validEmail(email) || !password) return say('loginMsg', 'กรุณากรอกอีเมลและรหัสผ่าน');
    remember = $('loginRemember').checked;
    busy(e.target, true);
    say('loginMsg', '');
    try {
      const data = await post('/api/auth/login', { email, password });
      if (data.token && data.user) return done(data);
      if (data.requiresVerification) showOtp(data.email || email);
      else say('loginMsg', data.message || 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    } catch (err) {
      say('loginMsg', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    busy(e.target, false);
  });

  // ─── Sign up ───
  $('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('regName').value.trim();
    const email = $('regEmail').value.trim().toLowerCase();
    const password = $('regPw').value;
    if (name.length < 2) return say('registerMsg', 'กรุณากรอกชื่อ (อย่างน้อย 2 ตัวอักษร)');
    if (!validEmail(email)) return say('registerMsg', 'รูปแบบอีเมลไม่ถูกต้อง');
    const problem = passwordProblem(password);
    if (problem) return say('registerMsg', problem);
    if (password !== $('regPw2').value) return say('registerMsg', 'รหัสผ่านไม่ตรงกัน');
    remember = false;
    busy(e.target, true);
    say('registerMsg', '');
    try {
      const data = await post('/api/auth/register', { name, email, password });
      if (data.token && data.user) return done(data);
      if (data.requiresVerification) showOtp(data.email || email);
      else say('registerMsg', data.message || 'ไม่สามารถสมัครสมาชิกได้');
    } catch (err) {
      say('registerMsg', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    busy(e.target, false);
  });

  // ─── Verify email ───
  $('otpForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('otpCode').value.trim();
    if (!/^[0-9]{6}$/.test(code)) return say('otpMsg', 'กรุณากรอกตัวเลข 6 หลัก');
    busy(e.target, true);
    try {
      const data = await post('/api/auth/verify-email', { email: pendingEmail, code });
      if (data.token && data.user) return done(data);
      say('otpMsg', data.message || 'รหัสยืนยันไม่ถูกต้อง');
    } catch (err) {
      say('otpMsg', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    busy(e.target, false);
  });

  $('otpResend').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await post('/api/auth/resend-otp', { email: pendingEmail });
      say('otpMsg', 'ส่งรหัสใหม่แล้ว กรุณาตรวจสอบอีเมล', true);
    } catch (err) {
      say('otpMsg', 'ไม่สามารถส่งรหัสใหม่ได้ กรุณาลองอีกครั้ง');
    }
    setTimeout(() => { e.target.disabled = false; }, 60000);
  });

  // ─── Forgot / reset password ───
  $('forgotLink').addEventListener('click', () => {
    $('forgotEmail').value = $('loginEmail').value;
    say('forgotMsg', '');
    show('panelForgot');
  });

  $('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('forgotEmail').value.trim().toLowerCase();
    if (!validEmail(email)) return say('forgotMsg', 'รูปแบบอีเมลไม่ถูกต้อง');
    busy(e.target, true);
    try {
      await post('/api/auth/forgot-password', { email });
      pendingEmail = email;
      $('resetEmail').textContent = email;
      say('resetMsg', '');
      show('panelReset');
    } catch (err) {
      say('forgotMsg', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    busy(e.target, false);
  });

  $('resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('resetCode').value.trim();
    const password = $('resetPw').value;
    if (!/^[0-9]{6}$/.test(code)) return say('resetMsg', 'กรุณากรอกตัวเลข 6 หลัก');
    const problem = passwordProblem(password);
    if (problem) return say('resetMsg', problem);
    busy(e.target, true);
    try {
      const data = await post('/api/auth/reset-password', { email: pendingEmail, code, password });
      // same success check as dashboard/auth.js: the backend answers with a message and no token
      if (data.message && !data.token) {
        say('resetMsg', 'ตั้งรหัสผ่านใหม่แล้ว กรุณาเข้าสู่ระบบ', true);
        setTimeout(() => { $('loginEmail').value = pendingEmail; showTab('login'); }, 1500);
      } else {
        say('resetMsg', data.message || 'รหัสไม่ถูกต้อง');
      }
    } catch (err) {
      say('resetMsg', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้ง');
    }
    busy(e.target, false);
  });

  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => showTab('login')));

  // Organization name and logo on top
  if (window.MomayOrg) {
    window.MomayOrg.load().then(config => {
      if (!config) return;
      const b = config.org.branding || {};
      $('orgName').textContent = b.displayName || config.org.name;
      if (b.logoUrl) $('orgLogo').src = b.logoUrl;
    });
  }

  $('backToApp').href = Auth.orgBase();
  showTab(params.get('mode') === 'register' ? 'register' : 'login');
})();

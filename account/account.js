// ==================== Momay account & organization page ====================
// My organizations, create an organization, and (for admins/owners of the organization this
// page is opened under, e.g. /o/<slug>/account/) members, invites, rooms, meters and settings.
(function () {
  'use strict';

  const Auth = window.MomayAuth;
  const $ = id => document.getElementById(id);
  const ROLE_NAMES = { user: 'ผู้ใช้', admin: 'ผู้ดูแล', owner: 'เจ้าของ' };
  let me = null;      // GET /api/org/me data
  let meters = [];

  function say(id, text, ok) {
    const el = $(id);
    el.textContent = text || '';
    el.classList.toggle('ok', !!ok);
  }

  async function api(path, options) {
    const opts = Object.assign({}, options);
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    }
    const res = await Auth.authFetch(path, opts);
    const json = await res.json().catch(() => ({ success: false, error: 'ไม่สามารถอ่านคำตอบจากเซิร์ฟเวอร์ได้' }));
    if (res.status === 401) throw new Error('AUTH');
    return json;
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    (children || []).forEach(c => node.append(c));
    return node;
  }

  function button(text, className, onClick) {
    const b = el('button', { type: 'button', className: className || 'secondary shrink', textContent: text });
    b.addEventListener('click', onClick);
    return b;
  }

  // ─── My organizations ───
  async function loadMyOrgs() {
    const json = await api('/api/me/orgs');
    const list = $('myOrgs');
    list.innerHTML = '';
    const orgs = json.success ? json.data : [];
    $('noOrgs').classList.toggle('hidden', orgs.length > 0);
    orgs.forEach(o => {
      const actions = [el('a', { className: 'btn shrink', href: '/o/' + o.slug + '/', textContent: 'เปิดแอป' })];
      if (o.role === 'admin' || o.role === 'owner') {
        actions.push(el('a', { className: 'btn secondary shrink', href: '/o/' + o.slug + '/account/', textContent: 'จัดการ' }));
      }
      list.append(el('li', {}, [
        el('div', { className: 'grow' }, [
          el('div', { textContent: o.name }),
          el('div', { className: 'sub', textContent: '/o/' + o.slug + '/' })
        ]),
        el('span', { className: 'pill', textContent: ROLE_NAMES[o.role] || o.role }),
        ...actions
      ]));
    });
  }

  $('createOrgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('newOrgName').value.trim();
    if (name.length < 2) return say('createOrgMsg', 'กรุณากรอกชื่อองค์กร');
    const json = await api('/api/orgs', { method: 'POST', body: { name, slug: $('newOrgSlug').value.trim() } });
    if (!json.success) return say('createOrgMsg', json.error);
    location.href = '/o/' + json.data.slug + '/account/';
  });

  // ─── Members ───
  async function loadMembers() {
    const json = await api('/api/org/members');
    const list = $('memberList');
    list.innerHTML = '';
    if (!json.success) return say('memberMsg', json.error);
    const isOwner = me.role === 'owner';
    json.data.forEach(m => {
      const isSelf = m.userId === me.user.id;
      const canEdit = isOwner || (m.role === 'user' && !isSelf);
      const role = el('select', { disabled: !canEdit });
      ['user', 'admin', 'owner'].forEach(r => {
        if (!isOwner && r !== 'user' && r !== m.role) return;
        role.append(el('option', { value: r, textContent: ROLE_NAMES[r], selected: r === m.role }));
      });
      role.addEventListener('change', async () => {
        const r = await api('/api/org/members/' + m.id, { method: 'PATCH', body: { role: role.value } });
        say('memberMsg', r.success ? 'เปลี่ยนบทบาทแล้ว' : r.error, r.success);
        loadMembers();
      });
      const remove = button(isSelf ? 'ออกจากองค์กร' : 'นำออก', 'danger shrink', async () => {
        if (!confirm(isSelf ? 'ออกจากองค์กรนี้?' : `นำ ${m.email} ออกจากองค์กร?`)) return;
        const r = await api('/api/org/members/' + m.id, { method: 'DELETE' });
        if (r.success && isSelf) { location.href = '/account/'; return; }
        say('memberMsg', r.success ? 'นำออกแล้ว' : r.error, r.success);
        loadMembers();
      });
      list.append(el('li', {}, [
        el('div', { className: 'grow' }, [
          el('div', { textContent: m.name || m.email }),
          el('div', { className: 'sub', textContent: m.email + (m.pending ? ' · ยังไม่เคยเข้าสู่ระบบ' : '') })
        ]),
        el('div', { className: 'shrink' }, [role]),
        (canEdit || isSelf) ? remove : ''
      ]));
    });
  }

  // ─── Invites ───
  async function loadInvites() {
    const json = await api('/api/org/invites');
    const list = $('inviteList');
    list.innerHTML = '';
    if (!json.success) return;
    json.data.forEach(i => {
      list.append(el('li', {}, [
        el('div', { className: 'grow' }, [
          el('div', { textContent: i.email }),
          el('div', { className: 'sub', textContent: 'รอตอบรับ · หมดอายุ ' + new Date(i.expiresAt).toLocaleDateString('th-TH') })
        ]),
        el('span', { className: 'pill', textContent: ROLE_NAMES[i.role] }),
        button('ยกเลิก', 'danger shrink', async () => {
          await api('/api/org/invites/' + i.id, { method: 'DELETE' });
          loadInvites();
        })
      ]));
    });
  }

  $('inviteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('inviteEmail').value.trim();
    const json = await api('/api/org/invites', { method: 'POST', body: { email, role: $('inviteRole').value } });
    if (!json.success) return say('inviteMsg', json.error);
    $('inviteLink').value = json.data.inviteUrl;
    $('inviteLinkBox').classList.remove('hidden');
    $('inviteEmail').value = '';
    say('inviteMsg', 'สร้างลิงก์แล้ว ลิงก์นี้แสดงครั้งเดียว คัดลอกไปส่งให้ ' + email, true);
    loadInvites();
  });

  $('copyInvite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('inviteLink').value);
      say('inviteMsg', 'คัดลอกแล้ว', true);
    } catch (err) {
      $('inviteLink').select();
    }
  });

  // ─── Rooms and meters ───
  async function loadRoomsAndMeters() {
    const [roomJson, meterJson, orgJson] = await Promise.all([
      api('/api/org/rooms'), api('/api/org/meters'), fetch('/api/org/config').then(r => r.json())
    ]);
    if (!roomJson.success || !meterJson.success) return;
    meters = meterJson.data;
    const primaryMeterId = orgJson.success && orgJson.data.primaryMeter ? orgJson.data.primaryMeter.id : null;
    const meterName = id => { const m = meters.find(x => x._id === id); return m ? (m.name || m.key) : ''; };

    const rooms = $('roomList');
    rooms.innerHTML = '';
    roomJson.data.forEach(r => {
      rooms.append(el('li', {}, [
        el('div', { className: 'grow' }, [
          el('div', { textContent: r.displayName || r.key }),
          el('div', { className: 'sub', textContent: `รหัส ${r.key}` + (r.floor ? ` · ชั้น ${r.floor}` : '') + (r.meterId ? ` · ${meterName(r.meterId)}` : '') })
        ]),
        button('ลบ', 'danger shrink', async () => {
          if (!confirm(`ลบห้อง ${r.displayName || r.key}? การจองเดิมยังอยู่ แต่จะจองห้องนี้ใหม่ไม่ได้`)) return;
          const d = await api('/api/org/rooms/' + r._id, { method: 'DELETE' });
          say('roomMsg', d.success ? 'ลบแล้ว' : d.error, d.success);
          loadRoomsAndMeters();
        })
      ]));
    });

    const meterList = $('meterList');
    meterList.innerHTML = '';
    const select = $('roomMeter');
    select.innerHTML = '';
    select.append(el('option', { value: '', textContent: 'ใช้มิเตอร์หลัก' }));
    meters.forEach(m => {
      select.append(el('option', { value: m._id, textContent: m.name || m.key }));
      meterList.append(el('li', {}, [
        el('div', { className: 'grow' }, [
          el('div', { textContent: (m.name || m.key) + (primaryMeterId === m._id ? ' (หลัก)' : '') }),
          el('div', { className: 'sub', textContent: `${m.deviceId} · ${m.energyApiUrl}` })
        ]),
        button('ลบ', 'danger shrink', async () => {
          if (!confirm(`ลบมิเตอร์ ${m.name || m.key}?`)) return;
          const d = await api('/api/org/meters/' + m._id, { method: 'DELETE' });
          say('meterMsg', d.success ? 'ลบแล้ว' : d.error, d.success);
          loadRoomsAndMeters();
        })
      ]));
    });
  }

  $('roomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('roomKey').value.trim();
    if (!key) return say('roomMsg', 'กรุณากรอกรหัสห้อง');
    const body = { key, displayName: $('roomName').value.trim() || key, floor: $('roomFloor').value.trim(), meterId: $('roomMeter').value || null, order: $('roomList').children.length };
    const json = await api('/api/org/rooms', { method: 'POST', body });
    if (!json.success) return say('roomMsg', json.error);
    e.target.reset();
    say('roomMsg', 'เพิ่มห้องแล้ว', true);
    loadRoomsAndMeters();
  });

  $('meterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      key: $('meterKey').value.trim(),
      name: $('meterName').value.trim(),
      deviceId: $('meterDevice').value.trim(),
      energyApiUrl: $('meterUrl').value.trim()
    };
    const json = await api('/api/org/meters', { method: 'POST', body });
    if (!json.success) return say('meterMsg', json.error);
    e.target.reset();
    say('meterMsg', 'เพิ่มมิเตอร์แล้ว', true);
    loadRoomsAndMeters();
  });

  // ─── Settings (owner) ───
  function fillSettings() {
    const s = me.settings;
    $('setName').value = me.org.name;
    $('setJoin').value = s.joinPolicy;
    $('setDomains').value = s.allowedDomains.join(', ');
    $('setEnergy').value = s.services.energyApiUrl || '';
    $('setControl').value = s.services.controlUrl || '';
  }

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('setName').value.trim(),
      joinPolicy: $('setJoin').value,
      allowedDomains: $('setDomains').value.split(',').map(d => d.trim()).filter(Boolean),
      services: { energyApiUrl: $('setEnergy').value.trim(), controlUrl: $('setControl').value.trim() }
    };
    const json = await api('/api/org', { method: 'PATCH', body });
    say('settingsMsg', json.success ? 'บันทึกแล้ว' : json.error, json.success);
  });

  // ─── Branding and CCTV (owner) ───
  function fillBranding() {
    const config = window.MomayOrg.config;
    const b = (config && config.org.branding) || {};
    $('brandName').value = b.displayName || me.org.name;
    $('brandColor').value = b.primaryColor || '#8b4513';
    if (b.logoUrl) $('logoPreview').src = b.logoUrl;
    $('cctvRole').value = me.settings.cctvViewRole;
    $('cctvKeyState').textContent = me.settings.hasCctvKey ? 'มีรหัส relay แล้ว' : 'ยังไม่มีรหัส relay';
  }

  $('brandingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const json = await api('/api/org/branding', { method: 'PATCH', body: { displayName: $('brandName').value.trim(), primaryColor: $('brandColor').value } });
    say('brandingMsg', json.success ? 'บันทึกแล้ว' : json.error, json.success);
    if (json.success) document.documentElement.style.setProperty('--brand', $('brandColor').value);
  });

  $('logoFile').addEventListener('change', async () => {
    const file = $('logoFile').files[0];
    if (!file) return;
    if (file.size > 500 * 1024) return say('logoMsg', 'โลโก้ต้องไม่เกิน 500 KB');
    const res = await Auth.authFetch('/api/org/logo', { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    const json = await res.json().catch(() => ({}));
    if (!json.success) return say('logoMsg', json.error || 'อัปโหลดไม่สำเร็จ');
    $('logoPreview').src = json.data.logoUrl;
    $('orgLogo').src = json.data.logoUrl;
    say('logoMsg', 'อัปโหลดโลโก้แล้ว', true);
  });

  $('cctvRole').addEventListener('change', async () => {
    const json = await api('/api/org', { method: 'PATCH', body: { cctvViewRole: $('cctvRole').value } });
    say('cctvMsg', json.success ? 'บันทึกแล้ว' : json.error, json.success);
  });

  $('cctvKeyBtn').addEventListener('click', async () => {
    if (me.settings.hasCctvKey && !confirm('สร้างรหัสใหม่? relay ที่ใช้รหัสเดิมจะเชื่อมต่อไม่ได้')) return;
    const json = await api('/api/org/cctv-key', { method: 'POST' });
    if (!json.success) return say('cctvMsg', json.error);
    me.settings.hasCctvKey = true;
    $('cctvKey').value = json.data.relayKey;
    $('cctvKeyBox').classList.remove('hidden');
    $('cctvKeyState').textContent = 'มีรหัส relay แล้ว';
    say('cctvMsg', 'รหัสนี้แสดงครั้งเดียว คัดลอกไปใส่ RELAY_KEY ใน .env ของ relay.py', true);
  });

  // ─── Boot ───
  async function boot() {
    const user = Auth.getUser();
    $('userEmail').textContent = user ? user.email : '';
    $('logoutBtn').addEventListener('click', () => { Auth.logout(); location.href = Auth.pageUrl('login/'); });

    await Promise.all([loadMyOrgs(), window.MomayOrg.load()]);

    const meJson = await api('/api/org/me');
    if (!meJson.success) return;
    me = meJson.data;
    document.querySelectorAll('[data-org-name]').forEach(n => { n.textContent = me.org.name; });
    $('orgName').textContent = me.org.name;
    if (me.org.logoUrl) $('orgLogo').src = me.org.logoUrl;

    if (me.canJoin) {
      $('joinText').textContent = `คุณเข้าร่วม ${me.org.name} ได้ `;
      $('joinHint').classList.remove('hidden');
      $('joinBtn').addEventListener('click', async () => {
        const j = await api('/api/org/join', { method: 'POST' });
        if (j.success) location.reload();
      });
    }

    if (me.role === 'admin' || me.role === 'owner') {
      $('manage').classList.remove('hidden');
      if (me.role !== 'owner') document.querySelectorAll('[data-owner-only]').forEach(o => o.remove());
      await Promise.all([loadMembers(), loadInvites(), loadRoomsAndMeters()]);
    }
    if (me.role === 'owner' && me.settings) {
      ['settingsCard', 'brandingCard', 'cctvCard'].forEach(id => $(id).classList.remove('hidden'));
      fillSettings();
      fillBranding();
    }
  }

  if (!Auth.getToken()) {
    location.href = Auth.pageUrl('login/') + '?next=' + encodeURIComponent(location.pathname);
    return;
  }
  boot().catch(err => {
    if (err.message === 'AUTH') location.href = Auth.pageUrl('login/') + '?next=' + encodeURIComponent(location.pathname);
    else console.error(err);
  });
})();

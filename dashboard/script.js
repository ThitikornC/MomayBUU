// ==================== MomayBUU Dashboard ====================
document.addEventListener('DOMContentLoaded', () => {

  // ==================== Config ====================
  const API_BASE = window.location.origin;
  const ROOM_ENERGY = {
    'ห้อง101โถงชั้น1': { api: 'https://momatdeerbn-production.up.railway.app', device: 'pm_deer', displayName: 'ห้อง 101' },
    'ห้อง200':          { api: 'https://momaysandbn-production.up.railway.app', device: 'pm_sand', displayName: 'ห้อง 200' },
    'ห้อง300':          { api: 'https://momaysandbn-production.up.railway.app', device: 'pm_sand', displayName: 'ห้อง 300' }
  };
  const ENERGY_RATE_THB_PER_KWH = 4.4;
  const DEFAULT_GRAPH_DAYS_WINDOW = 7;
  const ROOMS = Object.keys(ROOM_ENERGY);

  const BUILDING_STRUCTURE = {
    'หอสมุด': {
      '1': ['ห้อง101โถงชั้น1'],
      '2': ['ห้อง200'],
      '3': ['ห้อง300']
    }
  };

  function getEnergyAPI(room) {
    return ROOM_ENERGY[room] || ROOM_ENERGY['ห้อง101โถงชั้น1'];
  }

  // ==================== State ====================
  let currentSection = 'overview';
  let chartInstances = {};
  let calendarInstance = null;
  let energyCalendarInstance = null;
  let realtimeInterval = null;

  // ==================== Cache System (TTL-based) ====================
  const CACHE_TTL = 15000; // 15 seconds for today's data
  const CACHE_TTL_OLD = 600000; // 10 minutes for historical data
  const apiCache = {};
  function cacheGet(key) {
    const entry = apiCache[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > entry.ttl) { delete apiCache[key]; return null; }
    return entry.data;
  }
  function cacheSet(key, data, ttl) {
    apiCache[key] = { data, ts: Date.now(), ttl: ttl || CACHE_TTL };
  }
  function cacheClear(prefix) {
    Object.keys(apiCache).forEach(k => { if (!prefix || k.startsWith(prefix)) delete apiCache[k]; });
  }

  // ==================== Navigation ====================
  const navItems = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.section');
  const pageTitle = document.getElementById('pageTitle');
  const menuToggle = document.getElementById('menuToggle');
  const sidebar = document.querySelector('.sidebar');

  const sectionTitles = {
    overview: 'ค่าไฟฟ้าต่อคน'
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const section = item.dataset.section;
      switchSection(section);
      if (window.innerWidth <= 768) sidebar.classList.remove('open');
    });
  });

  if (menuToggle && sidebar) menuToggle.addEventListener('click', () => sidebar.classList.toggle('open'));

  function switchSection(section) {
    currentSection = section;
    navItems.forEach(n => n.classList.toggle('active', n.dataset.section === section));
    sections.forEach(s => s.classList.toggle('active', s.id === 'section-' + section));
    if (pageTitle) pageTitle.textContent = sectionTitles[section] || section;
    loadSectionData(section);
  }

  // ==================== Helpers ====================
  function todayStr() {
    const now = new Date();
    const bkk = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    return bkk.getFullYear() + '-' + String(bkk.getMonth() + 1).padStart(2, '0') + '-' + String(bkk.getDate()).padStart(2, '0');
  }

  function formatTime(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  }

  function timeAgo(isoStr) {
    if (!isoStr) return '';
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'เมื่อสักครู่';
    if (mins < 60) return mins + ' นาทีที่แล้ว';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' ชม. ที่แล้ว';
    return Math.floor(hrs / 24) + ' วันที่แล้ว';
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    return res.json();
  }

  function destroyChart(key) {
    if (chartInstances[key]) { chartInstances[key].destroy(); delete chartInstances[key]; }
  }

  function showLoading(el) { if (el) el.classList.add('active'); }
  function hideLoading(el) { if (el) el.classList.remove('active'); }

  function shiftDate(input, days, onchange) {
    if (!input) return;
    const d = new Date(input.value);
    d.setDate(d.getDate() + days);
    input.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    onchange();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ==================== Populate Room Dropdowns ====================
  function populateEnergyRooms() {
    const sel = document.getElementById('overviewEnergyScope');
    if (!sel) return;
    ROOMS.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = ROOM_ENERGY[r].displayName || r;
      sel.appendChild(opt);
    });
  }

  function populateBuildingFilters() {
    const bSel = document.getElementById('bookingBuilding');
    const fSel = document.getElementById('bookingFloor');
    const rSel = document.getElementById('overviewBookingRoom');
    if (!bSel) return;

    Object.keys(BUILDING_STRUCTURE).forEach(b => {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      bSel.appendChild(opt);
    });

    bSel.addEventListener('change', () => {
      fSel.innerHTML = '<option value="">ชื่อชั้นเลือกได้</option>';
      rSel.innerHTML = '<option value="">ชื่อห้องเลือกได้</option>';
      const building = bSel.value;
      if (!building || !BUILDING_STRUCTURE[building]) return;
      Object.keys(BUILDING_STRUCTURE[building]).forEach(floor => {
        const opt = document.createElement('option');
        opt.value = floor;
        opt.textContent = 'ชั้น ' + floor;
        fSel.appendChild(opt);
      });
    });

    fSel.addEventListener('change', () => {
      rSel.innerHTML = '<option value="">ชื่อห้องเลือกได้</option>';
      const building = bSel.value;
      const floor = fSel.value;
      if (!building || !floor || !BUILDING_STRUCTURE[building] || !BUILDING_STRUCTURE[building][floor]) return;
      BUILDING_STRUCTURE[building][floor].forEach(room => {
        const opt = document.createElement('option');
        opt.value = room;
        opt.textContent = ROOM_ENERGY[room] ? ROOM_ENERGY[room].displayName : room;
        rSel.appendChild(opt);
      });
    });

    rSel.addEventListener('change', loadBookingMode);
  }

  populateEnergyRooms();
  populateBuildingFilters();

  // ==================== Mode Tabs ====================
  const modeTabs = document.querySelectorAll('.mode-tab');
  const modePanels = document.querySelectorAll('.mode-panel');

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
      modePanels.forEach(p => p.classList.toggle('active', p.id === 'mode-' + mode));
      if (mode === 'energy') loadEnergyMode();
      if (mode === 'booking') loadBookingMode();
    });
  });

  // ==================== Date & Filter Setup ====================
  const today = todayStr();
  const energyLoading = document.getElementById('energyLoading');
  const bookingLoading = document.getElementById('bookingLoading');

  const graphDayRange = document.getElementById('graphDayRange');
  const graphEndDateLabel = document.getElementById('graphEndDateLabel');
  let currentGraphDaysWindow = DEFAULT_GRAPH_DAYS_WINDOW;
  let currentGraphEndDate = today;

  const overviewEnergyDate = document.getElementById('overviewEnergyDate');
  const overviewEnergyScope = document.getElementById('overviewEnergyScope');
  const overviewBookingDate = document.getElementById('overviewBookingDate');
  const overviewBookingRoom = document.getElementById('overviewBookingRoom');

  if (overviewEnergyDate) { overviewEnergyDate.value = today; overviewEnergyDate.addEventListener('change', loadEnergyMode); }
  if (overviewEnergyScope) overviewEnergyScope.addEventListener('change', loadEnergyMode);
  if (overviewBookingDate) { overviewBookingDate.value = today; overviewBookingDate.addEventListener('change', loadBookingMode); }

  if (graphDayRange) {
    graphDayRange.value = String(DEFAULT_GRAPH_DAYS_WINDOW);
    graphDayRange.addEventListener('change', () => {
      const days = Number(graphDayRange.value);
      if (!Number.isNaN(days) && days > 0) currentGraphDaysWindow = days;
      loadEnergyMode();
    });
  }

  if (graphEndDateLabel) graphEndDateLabel.textContent = shortDateTH(currentGraphEndDate);

  // Energy date arrows
  const energyDatePrev = document.getElementById('energyDatePrev');
  const energyDateNext = document.getElementById('energyDateNext');
  if (energyDatePrev) energyDatePrev.addEventListener('click', () => shiftDate(overviewEnergyDate, -1, loadEnergyMode));
  if (energyDateNext) energyDateNext.addEventListener('click', () => shiftDate(overviewEnergyDate, 1, loadEnergyMode));

  // Booking date arrows
  const bookingDatePrev = document.getElementById('bookingDatePrev');
  const bookingDateNext = document.getElementById('bookingDateNext');
  if (bookingDatePrev) bookingDatePrev.addEventListener('click', () => shiftDate(overviewBookingDate, -1, loadBookingMode));
  if (bookingDateNext) bookingDateNext.addEventListener('click', () => shiftDate(overviewBookingDate, 1, loadBookingMode));

  // ==================== Download Buttons ====================
  const btnDownloadEnergy = document.getElementById('btnDownloadEnergy');
  const btnDownloadBooking = document.getElementById('btnDownloadBooking');

  if (btnDownloadEnergy) btnDownloadEnergy.addEventListener('click', downloadEnergyReport);
  if (btnDownloadBooking) btnDownloadBooking.addEventListener('click', downloadBookingReport);

  function downloadCSV(filename, rows) {
    const bom = '\uFEFF';
    const csv = bom + rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function downloadEnergyReport() {
    const date = overviewEnergyDate ? overviewEnergyDate.value : todayStr();
    const scope = overviewEnergyScope ? overviewEnergyScope.value : 'all';
    const rooms = scope === 'all' ? ROOMS : [scope];
    try {
      let minuteData;
      if (scope === 'all') {
        const allValues = await Promise.all(rooms.map(r => fetchDailyData(date, r)));
        minuteData = mergeMinuteArrays(allValues.map(v => mapTo1440(v)));
      } else {
        minuteData = mapTo1440(await fetchDailyData(date, scope));
      }
      const hourly = computeHourlyBillFromMinutes(minuteData);
      const rows = [['ชั่วโมง', 'kWh', 'ค่าไฟ (฿)']];
      hourly.forEach(h => {
        const kwh = h.bill / 4.4;
        rows.push([String(h.hour).padStart(2, '0') + ':00', kwh.toFixed(2), h.bill.toFixed(2)]);
      });
      downloadCSV('energy_report_' + date + '.csv', rows);
    } catch { alert('ไม่สามารถโหลดข้อมูลรายงานได้'); }
  }

  async function downloadBookingReport() {
    const date = overviewBookingDate ? overviewBookingDate.value : todayStr();
    const room = overviewBookingRoom ? overviewBookingRoom.value : '';
    let url = API_BASE + '/api/bookings?date=' + date;
    if (room) url += '&room=' + encodeURIComponent(room);
    try {
      const res = await fetchJSON(url);
      const bookings = res.data || [];
      const rows = [['Booking ID', 'ห้อง', 'วันที่', 'เวลาเริ่ม', 'เวลาสิ้นสุด', 'ผู้จอง', 'วัตถุประสงค์']];
      bookings.forEach(b => {
        rows.push([b.bookingId, b.room, b.date, b.startTime, b.endTime, b.bookerName, b.purpose || '-']);
      });
      downloadCSV('booking_report_' + date + '.csv', rows);
    } catch { /* skip */ }
  }

  // ==================== Section Loaders ====================
  function loadSectionData(section) {
    switch (section) {
      case 'overview': loadEnergyMode(); break;
    }
  }

  // ============================================================
  // 1. ภาพรวมข้อมูล — Energy Mode
  // ============================================================

  function getMinuteLabels() {
    return Array.from({ length: 1440 }, (_, i) => {
      const h = String(Math.floor(i / 60)).padStart(2, '0');
      const m = String(i % 60).padStart(2, '0');
      return h + ':' + m;
    });
  }

  async function fetchDailyData(dateStr, room) {
    const { api, device } = getEnergyAPI(room);
    const cacheKey = 'daily_' + dateStr + '_' + device;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(api + '/daily-energy/' + device + '?date=' + dateStr, { signal: controller.signal });
      clearTimeout(timeout);
      const json = await res.json();
      const data = json.data || [];
      const isToday = dateStr === todayStr();
      cacheSet(cacheKey, data, isToday ? CACHE_TTL : CACHE_TTL_OLD);
      return data;
    } catch { return []; }
  }

  async function fetchJSONCached(url, ttl) {
    const cached = cacheGet(url);
    if (cached) return cached;
    const data = await fetchJSON(url);
    cacheSet(url, data, ttl || CACHE_TTL);
    return data;
  }

  function mapTo1440(values) {
    const chartData = new Array(1440).fill(null);
    values.forEach(item => {
      if (!item.timestamp) return;
      const t = new Date(item.timestamp);
      const idx = t.getUTCHours() * 60 + t.getUTCMinutes();
      if (idx >= 0 && idx < 1440) {
        chartData[idx] = item.active_power_total || item.power || item.power_active || null;
      }
    });
    return chartData;
  }

  function mergeMinuteArrays(arrays) {
    const merged = new Array(1440).fill(null);
    arrays.forEach(arr => {
      arr.forEach((v, i) => {
        if (v !== null) merged[i] = (merged[i] || 0) + v;
      });
    });
    return merged;
  }

  function computeMaxAvg(chartData) {
    let maxVal = null, maxIdx = null, sum = 0, count = 0;
    chartData.forEach((v, i) => {
      if (v !== null) {
        if (maxVal === null || v > maxVal) { maxVal = v; maxIdx = i; }
        sum += v; count++;
      }
    });
    return { maxVal: maxVal, maxIdx: maxIdx, avgVal: count > 0 ? sum / count : null };
  }

  function dateShift(dateStr, deltaDays) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + deltaDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function shortDateTH(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return d + '/' + m + '/' + y;
  }

  function parseRealUserCount(bookings) {
    if (!bookings.length) return 0;

    const uniqueNames = new Set();
    let participantSum = 0;
    bookings.forEach(b => {
      const name = (b.bookerName || '').trim();
      if (name) uniqueNames.add(name);

      const rawParticipant = b.participantCount || b.userCount || b.attendees || b.people || b.memberCount;
      const n = Number(rawParticipant);
      if (!Number.isNaN(n) && n > 0) participantSum += n;
    });

    if (participantSum > 0) return participantSum;
    if (uniqueNames.size > 0) return uniqueNames.size;
    return bookings.length;
  }

  // ==================== Sidebar Functions ====================
  async function getBookingsForDate(dateStr, room) {
    // Try local API first, fallback to default
    try {
      const url = API_BASE + '/api/bookings?date=' + dateStr + '&room=' + encodeURIComponent(room);
      const res = await fetchJSON(url);
      return res.data || [];
    } catch {
      // If local API fails, return empty (no users info available)
      return [];
    }
  }

  async function estimateUserCount(dateStr, room) {
    try {
      const bookings = await getBookingsForDate(dateStr, room);
      const count = parseRealUserCount(bookings);
      return count > 0 ? count : 2; // Default 2 users if no bookings
    } catch {
      return 2; // Default fallback
    }
  }

  async function getCostPerUserByRoom(dateStr, room) {
    try {
      const bill = await fetchRoomBill(dateStr, room);
      const userCount = await estimateUserCount(dateStr, room);
      return userCount > 0 ? bill / userCount : 0;
    } catch {
      return 0;
    }
  }

  async function updateSidebar(dateStr) {
    const container = document.getElementById('sidebarContent');
    if (!container) return;

    container.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-secondary); font-size: 0.85rem;">กำลังโหลด...</div>';

    try {
      // Get the last 7 days to find data with actual bills
      const dates = buildLastNDays(dateStr, 7);
      let dataFound = false;
      
      const cards = await Promise.all(ROOMS.map(async (room) => {
        // Find first date with non-zero bill
        let costPerUser = 0;
        let userCount = 2;
        let dataDateUsed = dateStr;

        for (const d of dates) {
          const bill = await fetchRoomBill(d, room);
          if (bill > 0) {
            userCount = await estimateUserCount(d, room);
            costPerUser = bill / (userCount > 0 ? userCount : 1);
            dataDateUsed = d;
            dataFound = true;
            break;
          }
        }

        const displayName = ROOM_ENERGY[room].displayName || room;
        return {
          room: room,
          displayName: displayName,
          userCount: userCount,
          costPerUser: costPerUser,
          dataDate: dataDateUsed
        };
      }));

      container.innerHTML = cards.map(card => `
        <div class="room-card">
          <div class="room-card-name">${escapeHtml(card.displayName)}</div>
          <div class="room-card-stat">ผู้ใช้: <strong>${card.userCount}</strong></div>
          <div class="room-card-cost">฿${card.costPerUser.toFixed(2)}/คน</div>
          <div style="font-size: 0.65rem; color: var(--text-secondary); margin-top: 4px;">${card.dataDate}</div>
        </div>
      `).join('');
    } catch (err) {
      console.error('updateSidebar error:', err);
      container.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-secondary);">ไม่สามารถโหลดข้อมูล</div>';
    }
  }

  async function fetchRoomBill(dateStr, room) {
    const api = getEnergyAPI(room).api;
    const ttl = dateStr === todayStr() ? CACHE_TTL : CACHE_TTL_OLD;
    try {
      const daily = await fetchJSONCached(api + '/daily-bill?date=' + dateStr, ttl);
      const bill = Number(daily && daily.electricity_bill);
      if (!Number.isNaN(bill) && bill >= 0) return bill;
    } catch { /* fallback below */ }

    try {
      const values = await fetchDailyData(dateStr, room);
      const minuteData = mapTo1440(values || []);
      let kwh = 0;
      minuteData.forEach(v => {
        if (v !== null) kwh += (v / 60);
      });
      return kwh * ENERGY_RATE_THB_PER_KWH;
    } catch {
      return 0;
    }
  }

  function buildLastNDays(endDate, days) {
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push(dateShift(endDate, -i));
    }
    return dates;
  }

  async function buildSevenDayRoomBillDataset(endDate, scope, daysWindow) {
    const rooms = scope === 'all' ? ROOMS : [scope];
    const dates = buildLastNDays(endDate, daysWindow);

    const rows = await Promise.all(dates.map(async d => {
      const bills = await Promise.all(rooms.map(room => fetchRoomBill(d, room)));
      return { date: d, bills: bills };
    }));

    return { rooms: rooms, rows: rows };
  }

  function renderUsersVsBillChart(sevenDayData, daysWindow) {
    destroyChart('eUsersVsBill');
    const canvas = document.getElementById('eUsersVsBillChart');
    if (!canvas) return;

    const titleEl = document.getElementById('sevenDayTitle');
    if (titleEl && sevenDayData.rows.length > 0) {
      const startDate = shortDateTH(sevenDayData.rows[0].date);
      const endDate = shortDateTH(sevenDayData.rows[sevenDayData.rows.length - 1].date);
      titleEl.textContent = 'ค่าไฟย้อนหลัง ' + daysWindow + ' วัน (' + startDate + ' - ' + endDate + ')';
    }

    const roomColors = ['#4fc3f7', '#ffa726', '#66bb6a', '#ab47bc', '#ef5350', '#90caf9'];
    const labels = sevenDayData.rows.map(r => {
      const [, m, d] = r.date.split('-');
      return d + '/' + m;
    });

    const datasets = sevenDayData.rooms.map((room, roomIdx) => ({
      type: 'bar',
      label: (ROOM_ENERGY[room] && ROOM_ENERGY[room].displayName) || room,
      data: sevenDayData.rows.map(r => r.bills[roomIdx] || 0),
      backgroundColor: roomColors[roomIdx % roomColors.length],
      borderRadius: 6,
      barPercentage: 0.78,
      categoryPercentage: 0.7
    }));

    chartInstances.eUsersVsBill = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { labels: { color: '#a0a0b0', font: { size: 10 } } },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                return ctx.dataset.label + ': ฿' + Number(ctx.raw).toFixed(2);
              },
              footer: function(items) {
                const total = items.reduce((sum, it) => sum + Number(it.raw || 0), 0);
                return 'รวม: ฿' + total.toFixed(2);
              }
            }
          }
        },
        scales: {
          x: {
            stacked: false,
            ticks: { color: '#a0a0b0', font: { size: 10 } },
            grid: { display: false }
          },
          y: {
            beginAtZero: true,
            stacked: false,
            ticks: { color: '#a0a0b0' },
            grid: { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'THB', color: '#a0a0b0' }
          }
        }
      }
    });
  }

  function diffClass(diff) {
    if (diff > 0) return 'diff-up';
    if (diff < 0) return 'diff-down';
    return 'diff-flat';
  }

  function diffText(diff, suffix, fixed) {
    const sign = diff > 0 ? '+' : '';
    const val = fixed ? Math.abs(diff).toFixed(fixed) : Math.abs(diff).toFixed(0);
    return sign + diff.toFixed(fixed || 0) + (suffix ? ' ' + suffix : '');
  }

  function renderRoomUsageTable(compareRows, currentDate, prevDate) {
    const container = document.getElementById('roomUsageTableBody');
    if (!container) return;
    if (!compareRows.length) {
      container.innerHTML = '<div class="notif-empty">ไม่พบข้อมูล</div>';
      return;
    }

    const currentDateText = shortDateTH(currentDate);
    const prevDateText = shortDateTH(prevDate);

    const rows = compareRows
      .slice()
      .sort((a, b) => b.costPerUser - a.costPerUser)
      .map(d =>
        '<tr>' +
          '<td>' + escapeHtml(d.roomName) + '</td>' +
          '<td>' + d.users + ' / ' + d.prevUsers + '</td>' +
          '<td>฿' + d.bill.toFixed(2) + ' / ฿' + d.prevBill.toFixed(2) + '</td>' +
          '<td>฿' + d.costPerUser.toFixed(2) + ' / ฿' + d.prevCostPerUser.toFixed(2) + '</td>' +
          '<td class="' + diffClass(d.costDiff) + '">' + diffText(d.costDiff, '฿', 2) + '</td>' +
        '</tr>'
      ).join('');

    container.innerHTML =
      '<table class="room-usage-table">' +
        '<thead><tr><th>ห้อง</th><th>ผู้ใช้ (' + currentDateText + ' / ' + prevDateText + ')</th><th>ค่าไฟ (' + currentDateText + ' / ' + prevDateText + ')</th><th>ค่าไฟ/คน (' + currentDateText + ' / ' + prevDateText + ')</th><th>ผลต่างค่าไฟ/คน</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  async function loadUserEnergyInsights(date, scope) {
    try {
      const sevenDayData = await buildSevenDayRoomBillDataset(date, scope, currentGraphDaysWindow);
      renderUsersVsBillChart(sevenDayData, currentGraphDaysWindow);
    } catch {
      destroyChart('eUsersVsBill');
    }
  }

  // ==================== NEW DASHBOARD DESIGN ====================
  const THAI_MONTHS_ABBR = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  function thaiMonthShort(year, month) {
    const be = year + 543;
    return THAI_MONTHS_ABBR[month - 1] + String(be).slice(-2);
  }

  function buildMonthDateList(year, month, upToDay) {
    const maxDay = upToDay || new Date(year, month, 0).getDate();
    const list = [];
    for (let d = 1; d <= maxDay; d++) {
      list.push(year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
    }
    return list;
  }

  function deterministicUserCount(dateStr, roomIdx) {
    const parts = dateStr.split('-').map(Number);
    const dow = new Date(dateStr).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const hash = (parts[0] * 7 + parts[1] * 31 + parts[2] * 13 + roomIdx * 17) % 25;
    return isWeekend ? 3 + (hash % 8) : 15 + hash;
  }

  async function buildUserCountDataset(dates, rooms) {
    return Promise.all(dates.map(async (dateStr) => {
      const counts = await Promise.all(rooms.map(async (room, ri) => {
        try {
          const bookings = await getBookingsForDate(dateStr, room);
          const count = parseRealUserCount(bookings);
          return count > 0 ? count : deterministicUserCount(dateStr, ri);
        } catch {
          return deterministicUserCount(dateStr, ri);
        }
      }));
      return { date: dateStr, counts };
    }));
  }

  async function fetchMonthTotal(year, month) {
    const bkk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const curYear = bkk.getFullYear();
    const curMonth = bkk.getMonth() + 1;
    const curDay = bkk.getDate();
    const maxDay = (year === curYear && month === curMonth) ? curDay : new Date(year, month, 0).getDate();
    const dates = buildMonthDateList(year, month, maxDay);
    let totalBill = 0;
    await Promise.all(ROOMS.map(async (room) => {
      const bills = await Promise.all(dates.map(d => fetchRoomBill(d, room)));
      bills.forEach(b => { totalBill += b; });
    }));
    let totalUsers = 0;
    dates.forEach((d) => { ROOMS.forEach((r, ri) => { totalUsers += deterministicUserCount(d, ri); }); });
    return { bill: totalBill, users: totalUsers };
  }

  function renderSummaryCards(currYear, currMonth, currBill, currUsers, prevYear, prevMonth, prevBill, prevUsers) {
    function setEl(id, val, asHtml) {
      const el = document.getElementById(id);
      if (!el) return;
      if (asHtml) el.innerHTML = val;
      else el.textContent = val;
    }
    const currLabel = thaiMonthShort(currYear, currMonth);
    const prevLabel = thaiMonthShort(prevYear, prevMonth);
    setEl('summaryMonthLabel', currLabel);
    setEl('summaryMonthBill', '<span class="dsc-value-main">' + Math.round(currBill).toLocaleString() + '</span><span class="dsc-value-unit">บาท</span>', true);
    setEl('summaryPrevMonthLabel', prevLabel);
    setEl('summaryPrevMonthBill', Math.round(prevBill).toLocaleString() + ' บาท');
    setEl('summaryThisMonthLabel', currLabel);
    setEl('summaryThisMonthBill', Math.round(currBill).toLocaleString() + ' บาท');
    setEl('summaryUsersMonthLabel', currLabel);
    setEl('summaryMonthUsers', '<span class="dsc-value-main">' + Math.round(currUsers).toLocaleString() + '</span><span class="dsc-value-unit">ครั้ง</span>', true);
    setEl('summaryPrevUsersMonthLabel', prevLabel);
    setEl('summaryPrevMonthUsers', Math.round(prevUsers).toLocaleString() + ' ครั้ง');
    setEl('summaryThisUsersMonthLabel', currLabel);
    setEl('summaryThisMonthUsers', Math.round(currUsers).toLocaleString() + ' ครั้ง');
  }

  const ROOM_CHART_COLORS = ['#bfb8b0', '#887e78', '#705050'];

  function renderDualCharts(sevenDayData, userCountData) {
    destroyChart('electricityChart');
    destroyChart('usersChart');
    const elCanvas = document.getElementById('electricityChart');
    const usCanvas = document.getElementById('usersChart');
    if (!elCanvas || !usCanvas) return;

    const labels = sevenDayData.rows.map(r => {
      const [, m, d] = r.date.split('-');
      return d + '/' + m;
    });

    function makeDatasets(getVal) {
      return sevenDayData.rooms.map((room, ri) => ({
        label: (ROOM_ENERGY[room] && ROOM_ENERGY[room].displayName) || room,
        data: sevenDayData.rows.map((r, di) => getVal(r, di, ri)),
        backgroundColor: ROOM_CHART_COLORS[ri % ROOM_CHART_COLORS.length],
        borderRadius: 3,
        barPercentage: 0.75,
        categoryPercentage: 0.7
      }));
    }

    function makeOptions(yTitle) {
      return {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1.42,
        plugins: {
          legend: { position: 'bottom', align: 'end', labels: { color: '#777', font: { size: 9 }, boxWidth: 12, padding: 6 } },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + Number(ctx.raw).toFixed(1) } }
        },
        scales: {
          x: {
            stacked: false,
            ticks: { color: '#888', font: { size: 9 } },
            grid: { display: false },
            title: { display: true, text: 'วันที่', color: '#9d9d9d', font: { size: 9 } }
          },
          y: {
            beginAtZero: true,
            stacked: false,
            ticks: { color: '#888', font: { size: 9 } },
            grid: { color: 'rgba(0,0,0,0.06)' },
            title: { display: true, text: yTitle, color: '#9d9d9d', font: { size: 9 } }
          }
        }
      };
    }

    chartInstances.electricityChart = new Chart(elCanvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: makeDatasets((r, di, ri) => r.bills[ri] || 0) },
      options: makeOptions('ค่าไฟฟ้า(บาท)')
    });

    chartInstances.usersChart = new Chart(usCanvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: makeDatasets((r, di, ri) => userCountData[di] ? (userCountData[di].counts[ri] || 0) : 0) },
      options: makeOptions('จำนวนผู้ใช้(คน)')
    });
  }

  function renderCostPerUserGrid(sevenDayData, userCountData) {
    const container = document.getElementById('costPerUserGrid');
    if (!container) return;
    const items = sevenDayData.rooms.map((room, ri) => {
      const totalBill = sevenDayData.rows.reduce((sum, r) => sum + (r.bills[ri] || 0), 0);
      const totalUsers = userCountData.reduce((sum, d) => sum + (d.counts[ri] || 0), 0);
      const costPerUser = totalUsers > 0 ? totalBill / totalUsers : 0;
      const displayName = (ROOM_ENERGY[room] && ROOM_ENERGY[room].displayName) || room;
      return '<div class="dash-cost-item">' +
        '<div class="dash-cost-room">' + escapeHtml(displayName) + '</div>' +
        '<div class="dash-cost-amount">' + Math.round(costPerUser) + ' บาท/คน</div>' +
        '</div>';
    });
    container.innerHTML = items.join('');
  }

  async function loadDashboard(endDate, scope) {
    try {
      const sevenDayData = await buildSevenDayRoomBillDataset(endDate, scope, currentGraphDaysWindow);
      const userCountData = await buildUserCountDataset(sevenDayData.rows.map(r => r.date), sevenDayData.rooms);
      renderDualCharts(sevenDayData, userCountData);
      renderCostPerUserGrid(sevenDayData, userCountData);
      const bkk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
      const currYear = bkk.getFullYear();
      const currMonth = bkk.getMonth() + 1;
      const prevD = new Date(currYear, currMonth - 2, 1);
      const [curr, prev] = await Promise.all([
        fetchMonthTotal(currYear, currMonth),
        fetchMonthTotal(prevD.getFullYear(), prevD.getMonth() + 1)
      ]);
      renderSummaryCards(currYear, currMonth, curr.bill, curr.users, prevD.getFullYear(), prevD.getMonth() + 1, prev.bill, prev.users);
    } catch (err) {
      console.error('loadDashboard error:', err);
    }
  }

  function downsampleChart(chartData, maxVal, maxIdx, avgVal, MAX_POINTS) {
    const len = chartData.length;
    if (len <= MAX_POINTS) {
      return { labels: getMinuteLabels(), power: chartData,
        maxLine: new Array(len).fill(null).map((_, i) => i === maxIdx ? maxVal : null),
        avgLine: new Array(len).fill(avgVal) };
    }
    const factor = Math.ceil(len / MAX_POINTS);
    const labels = getMinuteLabels();
    const sL = [], sP = [], sM = [], sA = [];
    for (let i = 0; i < len; i += factor) {
      const wEnd = Math.min(i + factor - 1, len - 1);
      let lMax = null;
      for (let j = i; j <= wEnd; j++) {
        const v = chartData[j];
        if (v !== null && (lMax === null || v > lMax)) lMax = v;
      }
      sP.push(lMax);
      sM.push((maxIdx !== null && maxIdx >= i && maxIdx <= wEnd) ? maxVal : null);
      sA.push(avgVal);
      sL.push(labels[i]);
    }
    return { labels: sL, power: sP, maxLine: sM, avgLine: sA };
  }

  async function loadEnergyMode() {
    showLoading(energyLoading);
    try {
      const date = currentGraphEndDate || todayStr();
      const scope = overviewEnergyScope ? overviewEnergyScope.value : 'all';
      hideLoading(energyLoading);
      await loadDashboard(date, scope);
    } catch (err) {
      console.error('loadEnergyMode error:', err);
      hideLoading(energyLoading);
    }
  }

  async function loadMonthlyEstimate(date, scope) {
    try {
      const [year, month] = date.split('-');
      const rooms = scope === 'all' ? ROOMS : [scope];
      let monthBill = 0, monthKwh = 0;
      await Promise.all(rooms.map(async room => {
        const api = getEnergyAPI(room).api;
        try {
          const cal = await fetchJSONCached(api + '/calendar?year=' + year + '&month=' + month, CACHE_TTL_OLD);
          const events = Array.isArray(cal) ? cal : (cal.value || cal.data || cal.days || []);
          events.forEach(ev => {
            if (!ev.start || !ev.start.startsWith(year + '-' + month)) return;
            const props = ev.extendedProps || {};
            if (props.type === 'bill') {
              const val = parseFloat(String(props.display_text || ev.title || '0').replace(/[^\d.]/g, ''));
              if (!isNaN(val)) monthBill += val;
            } else if (props.type === 'energy') {
              const val = parseFloat(String(props.display_text || ev.title || '0').replace(/[^\d.]/g, ''));
              if (!isNaN(val)) monthKwh += val;
            }
          });
        } catch { /* skip */ }
      }));
      set('eBillMonth', 'ค่าไฟฟ้ารายเดือน: \u0E3F' + monthBill.toFixed(1));
      set('eKwhMonth', 'หน่วยไฟฟ้ารายเดือน: ' + monthKwh.toFixed(1) + ' kWh');
    } catch {
      set('eBillMonth', 'ค่าไฟฟ้ารายเดือน: -');
      set('eKwhMonth', 'หน่วยไฟฟ้ารายเดือน: -');
    }
  }

  async function loadBillComparison(date, scope) {
    try {
      const rooms = scope === 'all' ? ROOMS : [scope];
      const d = new Date(date);
      const yesterday = new Date(d); yesterday.setDate(d.getDate() - 1);
      const yStr = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');

      let todayBill = 0, yesterdayBill = 0;
      await Promise.all(rooms.map(async room => {
        const api = getEnergyAPI(room).api;
        try {
          const [tb, yb] = await Promise.all([
            fetchJSONCached(api + '/daily-bill?date=' + date, CACHE_TTL_OLD).catch(() => ({})),
            fetchJSONCached(api + '/daily-bill?date=' + yStr, CACHE_TTL_OLD).catch(() => ({}))
          ]);
          todayBill += tb.electricity_bill || 0;
          yesterdayBill += yb.electricity_bill || 0;
        } catch { /* skip */ }
      }));

      const diff = todayBill - yesterdayBill;
      const arrow = diff > 0 ? '\u2191' : diff < 0 ? '\u2193' : '=';
      set('eBillCompare', arrow + ' \u0E3F' + Math.abs(diff).toFixed(1));
      set('eBillCompareDetail', 'เมื่อวาน: \u0E3F' + yesterdayBill.toFixed(1) + ' / วันนี้: \u0E3F' + todayBill.toFixed(1));
    } catch {
      set('eBillCompare', '-');
    }
  }

  async function loadSolarRecommendation(date, scope) {
    try {
      const rooms = scope === 'all' ? ROOMS : [scope];
      let totalDayCost = 0;
      await Promise.all(rooms.map(async room => {
        const api = getEnergyAPI(room).api;
        try {
          const res = await fetchJSONCached(api + '/solar-size?date=' + date, CACHE_TTL_OLD);
          totalDayCost += res.dayCost || 0;
        } catch { /* skip */ }
      }));
      // Estimate: solar panel to offset day cost, ~4.4 THB/kWh, ~4.5 peak sun hours/day
      const dailyKwhDay = totalDayCost / 4.4;
      const solarKw = dailyKwhDay / 4.5;
      const monthlySaving = totalDayCost * 30;
      set('eSolarRec', solarKw > 0 ? solarKw.toFixed(1) + ' kW' : '-');
      set('eSolarSaving', monthlySaving > 0 ? 'ประหยัด ~\u0E3F' + monthlySaving.toFixed(0) + '/เดือน' : 'จำนวนเงินที่ช่วยลด: -');
    } catch {
      set('eSolarRec', '-');
      set('eSolarSaving', 'จำนวนเงินที่ช่วยลด: -');
    }
  }

  // ============================================================
  // Energy Calendar — shows daily bill & kWh per day
  // ============================================================
  async function renderEnergyCalendar(date, scope) {
    const el = document.getElementById('energyCalendar');
    if (!el) return;

    if (energyCalendarInstance) {
      energyCalendarInstance.destroy();
      energyCalendarInstance = null;
    }

    const rooms = scope === 'all' ? ROOMS : [scope];

    energyCalendarInstance = new FullCalendar.Calendar(el, {
      initialView: 'dayGridMonth',
      initialDate: date,
      locale: 'th',
      headerToolbar: { left: 'prev,next today', center: 'title', right: '' },
      height: 'auto',
      dayMaxEvents: false,
      events: async function(info, successCallback) {

        // Collect unique year-month combos covered by the view
        const monthsToFetch = new Set();
        const d = new Date(info.start);
        while (d < info.end) {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          monthsToFetch.add(y + '-' + m);
          d.setMonth(d.getMonth() + 1);
        }

        // Global perDay across all months to prevent duplicates at month boundaries
        const perDay = {};

        await Promise.all([...monthsToFetch].map(async ym => {
          const [y, m] = ym.split('-');

          // Fetch per room (each room adds its API's full value)
          await Promise.all(rooms.map(async room => {
            const api = getEnergyAPI(room).api;
            try {
              const cal = await fetchJSONCached(api + '/calendar?year=' + y + '&month=' + m, CACHE_TTL_OLD);
              const events = Array.isArray(cal) ? cal : (cal.value || cal.data || cal.days || []);
              events.forEach(ev => {
                if (!ev.start) return;
                if (!ev.start.startsWith(y + '-' + m)) return; // only events for requested month
                const dayKey = ev.start.substring(0, 10);
                if (!perDay[dayKey]) perDay[dayKey] = { bill: 0, kwh: 0 };
                const props = ev.extendedProps || {};
                const val = parseFloat(String(props.display_text || ev.title || '0').replace(/[^\d.]/g, ''));
                if (isNaN(val)) return;
                if (props.type === 'bill') perDay[dayKey].bill += val;
                else if (props.type === 'energy') perDay[dayKey].kwh += val;
              });
            } catch { /* skip */ }
          }));
        }));

        const allEvents = [];
        Object.entries(perDay).forEach(([dayKey, v]) => {
          if (v.bill > 0) {
            allEvents.push({
              title: '฿' + v.bill.toFixed(1),
              start: dayKey,
              allDay: true,
              display: 'block',
              classNames: ['energy-cal-bill'],
              extendedProps: { type: 'bill', value: v.bill }
            });
          }
          if (v.kwh > 0) {
            allEvents.push({
              title: v.kwh.toFixed(1) + ' kWh',
              start: dayKey,
              allDay: true,
              display: 'block',
              classNames: ['energy-cal-kwh'],
              extendedProps: { type: 'energy', value: v.kwh }
            });
          }
        });

        successCallback(allEvents);
      },
      eventClick: function(info) {
        const p = info.event.extendedProps;
        const dateStr = info.event.startStr;
        if (overviewEnergyDate) {
          overviewEnergyDate.value = dateStr;
          loadEnergyMode();
        }
      }
    });
    energyCalendarInstance.render();
  }

  function startRealtimePolling(date, scope) {
    if (realtimeInterval) { clearInterval(realtimeInterval); realtimeInterval = null; }
    if (date !== todayStr()) return;
    const isAll = scope === 'all';

    realtimeInterval = setInterval(async () => {
      const activeMode = document.querySelector('.mode-tab.active');
      if (currentSection !== 'overview' || !activeMode || activeMode.dataset.mode !== 'energy') return;

      try {
        let chartData;
        if (isAll) {
          const allValues = await Promise.all(ROOMS.map(r => fetchDailyData(date, r)));
          chartData = mergeMinuteArrays(allValues.map(v => mapTo1440(v)));
        } else {
          const values = await fetchDailyData(date, scope);
          chartData = mapTo1440(values);
        }

        const chart = chartInstances.eRealtime;
        if (!chart) return;
        const { maxVal, maxIdx, avgVal } = computeMaxAvg(chartData);
        const ds = downsampleChart(chartData, maxVal, maxIdx, avgVal, 360);
        chart.data.labels = ds.labels;
        chart.data.datasets[0].data = ds.power;
        chart.data.datasets[1].data = ds.maxLine;
        chart.data.datasets[2].data = ds.avgLine;
        chart.update('none');
      } catch { /* silent */ }
    }, 20000);
  }

  async function renderRealtimeChart(date, scope) {
    destroyChart('eRealtime');
    const canvas = document.getElementById('eRealtimeChart');
    if (!canvas) return;

    // Show loading text
    const parent = canvas.parentElement;
    let loadingEl = parent.querySelector('.chart-loading');
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'chart-loading';
      loadingEl.textContent = '\u0E01\u0E33\u0E25\u0E31\u0E07\u0E42\u0E2B\u0E25\u0E14\u0E01\u0E23\u0E32\u0E1F...';
      parent.appendChild(loadingEl);
    }
    loadingEl.style.display = 'flex';

    let chartData;
    try {
    if (scope === 'all') {
      const allValues = await Promise.all(ROOMS.map(r => fetchDailyData(date, r)));
      chartData = mergeMinuteArrays(allValues.map(v => mapTo1440(v)));
    } else {
      chartData = mapTo1440(await fetchDailyData(date, scope));
    }
    } catch { chartData = new Array(1440).fill(null); }
    loadingEl.style.display = 'none';
    const { maxVal, maxIdx, avgVal } = computeMaxAvg(chartData);
    const ds = downsampleChart(chartData, maxVal, maxIdx, avgVal, 360);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 300);
    gradient.addColorStop(0, 'rgba(255,167,38,0.4)');
    gradient.addColorStop(0.5, 'rgba(255,167,38,0.2)');
    gradient.addColorStop(1, 'rgba(255,167,38,0.02)');

    chartInstances.eRealtime = new Chart(ctx, {
      type: 'line',
      data: {
        labels: ds.labels,
        datasets: [
          { label: 'Power', data: ds.power, borderColor: '#ffa726', backgroundColor: gradient, fill: true, borderWidth: 0.5, tension: 0.3, pointRadius: 0 },
          { label: 'Max', data: ds.maxLine, borderColor: '#ff5252', pointRadius: 5, pointBackgroundColor: '#ff5252', fill: false, showLine: false },
          { label: 'Average', data: ds.avgLine, borderColor: '#90caf9', borderDash: [5,5], fill: false, pointRadius: 0, borderWidth: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: true, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { return ctx.raw === null ? null : ctx.dataset.label + ': ' + ctx.raw.toFixed(2) + ' kW'; } } } },
        scales: {
          x: { type: 'category', grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, color: '#a0a0b0', font: { size: 9 },
            callback: function(v) { const l = this.getLabelForValue(v); if (!l) return ''; const [h, m] = l.split(':'); if (m === '00' && (parseInt(h) % 3) === 0) return h + '.00'; return ''; }
          } },
          y: { beginAtZero: true, min: 0, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#a0a0b0', font: { size: 10 } }, title: { display: true, text: 'Power (kW)', color: '#a0a0b0', font: { size: 10 } } }
        }
      }
    });
  }

  // Compute hourly bill from /daily-energy minute-level data (Bangkok time)
  function computeHourlyBillFromMinutes(minuteData) {
    const hourlyKwh = new Array(24).fill(0);
    for (let i = 0; i < minuteData.length; i++) {
      if (minuteData[i] === null) continue;
      const bkkHour = Math.floor(i / 60); // mapTo1440 uses UTC index = Bangkok hour (data stored as UTC+7 mapped)
      if (bkkHour >= 0 && bkkHour < 24) {
        hourlyKwh[bkkHour] += (minuteData[i] / 60); // kW * (1/60 hr) = kWh
      }
    }
    return hourlyKwh.map((kwh, h) => ({ hour: h, bill: kwh * ENERGY_RATE_THB_PER_KWH }));
  }

  async function renderHourlyChart(date, scope) {
    destroyChart('eHourly');
    const canvas = document.getElementById('eHourlyChart');
    if (!canvas) return;

    // Show loading text
    const parent = canvas.parentElement;
    let loadingEl = parent.querySelector('.chart-loading');
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'chart-loading';
      loadingEl.textContent = '\u0E01\u0E33\u0E25\u0E31\u0E07\u0E42\u0E2B\u0E25\u0E14\u0E01\u0E23\u0E32\u0E1F...';
      parent.appendChild(loadingEl);
    }
    loadingEl.style.display = 'flex';

    // Use /daily-energy data (same as realtime chart) to compute hourly bills
    let minuteData;
    try {
    if (scope === 'all') {
      const allValues = await Promise.all(ROOMS.map(r => fetchDailyData(date, r)));
      minuteData = mergeMinuteArrays(allValues.map(v => mapTo1440(v)));
    } else {
      minuteData = mapTo1440(await fetchDailyData(date, scope));
    }
    } catch { minuteData = new Array(1440).fill(null); }
    loadingEl.style.display = 'none';
    const full24 = computeHourlyBillFromMinutes(minuteData);

    chartInstances.eHourly = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: full24.map(h => String(h.hour).padStart(2, '0') + ':00'),
        datasets: [{ label: 'ค่าไฟ (฿)', data: full24.map(h => h.bill),
          backgroundColor: full24.map(h => h.hour >= 6 && h.hour < 19 ? 'rgba(255,167,38,0.7)' : 'rgba(79,195,247,0.7)'),
          borderRadius: 4, barPercentage: 0.7 }]
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { return '\u0E3F' + ctx.raw.toFixed(2); } } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#a0a0b0', font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#a0a0b0', font: { size: 10 } }, title: { display: true, text: 'THB', color: '#a0a0b0' } }
        }
      }
    });
  }

  async function renderDayNightChart(scope) {
    destroyChart('eDayNight');
    const canvas = document.getElementById('eDayNightChart');
    if (!canvas) return;

    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      dates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    }

    const isAll = scope === 'all';
    const uniqueApis = isAll
      ? [...new Set(ROOMS.map(r => getEnergyAPI(r).api))]
      : [getEnergyAPI(scope).api];
    const data = await Promise.all(dates.map(async date => {
      try {
        const results = await Promise.all(uniqueApis.map(api =>
          fetchJSONCached(api + '/solar-size?date=' + date, CACHE_TTL_OLD).catch(() => ({ dayCost: 0, nightCost: 0 }))
        ));
        return { date: date, dayCost: results.reduce((s, r) => s + (r.dayCost || 0), 0), nightCost: results.reduce((s, r) => s + (r.nightCost || 0), 0) };
      } catch { return { date: date, dayCost: 0, nightCost: 0 }; }
    }));

    const shortM = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const labels = data.map(d => { const [, m, day] = d.date.split('-'); return parseInt(day) + ' ' + shortM[parseInt(m) - 1]; });

    chartInstances.eDayNight = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'กลางวัน', data: data.map(d => d.dayCost), backgroundColor: 'rgba(255,167,38,0.7)', borderRadius: 4, barPercentage: 0.6 },
          { label: 'กลางคืน', data: data.map(d => d.nightCost), backgroundColor: 'rgba(79,195,247,0.7)', borderRadius: 4, barPercentage: 0.6 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { labels: { color: '#a0a0b0', font: { size: 10 } } }, tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': \u0E3F' + ctx.raw.toFixed(2); } } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#a0a0b0', font: { size: 9 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#a0a0b0', font: { size: 10 } }, title: { display: true, text: 'THB', color: '#a0a0b0' } }
        }
      }
    });
  }

  // ============================================================
  // 1. ภาพรวมข้อมูล — Booking / การใช้ห้อง Mode
  // ============================================================

  async function loadBookingMode() {
    showLoading(bookingLoading);
    try {
      const date = overviewBookingDate ? overviewBookingDate.value : todayStr();
      const room = overviewBookingRoom ? overviewBookingRoom.value : '';

      let url = API_BASE + '/api/bookings?date=' + date;
      if (room) url += '&room=' + encodeURIComponent(room);

      const [bookingsRes, roomStateRes] = await Promise.all([
        fetchJSON(url).catch(() => ({ data: [] })),
        fetchJSON(API_BASE + '/api/room-state').catch(() => ({ roomState: {} }))
      ]);

      const bookings = bookingsRes.data || [];
      const roomState = roomStateRes.roomState || {};

      const now = new Date();
      const bkk = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
      const currentMin = bkk.getHours() * 60 + bkk.getMinutes();

      // Summary cards
      set('bTotalToday', bookings.length);

      const activeNow = bookings.filter(b => {
        if (!b.firstCheckIn) return false;
        const [sh, sm] = b.startTime.split(':').map(Number);
        const [eh, em] = b.endTime.split(':').map(Number);
        return currentMin >= sh * 60 + sm && currentMin <= eh * 60 + em;
      }).length;
      set('bActiveNow', activeNow);

      // Available rooms = total rooms - rooms currently in use
      const busyRooms = new Set();
      bookings.forEach(b => {
        if (!b.firstCheckIn) return;
        const [sh, sm] = b.startTime.split(':').map(Number);
        const [eh, em] = b.endTime.split(':').map(Number);
        if (currentMin >= sh * 60 + sm && currentMin <= eh * 60 + em) {
          busyRooms.add((b.room || '').replace(/\s*\u25bc\s*/, '').trim());
        }
      });
      set('bAvailableNow', ROOMS.length - busyRooms.size);

      // Calendar
      renderBookingCalendar(date, room);
      // Monthly chart
      renderMonthlyUsageChart(date, room);
      // Daily booking list
      renderDailyBookingList(bookings, currentMin);

    } finally { hideLoading(bookingLoading); }
  }

  function renderBookingCalendar(date, roomFilter) {
    const el = document.getElementById('bookingCalendar');
    if (!el) return;

    if (calendarInstance) {
      calendarInstance.destroy();
      calendarInstance = null;
    }

    calendarInstance = new FullCalendar.Calendar(el, {
      initialView: 'dayGridMonth',
      initialDate: date,
      locale: 'th',
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,listWeek' },
      height: 'auto',
      events: async function(info, successCallback) {
        const start = info.start;
        const end = info.end;
        const allEvents = [];
        const d = new Date(start);
        while (d < end) {
          const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          try {
            let url = API_BASE + '/api/bookings?date=' + ds;
            if (roomFilter) url += '&room=' + encodeURIComponent(roomFilter);
            const res = await fetchJSON(url);
            (res.data || []).forEach(b => {
              allEvents.push({
                title: (b.bookerName || 'จอง') + ' - ' + ((ROOM_ENERGY[b.room] || {}).displayName || b.room),
                start: b.date + 'T' + b.startTime,
                end: b.date + 'T' + b.endTime,
                color: b.firstCheckIn ? '#66bb6a' : '#ffa726',
                extendedProps: b
              });
            });
          } catch { /* skip */ }
          d.setDate(d.getDate() + 1);
        }
        successCallback(allEvents);
      },
      eventClick: function(info) {
        const b = info.event.extendedProps;
        if (b) {
          alert(b.bookerName + '\n' + b.room + '\n' + b.startTime + ' - ' + b.endTime + '\n' + (b.purpose || ''));
        }
      }
    });
    calendarInstance.render();
  }

  async function renderMonthlyUsageChart(date, roomFilter) {
    destroyChart('bMonthly');
    const canvas = document.getElementById('bMonthlyChart');
    if (!canvas) return;

    // Show last 30 days of bookings
    const dates = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(date);
      d.setDate(d.getDate() - i);
      dates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    }

    const counts = await Promise.all(dates.map(async ds => {
      try {
        let url = API_BASE + '/api/bookings?date=' + ds;
        if (roomFilter) url += '&room=' + encodeURIComponent(roomFilter);
        const res = await fetchJSON(url);
        return (res.data || []).length;
      } catch { return 0; }
    }));

    const labels = dates.map(d => {
      const [, m, day] = d.split('-');
      return parseInt(day) + '/' + parseInt(m);
    });

    chartInstances.bMonthly = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{ label: 'จำนวนครั้ง', data: counts,
          backgroundColor: 'rgba(79,195,247,0.6)', borderColor: '#4fc3f7', borderWidth: 1, borderRadius: 4, barPercentage: 0.7 }]
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#a0a0b0', font: { size: 8 }, maxTicksLimit: 15, maxRotation: 45 } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#a0a0b0', stepSize: 1, font: { size: 10 } } }
        }
      }
    });
  }

  function renderDailyBookingList(bookings, currentMin) {
    const container = document.getElementById('bookingListDaily');
    if (!container) return;

    if (bookings.length === 0) {
      container.innerHTML = '<div class="notif-empty">ไม่มีการจองวันนี้</div>';
      return;
    }

    // Sort by start time
    const sorted = [...bookings].sort((a, b) => {
      const [ah, am] = a.startTime.split(':').map(Number);
      const [bh, bm] = b.startTime.split(':').map(Number);
      return (ah * 60 + am) - (bh * 60 + bm);
    });

    const todayDate = todayStr();
    container.innerHTML = sorted.map(b => {
      const [eh, em] = b.endTime.split(':').map(Number);
      const [sh, sm] = b.startTime.split(':').map(Number);
      const endMin = eh * 60 + em;
      const startMin = sh * 60 + sm;
      let statusClass, statusText;
      if (b.firstCheckIn && currentMin >= startMin && currentMin <= endMin) {
        statusClass = 'active'; statusText = 'กำลังใช้';
      } else if (b.firstCheckIn) {
        statusClass = 'done'; statusText = 'Check-in แล้ว';
      } else if (b.date < todayDate || (b.date === todayDate && currentMin > endMin)) {
        statusClass = 'done'; statusText = 'หมดเวลา';
      } else {
        statusClass = 'pending'; statusText = 'รอ Check-in';
      }

      const roomDisplay = ROOM_ENERGY[b.room] ? ROOM_ENERGY[b.room].displayName : b.room;

      return '<div class="booking-list-item">' +
        '<span class="booking-list-time">' + escapeHtml(b.startTime) + ' - ' + escapeHtml(b.endTime) + '</span>' +
        '<span class="booking-list-name">' + escapeHtml(b.bookerName) + '</span>' +
        '<span class="booking-list-room">' + escapeHtml(roomDisplay) + '</span>' +
        '<span class="booking-list-status ' + statusClass + '">' + statusText + '</span>' +
      '</div>';
    }).join('');
  }

  // ============================================================
  // 2. ควบคุม — Control Panel
  // ============================================================

  // Device state per room
  const deviceStates = {};
  let toggleBusy = false;

  function updateDeviceIcons(room, isOn) {
    const card = document.querySelector('.control-room-card[data-room="' + room + '"]');
    if (!card) return;
    const bulb = card.querySelector('.bulb-icon');
    const ac   = card.querySelector('.ac-icon');
    if (bulb) { bulb.classList.toggle('on', isOn); bulb.classList.toggle('off', !isOn); }
    if (ac)   { ac.classList.toggle('on', isOn);   ac.classList.toggle('off', !isOn); }
    deviceStates[room] = isOn;
  }

  async function toggleDevice(room, type) {
    if (toggleBusy) return;
    toggleBusy = true;
    const currentOn = !!deviceStates[room];
    const newAction = currentOn ? 'OFF' : 'ON';
    const card = document.querySelector('.control-room-card[data-room="' + room + '"]');
    const iconEl = card && card.querySelector(type === 'bulb' ? '.bulb-icon' : '.ac-icon');
    if (iconEl) iconEl.style.opacity = '0.4';

    try {
      const res = await fetch(API_BASE + '/api/toggle-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, action: newAction })
      });
      const json = await res.json();
      if (!json.success) { toggleBusy = false; if (iconEl) iconEl.style.opacity = '1'; return; }

      // Poll room-state for Sonoff feedback (max 3 seconds)
      let confirmed = false;
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const stateRes = await fetch(API_BASE + '/api/room-state');
          if (stateRes.ok) {
            const stateJson = await stateRes.json();
            if (stateJson && stateJson.success && stateJson.roomState) {
              const state = stateJson.roomState[room];
              if (typeof state === 'string') {
                const isOn = state.toUpperCase() === 'ON';
                if (isOn !== currentOn) {
                  updateDeviceIcons(room, isOn);
                  confirmed = true;
                  break;
                }
              }
            }
          }
        } catch { /* retry */ }
      }
      if (!confirmed) updateDeviceIcons(room, currentOn);
    } catch (e) {
      console.error('Toggle error:', e);
    } finally {
      if (iconEl) iconEl.style.opacity = '1';
      toggleBusy = false;
    }
  }

  // Floor plan auto-switch by room scope / donut chart for all
  function updateFloorplan(scope, billPerRoom) {
    const floorMap = { 'ห้อง101โถงชั้น1': '1', 'ห้อง200': '2', 'ห้อง300': '3' };
    const isAll = scope === 'all';
    const floor = isAll ? 'donut' : (floorMap[scope] || '1');
    document.querySelectorAll('.floorplan-panel').forEach(p => p.classList.remove('active'));
    const panel = document.querySelector('.floorplan-panel[data-floor="' + floor + '"]');
    if (panel) panel.classList.add('active');
    const label = document.getElementById('floorLabel');
    const title = document.getElementById('floorplanTitle');
    if (isAll) {
      if (label) label.textContent = 'ทุกห้อง';
      if (title) title.textContent = 'สัดส่วนค่าไฟรายห้อง';
      renderRoomDonut(billPerRoom);
    } else {
      if (label) label.textContent = 'ชั้น ' + floor;
      if (title) title.textContent = 'แผนผังอาคาร';
    }
  }

  function renderRoomDonut(billPerRoom) {
    destroyChart('eRoomDonut');
    const canvas = document.getElementById('eRoomDonutChart');
    if (!canvas) return;
    const labels = billPerRoom ? billPerRoom.map(r => r.name) : ROOMS.map(r => ROOM_ENERGY[r].displayName);
    const data = billPerRoom ? billPerRoom.map(r => r.bill) : [0, 0, 0];
    const colors = ['#ffa726', '#4fc3f7', '#ab47bc'];
    chartInstances.eRoomDonut = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: colors,
          borderColor: 'rgba(22,33,62,0.8)',
          borderWidth: 2,
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: { position: 'bottom', labels: { color: '#d0d0e0', font: { size: 11 }, padding: 12 } },
          tooltip: { callbacks: { label: function(ctx) { return ctx.label + ': \u0E3F' + ctx.raw.toFixed(1); } } }
        }
      }
    });
  }

  async function loadControlPanel() {
    const grid = document.getElementById('controlGrid');
    if (!grid) return;

    // Fetch room state, but always render cards from ROOMS
    let roomState = {};
    try {
      const res = await fetchJSON(API_BASE + '/api/room-state');
      roomState = res.roomState || {};
    } catch { /* API unavailable, use default OFF */ }

    grid.innerHTML = ROOMS.map(room => {
      const state = roomState[room] || 'OFF';
      const isOn = String(state).toUpperCase() === 'ON';
      deviceStates[room] = isOn;
      const displayName = ROOM_ENERGY[room] ? ROOM_ENERGY[room].displayName : room;
      const onClass = isOn ? 'on' : 'off';

      return '<div class="control-room-card" data-room="' + escapeHtml(room) + '">' +
        '<div class="control-room-header">' + escapeHtml(displayName) + '</div>' +
        '<div class="cctv-area" data-room="' + escapeHtml(room) + '">' +
          '<img class="cctv-frame" alt="CCTV">' +
          '<span class="cctv-label">CCTV</span>' +
        '</div>' +
        '<div class="device-row">' +
          // Bulb — same SVG from main MomayBUU app
          '<div class="device-item" data-room="' + escapeHtml(room) + '" data-type="bulb">' +
            '<svg class="bulb-icon ' + onClass + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48" width="52" height="52">' +
              '<ellipse cx="32" cy="20" rx="14" ry="16" fill="#e0d8c0" stroke="#74640a" stroke-width="2" class="bulb-glass"/>' +
              '<rect x="27" y="34" width="10" height="8" rx="2" fill="#b5a76c" stroke="#74640a" stroke-width="1.5"/>' +
              '<line x1="27" y1="37" x2="37" y2="37" stroke="#74640a" stroke-width="1"/>' +
              '<line x1="27" y1="40" x2="37" y2="40" stroke="#74640a" stroke-width="1"/>' +
              '<rect x="29" y="42" width="6" height="3" rx="1.5" fill="#74640a"/>' +
            '</svg>' +
            '<div class="device-status-text">อนิเมชั่นแสดงสถานะ</div>' +
          '</div>' +
          // AC — same SVG from main MomayBUU app
          '<div class="device-item" data-room="' + escapeHtml(room) + '" data-type="ac">' +
            '<svg class="ac-icon ' + onClass + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 52" width="52" height="52">' +
              '<rect x="4" y="4" width="56" height="26" rx="4" fill="#e0d8c0" stroke="#74640a" stroke-width="2" class="ac-body"/>' +
              '<line x1="10" y1="20" x2="54" y2="20" stroke="#74640a" stroke-width="1.5"/>' +
              '<line x1="10" y1="24" x2="54" y2="24" stroke="#74640a" stroke-width="1"/>' +
              '<circle cx="13" cy="12" r="2.5" fill="#999" class="ac-led"/>' +
              '<path d="M18 34 Q21 40 18 46" stroke="#74640a" stroke-width="1.5" fill="none" class="ac-wind" opacity="0"/>' +
              '<path d="M32 34 Q35 40 32 46" stroke="#74640a" stroke-width="1.5" fill="none" class="ac-wind" opacity="0"/>' +
              '<path d="M46 34 Q49 40 46 46" stroke="#74640a" stroke-width="1.5" fill="none" class="ac-wind" opacity="0"/>' +
            '</svg>' +
            '<div class="device-status-text">อนิเมชั่นแสดงสถานะ</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    // Toggle handlers
    grid.querySelectorAll('.device-item').forEach(item => {
      item.addEventListener('click', () => {
        toggleDevice(item.dataset.room, item.dataset.type);
      });
    });

    // CCTV click handlers — open popup with live stream
    grid.querySelectorAll('.cctv-area').forEach(area => {
      area.style.cursor = 'pointer';
      area.addEventListener('click', () => {
        const room = area.dataset.room;
        const displayName = ROOM_ENERGY[room] ? ROOM_ENERGY[room].displayName : room;
        openCctvPopup(displayName);
      });
    });
  }

  // ============================================================
  // CCTV WebSocket Stream
  // ============================================================
  let cctvWs = null;
  let cctvFpsTimer = null;
  let cctvStaleTimer = null;
  let cctvFrameCount = 0;
  let cctvLastFrameTime = 0;

  function cctvSetStatus(state, text) {
    const led = document.getElementById('cctvLed');
    const label = document.getElementById('cctvStatusLabel');
    const offline = document.getElementById('cctvOffline');
    if (!led || !label || !offline) return;
    label.textContent = text;
    if (state === 'live') {
      led.style.background = '#ff3b3b';
      led.style.animation = 'cctvBlink 1.5s infinite';
      label.style.color = '#ff6b6b';
      offline.style.display = 'none';
    } else {
      led.style.background = state === 'connecting' ? '#ffaa00' : '#666';
      led.style.animation = state === 'connecting' ? 'cctvBlink 0.8s infinite' : '';
      label.style.color = 'var(--text-secondary)';
      offline.style.display = 'flex';
      const span = offline.querySelector('span');
      if (span) span.textContent = text;
    }
  }

  function cctvShowOffline(msg) {
    cctvSetStatus('', msg || 'ไม่มีสัญญาณ');
    const imgEl = document.getElementById('cctvFrame');
    if (imgEl && imgEl.src && imgEl.src.startsWith('blob:')) URL.revokeObjectURL(imgEl.src);
    if (imgEl) imgEl.removeAttribute('src');
    const fpsEl = document.getElementById('cctvFps');
    if (fpsEl) fpsEl.textContent = '';
  }

  function cctvConnect() {
    if (cctvWs) return;
    cctvSetStatus('connecting', 'กำลังเชื่อมต่อ...');
    const params = new URLSearchParams(location.search);
    const cctvWsOverride = params.get('cctvWs');
    const host = (location.hostname || '').toLowerCase();
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const CCTV_WS_URL = cctvWsOverride
      ? cctvWsOverride
      : (isLocalHost ? 'wss://momaybuu-production.up.railway.app/ws/stream' : (wsProto + '//' + location.host + '/ws/stream'));
    cctvWs = new WebSocket(CCTV_WS_URL);
    cctvWs.binaryType = 'arraybuffer';

    cctvWs.onopen = function() {
      cctvSetStatus('connecting', 'เชื่อมต่อแล้ว — รอ stream...');
      cctvFrameCount = 0;
      cctvLastFrameTime = 0;
      const fpsEl = document.getElementById('cctvFps');
      cctvFpsTimer = setInterval(function() {
        if (fpsEl) fpsEl.textContent = cctvFrameCount > 0 ? cctvFrameCount + ' fps' : '';
        cctvFrameCount = 0;
      }, 1000);
      clearInterval(cctvStaleTimer);
      cctvStaleTimer = setInterval(function() {
        if (cctvLastFrameTime > 0 && Date.now() - cctvLastFrameTime > 3000) {
          cctvShowOffline('สัญญาณขาดหาย');
        }
      }, 1500);
    };

    cctvWs.onmessage = function(ev) {
      if (typeof ev.data === 'string') {
        if (ev.data === 'relay_offline') {
          cctvShowOffline('กล้องไม่ได้เปิด');
          cctvLastFrameTime = 0;
        }
        return;
      }
      cctvLastFrameTime = Date.now();
      const imgEl = document.getElementById('cctvFrame');
      const offline = document.getElementById('cctvOffline');
      const blob = new Blob([ev.data], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const oldUrl = imgEl ? imgEl.src : null;
      if (imgEl) imgEl.src = url;
      if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
      cctvFrameCount++;
      if (offline && offline.style.display !== 'none') cctvSetStatus('live', '● LIVE');
    };

    cctvWs.onclose = function() {
      cctvWs = null;
      clearInterval(cctvFpsTimer);
      clearInterval(cctvStaleTimer);
      cctvShowOffline('ไม่มีสัญญาณ');
    };

    cctvWs.onerror = function() {
      cctvShowOffline('เชื่อมต่อไม่ได้');
    };
  }

  function cctvDisconnect() {
    if (cctvWs) { cctvWs.close(); cctvWs = null; }
    clearInterval(cctvFpsTimer);
    clearInterval(cctvStaleTimer);
    const imgEl = document.getElementById('cctvFrame');
    if (imgEl && imgEl.src && imgEl.src.startsWith('blob:')) URL.revokeObjectURL(imgEl.src);
    if (imgEl) imgEl.removeAttribute('src');
  }

  function openCctvPopup(roomLabel) {
    const popup = document.getElementById('cctvPopup');
    const roomEl = document.getElementById('cctvPopupRoom');
    if (roomEl) roomEl.textContent = roomLabel || 'CCTV';
    if (popup) popup.style.display = 'flex';
    cctvConnect();
  }

  function closeCctvPopup() {
    const popup = document.getElementById('cctvPopup');
    if (popup) popup.style.display = 'none';
    cctvDisconnect();
  }

  // CCTV popup close handlers
  const cctvPopup = document.getElementById('cctvPopup');
  const cctvCloseBtn = document.getElementById('cctvCloseBtn');
  if (cctvPopup) cctvPopup.addEventListener('click', (e) => { if (e.target === cctvPopup) closeCctvPopup(); });
  if (cctvCloseBtn) cctvCloseBtn.addEventListener('click', closeCctvPopup);

  // ============================================================
  // 3. แจ้งเตือน — Notifications
  // ============================================================
  const notifBell = document.getElementById('notifBell');
  const notifDropdown = document.getElementById('notifDropdown');
  const notifCount = document.getElementById('notifCount');

  if (notifBell) {
    notifBell.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = notifDropdown.classList.toggle('open');
      if (isOpen) loadNotifications();
    });
  }

  document.addEventListener('click', (e) => {
    if (notifDropdown && !notifDropdown.contains(e.target) && e.target !== notifBell) {
      notifDropdown.classList.remove('open');
    }
  });

  async function loadNotifications() {
    const list = document.getElementById('notificationList');
    if (!list) return;

    const date = todayStr();
    const notifications = [];

    try {
      const [bookingsRes, logsRes] = await Promise.all([
        fetchJSON(API_BASE + '/api/bookings?date=' + date).catch(() => ({ data: [] })),
        fetchJSON(API_BASE + '/api/logs?date=' + date).catch(() => ({ data: [] }))
      ]);

      const bookings = bookingsRes.data || [];
      const logs = logsRes.data || [];
      const now = new Date();
      const bkk = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
      const currentMin = bkk.getHours() * 60 + bkk.getMinutes();

      bookings.forEach(b => {
        const [sh, sm] = b.startTime.split(':').map(Number);
        const [eh, em] = b.endTime.split(':').map(Number);
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;

        if (b.firstCheckIn && currentMin >= startMin && currentMin <= endMin) {
          notifications.push({ type: 'success', title: b.room + ' กำลังใช้งาน', detail: b.bookerName + ' \u2014 ' + b.startTime + ' ถึง ' + b.endTime, time: b.firstCheckIn });
        }
        if (!b.firstCheckIn && currentMin >= startMin - 30 && currentMin < startMin) {
          notifications.push({ type: 'warning', title: b.room + ' ใกล้ถึงเวลาจอง', detail: b.bookerName + ' จองเวลา ' + b.startTime + ' \u2014 ยังไม่ Check-in', time: b.createdAt });
        }
        if (!b.firstCheckIn && b.date === todayStr() && currentMin > endMin) {
          notifications.push({ type: 'urgent', title: b.room + ' ไม่มีการ Check-in', detail: b.bookerName + ' จองเวลา ' + b.startTime + '-' + b.endTime + ' \u2014 หมดเวลาแล้ว', time: b.createdAt });
        }
      });

      logs.filter(l => !l.accessGranted).forEach(log => {
        notifications.push({ type: 'urgent', title: 'ถูกปฏิเสธเข้าใช้ ' + log.room, detail: log.bookerName + ' \u2014 ' + (log.reason || 'ไม่ทราบสาเหตุ'), time: log.attemptTime });
      });

      logs.filter(l => l.accessGranted).slice(0, 5).forEach(log => {
        notifications.push({ type: 'info', title: 'เข้าใช้ ' + log.room + ' สำเร็จ', detail: log.bookerName + ' สแกน QR สำเร็จ', time: log.attemptTime });
      });

      notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
    } catch { /* skip */ }

    if (notifications.length === 0) {
      list.innerHTML = '<div class="notif-empty">ไม่มีแจ้งเตือนวันนี้</div>';
      updateNotifBadge(0);
      return;
    }

    updateNotifBadge(notifications.length);
    list.innerHTML = notifications.map(n =>
      '<div class="notif-item">' +
        '<div class="notif-dot ' + n.type + '"></div>' +
        '<div class="notif-content">' +
          '<div class="notif-title">' + escapeHtml(n.title) + '</div>' +
          '<div class="notif-detail">' + escapeHtml(n.detail) + '</div>' +
        '</div>' +
        '<div class="notif-time">' + timeAgo(n.time) + '</div>' +
      '</div>'
    ).join('');
  }

  const refreshNotifBtn = document.getElementById('refreshNotifications');
  if (refreshNotifBtn) refreshNotifBtn.addEventListener('click', loadNotifications);

  function updateNotifBadge(count) {
    if (!notifCount) return;
    if (count > 0) {
      notifCount.textContent = count > 99 ? '99+' : count;
      notifCount.classList.add('show');
      if (notifBell) notifBell.classList.add('has-notif');
    } else {
      notifCount.classList.remove('show');
      if (notifBell) notifBell.classList.remove('has-notif');
    }
  }

  // ============================================================
  // 4. ประชาสัมพันธ์ — Announcements
  // ============================================================
  const annSubmit = document.getElementById('annSubmit');
  const annStatus = document.getElementById('annStatus');

  if (annSubmit) {
    annSubmit.addEventListener('click', async () => {
      const title = document.getElementById('annTitle').value.trim();
      const body = document.getElementById('annBody').value.trim();
      const expiry = document.getElementById('annExpiry').value;
      const priority = document.getElementById('annPriority').value;

      if (!title) {
        annStatus.textContent = 'กรุณาใส่หัวข้อ';
        annStatus.className = 'form-status error';
        return;
      }

      annSubmit.disabled = true;
      annStatus.textContent = 'กำลังบันทึก...';
      annStatus.className = 'form-status';

      try {
        const res = await fetch(API_BASE + '/api/announcements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title, body: body, expiry: expiry, priority: priority })
        });
        const data = await res.json();

        if (data.success) {
          annStatus.textContent = 'เผยแพร่สำเร็จ';
          annStatus.className = 'form-status success';
          document.getElementById('annTitle').value = '';
          document.getElementById('annBody').value = '';
          document.getElementById('annExpiry').value = '';
          document.getElementById('annPriority').value = 'info';
          loadAnnouncements();
        } else {
          annStatus.textContent = data.error || 'เกิดข้อผิดพลาด';
          annStatus.className = 'form-status error';
        }
      } catch {
        annStatus.textContent = 'ไม่สามารถเชื่อมต่อ server';
        annStatus.className = 'form-status error';
      } finally { annSubmit.disabled = false; }
    });
  }

  async function loadAnnouncements() {
    const list = document.getElementById('announceList');
    if (!list) return;

    try {
      const res = await fetchJSON(API_BASE + '/api/announcements');
      const items = res.data || [];

      if (items.length === 0) {
        list.innerHTML = '<div class="notif-empty">ยังไม่มีข้อความ</div>';
        return;
      }

      list.innerHTML = items.map(item =>
        '<div class="announce-item">' +
          '<div class="announce-priority ' + (item.priority || 'info') + '"></div>' +
          '<div class="announce-content">' +
            '<div class="announce-title">' + escapeHtml(item.title) + '</div>' +
            '<div class="announce-body">' + escapeHtml(item.body || '') + '</div>' +
            '<div class="announce-meta">' +
              (item.expiry ? 'แสดงจนถึง: ' + item.expiry : 'ไม่มีวันหมดอายุ') +
              (item.createdAt ? ' \u2014 สร้างเมื่อ ' + formatTime(item.createdAt) : '') +
            '</div>' +
          '</div>' +
          '<button class="btn-delete" data-id="' + item._id + '" title="ลบ">ลบ</button>' +
        '</div>'
      ).join('');

      list.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('ต้องการลบข้อความนี้?')) return;
          try {
            await fetch(API_BASE + '/api/announcements/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
            loadAnnouncements();
          } catch { /* skip */ }
        });
      });
    } catch {
      list.innerHTML = '<div class="notif-empty">ไม่สามารถโหลดข้อความ</div>';
    }
  }

  // ==================== Auto-Refresh ====================
  setInterval(async () => {
    if (currentSection !== 'overview') return;
    const date = currentGraphEndDate || todayStr();
    const scope = overviewEnergyScope ? overviewEnergyScope.value : 'all';
    await loadUserEnergyInsights(date, scope);
  }, 30000);

  // ==================== Initial Load ====================
  loadEnergyMode();
});

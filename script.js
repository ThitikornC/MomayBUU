// ---------------- Global error capture (collect runtime crashes) ----------------
(function() {
  function saveErrorRecord(rec) {
    try {
      const key = 'momay_error_logs_v1';
      const existing = JSON.parse(localStorage.getItem(key) || '[]');
      existing.unshift(rec);
      localStorage.setItem(key, JSON.stringify(existing.slice(0, 50)));
    } catch (e) { /* ignore */ }
  }

  function showErrorOverlay(rec) {
    // Disabled - don't show error overlay to users
    // Errors are still logged to console and localStorage
    return;
  }

  function capture(record) {
    const rec = Object.assign({ ts: Date.now(), message: '', stack: null, file: null, line: null }, record || {});
    saveErrorRecord(rec);
    // show overlay (non-blocking)
    try { showErrorOverlay(rec); } catch (e) {}
    // still print to console
    console.error('Captured error:', rec);
  }

  window.addEventListener('error', function (e) {
    capture({ message: e.message || 'Error', stack: (e.error && e.error.stack) || null, file: e.filename, line: e.lineno });
  });

  window.addEventListener('unhandledrejection', function (e) {
    const reason = e.reason || {}; 
    capture({ message: reason.message || String(reason) || 'UnhandledRejection', stack: reason.stack || null });
  });

  // small helper to retrieve stored error logs from console if needed
  window.getMomayErrorLogs = function () { try { return JSON.parse(localStorage.getItem('momay_error_logs_v1') || '[]'); } catch (e) { return []; } };

})();

document.addEventListener('DOMContentLoaded', async function() {

  // ================= Date =================
  function updateDate() {
    const dateElement = document.getElementById('Date');
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const year = today.getFullYear();
    dateElement.textContent = `${day}/${month}/${year}`;
  }
  updateDate();

  // ================= Scaling only for exact 1080x1920 =================
  (function applyScalingForExactScreen() {
    try {
      console.log('applyScalingForExactScreen running');
      const params = new URLSearchParams(window.location.search);
      const force = params.get('scale') === '2';

      function isExact1080x1920() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        console.log('Window size:', w, 'x', h);
        return w === 1080 && h === 1920;
      }

      const shouldScale = force || isExact1080x1920();
      console.log('Should scale:', shouldScale);

      if (shouldScale) {
        document.body.style.transform = 'scale(2)';
        document.body.style.transformOrigin = 'top left';
        console.log('Applied scale(2) to body');
      } else {
        console.log('Not scaling');
      }
    } catch (e) { console.warn('applyScalingForExactScreen error', e); }
  })();

  // Temporarily bypass PIN overlay during development/tests
  try { sessionStorage.setItem('momay_unlocked', '1'); } catch (e) { /* ignore */ }

  // ================= PIN / Access Gate =================
  // Simple PIN overlay to gate access. PIN is '1608'.
  try {
    const pinOverlay = document.getElementById('pinOverlay');
    const pinInput = document.getElementById('pinInput');
    const pinSubmit = document.getElementById('pinSubmit');
    const pinError = document.getElementById('pinError');
    const PIN_CODE = '1608';

    function hidePinOverlay() {
      if (!pinOverlay) return;
      pinOverlay.setAttribute('aria-hidden', 'true');
      try { sessionStorage.setItem('momay_unlocked', '1'); } catch (e) {}
    }

    function showPinOverlay() {
      if (!pinOverlay) return;
      pinOverlay.setAttribute('aria-hidden', 'false');
      if (pinInput) pinInput.focus();
    }

    // If already unlocked in this session, keep hidden
    try {
      if (sessionStorage.getItem('momay_unlocked') === '1') {
        if (pinOverlay) pinOverlay.setAttribute('aria-hidden', 'true');
      } else {
        showPinOverlay();
      }
    } catch (e) {
      // ignore storage errors and show overlay
      showPinOverlay();
    }

    if (pinSubmit) pinSubmit.addEventListener('click', () => {
      const v = pinInput ? (pinInput.value || '') : '';
      if (v === PIN_CODE) {
        hidePinOverlay();
      } else {
        if (pinError) pinError.style.display = 'block';
        if (pinInput) pinInput.value = '';
        if (pinInput) pinInput.focus();
      }
    });

    if (pinInput) pinInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { pinSubmit && pinSubmit.click(); }
    });
  } catch (e) { /* non-fatal */ }

  // ================= Constants =================
  const V = 400;
  const root3 = Math.sqrt(3);
  const floor1_maxA = 100;
  const floor1_maxKW = root3 * V * floor1_maxA / 1000;
  const total_maxA = 100;
  const total_maxKW = root3 * V * total_maxA / 1000;

  // ================= Cache Management =================
  const cache = {
    powerData: null,
    dailyBill: null,
    weather: null,
    lastFetch: {}
  };

  const CACHE_DURATION = {
    power: 500, // 0.5 วินาที
    dailyBill: 10000, // 10 วินาที
    weather: 300000 // 5 นาที
  };

  // API base URL (declare early so functions can use it immediately)
  const API_BASE = 'https://momaydocbn-production.up.railway.app';

  // ================= Room Management =================
  // Only ห้อง101โถงชั้น1 has real data; others are empty placeholders
  const PRIMARY_ROOM = 'ห้อง101โถงชั้น1';
  let currentRoom = PRIMARY_ROOM;

  function isRoomWithData(roomName) {
    return roomName === PRIMARY_ROOM;
  }

  // Chart instances
  let totalDonutChart = null;

  function isCacheValid(key, duration) {
    return cache.lastFetch[key] && (Date.now() - cache.lastFetch[key] < duration);
  }

  function initializeTotalDonut() {
    const totalBarContainer = document.getElementById("Total_Bar");
    if (!totalBarContainer) return;

    totalBarContainer.innerHTML = '<canvas id="totalDonutCanvas"></canvas>';
    const canvas = document.getElementById("totalDonutCanvas");

    canvas.width = totalBarContainer.offsetWidth;
    canvas.height = totalBarContainer.offsetHeight;

    const ctx = canvas.getContext("2d");

    // สร้าง gradient แบบ radial สำหรับเอฟเฟกต์เรืองแสง
    const gradient = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, canvas.width / 2
    );
    gradient.addColorStop(0, "#FFEB99");    // เหลืองอ่อนตรงกลาง (เรืองแสง)
    gradient.addColorStop(0.5, "#FFD54F");  // เหลืองสดใส
    gradient.addColorStop(0.8, "#FBBF32");  // ส้มทอง
    gradient.addColorStop(1, "#FF9800");    // ส้มเข้มขอบนอก

    totalDonutChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: ["Current Power", "Remaining Capacity"],
        datasets: [{
          data: [0.01, 99.99],
          backgroundColor: [gradient, "#f8f6f0"],
          borderColor: ["#FBBF32", "#f8f6f0"],
          borderWidth: 2,
          cutout: "70%",
        }],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            backgroundColor: "rgba(0,0,0,0.8)",
            titleColor: "#fff",
            bodyColor: "#fff",
            cornerRadius: 8,
            callbacks: {
              label: (context) => `${Math.round(context.parsed)}%`
            }
          }
        }
      },
      plugins: [
        {
          id: "drawInnerCircle",
          beforeDraw(chart) {
            const { ctx, width, height } = chart;
            const centerX = width / 2;
            const centerY = height / 2;
            const innerRadius = chart.getDatasetMeta(0).data[0].innerRadius;

            ctx.save();
            const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, innerRadius);
            gradient.addColorStop(0, "#fffef8");
            gradient.addColorStop(1, "#f8f6f0");
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(centerX, centerY, innerRadius, 0, 2 * Math.PI);
            ctx.fill();
            ctx.restore();
          },
        },
        {
          id: "textCenter",
          beforeDatasetsDraw(chart) {
            const { width, height, ctx } = chart;
            ctx.save();
            const fontSize = Math.floor(height / 8);
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            ctx.fillStyle = "#2c1810";

            const totalPercent = chart.data.datasets[0].data[0];
            ctx.fillText(`${Math.round(totalPercent)}%`, width / 2, height / 2);
            ctx.restore();
          },
        },
      ],
    });
  }

  // ================= Progress bars & Check-in Status =================
  const totalBar = document.querySelector('#Total_Bar .progress-bar');
  const glow = document.querySelector('.glow');
  const mainContainer = document.querySelector('.Main_Container');
  const glowEl = document.querySelector('.glow');
  const totalBarText = document.getElementById('Total_Bar_Text');

  // Countdown element
  const realtimeCountdown = document.getElementById('realtimeCountdown');
  
  let checkinCountdownInterval = null;
  let checkinRemainingSeconds = 0;
  let activeBookingData = null;

  // Fetch active booking status for the room
  async function updateCheckinStatus() {
    try {
      const roomLabel = document.getElementById('Total_Bar_Label');
      const roomName = roomLabel ? roomLabel.textContent.replace(/\s*▼\s*/, '').trim() : '';
      if (!roomName) return;
      
      const response = await fetch(`/api/active-booking?room=${encodeURIComponent(roomName)}`);
      const result = await response.json();
      
      if (result.success && result.hasActiveBooking) {
        activeBookingData = result;
        
        // Always show countdown regardless of check-in status
        checkinRemainingSeconds = result.remainingSeconds;
        updateCountdownDisplay();
        if (!checkinCountdownInterval) {
          startCheckinCountdown();
        }
        // Light bulb ON
        updateBulbStatus(true);
      } else {
        // No active booking
        activeBookingData = null;
        if (realtimeCountdown) { realtimeCountdown.textContent = '--:--:--'; }
        
        // Stop countdown if running
        if (checkinCountdownInterval) {
          clearInterval(checkinCountdownInterval);
          checkinCountdownInterval = null;
        }
        // Light bulb OFF
        updateBulbStatus(false);
      }
    } catch (err) {
      console.error('Error fetching active booking:', err);
    }
  }
  
  function startCheckinCountdown() {
    updateCountdownDisplay();
    checkinCountdownInterval = setInterval(() => {
      checkinRemainingSeconds--;
      if (checkinRemainingSeconds <= 0) {
        checkinRemainingSeconds = 0;
        clearInterval(checkinCountdownInterval);
        checkinCountdownInterval = null;
        
        // Time's up - show check-out
        if (checkinDot) { checkinDot.className = 'checkin-dot no-booking'; }
        if (checkinLabel) { 
          checkinLabel.className = 'checkin-label checked-out'; 
          checkinLabel.textContent = '🔴 Check-out'; 
        }
        if (realtimeCountdown) { realtimeCountdown.textContent = '00:00:00'; }
      } else {
        updateCountdownDisplay();
      }
    }, 1000);
  }
  
  function updateCountdownDisplay() {
    if (!realtimeCountdown) return;
    const h = Math.floor(checkinRemainingSeconds / 3600);
    const m = Math.floor((checkinRemainingSeconds % 3600) / 60);
    const s = checkinRemainingSeconds % 60;
    realtimeCountdown.textContent = 
      String(h).padStart(2, '0') + ':' + 
      String(m).padStart(2, '0') + ':' + 
      String(s).padStart(2, '0');
  }

  // Bulb status indicator
  function updateBulbStatus(isActive) {
    const bulbIcon = document.getElementById('bulbIcon');
    if (bulbIcon) {
      bulbIcon.classList.toggle('on', isActive);
      bulbIcon.classList.toggle('off', !isActive);
    }
  }

  // Poll check-in status every 5 seconds
  updateCheckinStatus();
  setInterval(updateCheckinStatus, 5000);

  // ================= Energy Day/Night Bar Chart =================
  let energyChartInstance = null;
  let energyChartEndDate = new Date(); // end date of 7-day range

  function toDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function formatShortDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d)} ${shortMonths[parseInt(m)-1]}`;
  }

  function formatTitleDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d)} ${shortMonths[parseInt(m)-1]} ${y}`;
  }

  async function fetchEnergyChartData() {
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(energyChartEndDate);
      d.setDate(d.getDate() - i);
      dates.push(toDateStr(d));
    }

    // Update title
    const titleEl = document.getElementById('energyChartTitle');
    if (titleEl) {
      titleEl.textContent = `${formatTitleDate(dates[0])} - ${formatTitleDate(dates[6])}`;
    }

    // Fetch all 7 days in parallel
    const results = await Promise.all(
      dates.map(async (date) => {
        try {
          const res = await fetch(`${API_BASE}/solar-size?date=${date}`);
          const json = await res.json();
          return { date, dayCost: json.dayCost ?? 0, nightCost: json.nightCost ?? 0 };
        } catch {
          return { date, dayCost: 0, nightCost: 0 };
        }
      })
    );

    return results;
  }

  async function renderEnergyChart() {
    const canvas = document.getElementById('energyDayNightChart');
    if (!canvas) return;

    const energySpinner = document.getElementById('energyChartSpinner');

    // For rooms without data, show empty chart
    if (!isRoomWithData(currentRoom)) {
      if (energySpinner) energySpinner.classList.remove('active');
      if (energyChartInstance) {
        energyChartInstance.data.datasets.forEach(ds => {
          ds.data = new Array(ds.data.length).fill(0);
        });
        energyChartInstance.update('none');
      }
      return;
    }

    // Show loading spinner
    if (energySpinner) energySpinner.classList.add('active');

    const data = await fetchEnergyChartData();
    const labels = data.map(d => formatShortDate(d.date));
    const dayCosts = data.map(d => d.dayCost);
    const nightCosts = data.map(d => d.nightCost);

    if (energyChartInstance) {
      energyChartInstance.destroy();
    }

    const ctx = canvas.getContext('2d');
    energyChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'กลางวัน',
            data: dayCosts,
            backgroundColor: 'rgba(245, 166, 35, 0.85)',
            borderColor: '#d4920a',
            borderWidth: 1,
            borderRadius: 3,
            barPercentage: 0.7,
            categoryPercentage: 0.65
          },
          {
            label: 'กลางคืน',
            data: nightCosts,
            backgroundColor: 'rgba(74, 111, 165, 0.85)',
            borderColor: '#35577a',
            borderWidth: 1,
            borderRadius: 3,
            barPercentage: 0.7,
            categoryPercentage: 0.65
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        layout: { padding: { left: 0, right: 10 } },
        animation: { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.8)',
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            callbacks: {
              label: function(ctx) {
                return ctx.dataset.label + ': ' + ctx.raw.toFixed(2) + ' THB';
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#555', font: { size: 9, weight: '600' } }
          },
          y: {
            grid: { color: 'rgba(0,0,0,0.06)' },
            beginAtZero: true,
            ticks: { 
              color: '#555', 
              font: { size: 9 },
              callback: function(v) { return v.toFixed(0); }
            },
            title: {
              display: true,
              text: 'THB',
              color: '#555',
              font: { size: 9, weight: '700' }
            }
          }
        }
      }
    });

    // Hide loading spinner
    if (energySpinner) energySpinner.classList.remove('active');
  }

  // Date navigation for energy chart
  const energyChartPrev = document.getElementById('energyChartPrev');
  const energyChartNext = document.getElementById('energyChartNext');

  if (energyChartPrev) {
    energyChartPrev.addEventListener('click', () => {
      energyChartEndDate.setDate(energyChartEndDate.getDate() - 7);
      renderEnergyChart();
    });
  }

  if (energyChartNext) {
    energyChartNext.addEventListener('click', () => {
      energyChartEndDate.setDate(energyChartEndDate.getDate() + 7);
      renderEnergyChart();
    });
  }

  // Initial render
  renderEnergyChart();

  // ================= Bill Comparison (Today vs Yesterday) =================
  async function fetchBillForDate(dateStr) {
    try {
      const res = await fetch(`${API_BASE}/daily-bill?date=${dateStr}`);
      if (!res.ok) return null;
      const json = await res.json();
      if (typeof json === 'number') return { electricity_bill: json, total_energy_kwh: json / 4.4 };
      if (json && typeof json.electricity_bill === 'number') return json;
      if (json && typeof json.electricity_bill === 'string') return { ...json, electricity_bill: parseFloat(json.electricity_bill) || 0 };
      return null;
    } catch (e) {
      console.error('fetchBillForDate error:', e);
      return null;
    }
  }

  function billDateLabel(dateStr) {
    const [y, m, d] = dateStr.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${parseInt(d)}/${months[parseInt(m)-1]}/${y}`;
  }

  async function updateBillCompare() {
    // Skip fetching for rooms without data
    if (!isRoomWithData(currentRoom)) return;

    const now = new Date();
    const todayStr = toDateStr(now);
    const yest = new Date(now); yest.setDate(yest.getDate() - 1);
    const yesterdayStr = toDateStr(yest);

    const [todayData, yesterdayData] = await Promise.all([
      fetchBillForDate(todayStr),
      fetchBillForDate(yesterdayStr)
    ]);

    const todayDateEl = document.getElementById('billTodayDate');
    const yesterdayDateEl = document.getElementById('billYesterdayDate');
    const todayDataEl = document.getElementById('billTodayData');
    const yesterdayDataEl = document.getElementById('billYesterdayData');
    const diffEl = document.getElementById('billDiffValue');

    if (yesterdayDateEl) yesterdayDateEl.textContent = billDateLabel(yesterdayStr);
    if (todayDateEl) todayDateEl.textContent = billDateLabel(todayStr);

    const todayBill = todayData ? (todayData.electricity_bill || 0) : 0;
    const todayUnit = todayData ? (todayData.total_energy_kwh || todayBill / 4.4) : 0;
    const yesterdayBill = yesterdayData ? (yesterdayData.electricity_bill || 0) : 0;
    const yesterdayUnit = yesterdayData ? (yesterdayData.total_energy_kwh || yesterdayBill / 4.4) : 0;

    if (yesterdayDataEl) yesterdayDataEl.innerHTML = `${yesterdayBill.toFixed(2)} THB.<br>${yesterdayUnit.toFixed(2)} Unit`;
    if (todayDataEl) todayDataEl.innerHTML = `${todayBill.toFixed(2)} THB.<br>${todayUnit.toFixed(2)} Unit`;

    if (diffEl) {
      const diff = todayBill - yesterdayBill;
      const arrowUp = `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 2L5 10h14L12 2z" fill="red"/></svg>`;
      const arrowDown = `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 22l7-8H5l7 8z" fill="green"/></svg>`;
      const color = diff >= 0 ? 'red' : 'green';
      const arrow = diff >= 0 ? arrowUp : arrowDown;
      diffEl.innerHTML = `
        <span>Daily Bill Change: </span>
        <span style="color:${color}; font-weight:bold;">${Math.abs(diff).toFixed(2)}฿</span>
        ${arrow}
      `;
    }
  }

  updateBillCompare();
  setInterval(updateBillCompare, 60000);

  async function updateBarsAndKW() {
    try {
      // Skip fetching for rooms without data
      if (!isRoomWithData(currentRoom)) return;

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const localDate = `${yyyy}-${mm}-${dd}`;

      // If we have a cached value (even if expired), render it immediately to make UI responsive
      if (cache.powerData !== null && cache.powerData !== undefined) {
        renderPowerData(cache.powerData);
      }

      // Prevent concurrent network requests
      if (cache._powerFetching) return;
      cache._powerFetching = true;

      // Fetch latest in background (stale-while-revalidate)
      fetch(`${API_BASE}/daily-energy/pm_doc?date=` + localDate)
        .then(res => res.json())
        .then(json => {
          const data = json.data || [];
          const last = data.length ? data[data.length - 1] : null;
          const latest = last ? (last.active_power_total ?? last.power ?? last.power_active ?? 0) : 0;
          cache.powerData = latest;
          cache.lastFetch['active_power_total'] = Date.now();
          renderPowerData(latest);
        })
        .catch(err => console.error('Error fetching power data:', err))
        .finally(() => { cache._powerFetching = false; });

    } catch (err) {
      console.error('Error in updateBarsAndKW:', err);
      cache._powerFetching = false;
    }
  }

  function renderPowerData(latest) {
    const totalPercent = Math.min((latest / total_maxKW) * 100, 100)

    if (totalDonutChart) {
      totalDonutChart.data.datasets[0].data = [totalPercent, 100 - totalPercent]

      const barColor = totalPercent <= 50 ? "#FBBF32" : "#b82500"
      totalDonutChart.data.datasets[0].backgroundColor = [barColor, "#e0e0e0"]
      totalDonutChart.data.datasets[0].borderColor = [barColor, "#e0e0e0"]

      totalDonutChart.update("none")
    }

    if (mainContainer && glowEl) {
      if (totalPercent <= 50) {
        mainContainer.style.boxShadow = "0 0 5px 2px #FBBF32, inset 0 0 20px 2px #F9B30F"
        glowEl.style.boxShadow = "0 0 6px 5px #FBBF32"
      } else {
        mainContainer.style.boxShadow = "0 0 10px 2px #b82500, inset 0 0 40px 2px #e63939"
        glowEl.style.boxShadow = "0 0 50px 20px rgba(230, 57, 57, 0.4)"
      }
    }

    if(glow){
      const intensity = totalPercent / 100;
      const glowAlpha = 0.3 + intensity * 0.7;
      const glowSize = 100 + intensity * 50;
      glow.style.transition = 'none';
      glow.style.background = `radial-gradient(circle, rgba(255,200,50,${glowAlpha}) 0%, rgba(255,200,50,0) 70%)`;
      glow.style.width = `${glowSize}%`;
      glow.style.height = `${glowSize}%`;
    }
  }

  initializeTotalDonut()
  updateBarsAndKW();
  // Reduce frequency to avoid network congestion on refresh; use stale-while-revalidate for immediacy
  setInterval(updateBarsAndKW, 2000);

  // ================= Daily Bill =================
  const dailyBillEl = document.getElementById('DailyBill');
  const unitEl = document.querySelector('.unit');
  const pricePerUnit = 4.4;

  // Fallback sample (provided) — used when network fetch fails or for testing
  const SAMPLE_DAILY_BILL = {
    date: "2025-11-18",
    samples: 275,
    total_energy_kwh: 106.5,
    avg_power_kw: 21.82,
    max_power_kw: 25.5,
    min_power_kw: 0,
    electricity_bill: 468.59,
    rate_per_kwh: 4.4
  };

  // fetchDailyBill(optionalDate)
  // optionalDate: can be a Date object or a YYYY-MM-DD string. If omitted, uses today.
  async function fetchDailyBill(optionalDate) {
    try {
      // Skip fetching for rooms without data
      if (!isRoomWithData(currentRoom)) return;

      // Render cached bill immediately if available
      if (cache.dailyBill !== null && cache.dailyBill !== undefined) {
        renderDailyBill(cache.dailyBill);
      }

      if (cache._dailyBillFetching) return;
      cache._dailyBillFetching = true;

      // prepare date string using local date (YYYY-MM-DD) to avoid UTC shift
      const toLocalDateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      let dateStr;
      if (optionalDate) {
        if (optionalDate instanceof Date) dateStr = toLocalDateStr(optionalDate);
        else dateStr = String(optionalDate);
      } else {
        dateStr = toLocalDateStr(new Date());
      }

      const url = `${API_BASE}/daily-bill?date=${dateStr}`;
      try {
        console.debug('[fetchDailyBill] fetching', url);
        const res = await fetch(url);
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${res.statusText} - ${txt}`);
        }
        const json = await res.json();
        console.debug('[fetchDailyBill] response', json);

        // Support two possible shapes: number or object
        let billValue = 0;
        if (typeof json === 'number') billValue = json;
        else if (json && typeof json.electricity_bill === 'number') billValue = json.electricity_bill;
        else if (json && typeof json.electricity_bill === 'string') billValue = parseFloat(json.electricity_bill) || 0;

        // If response looks empty, fallback to SAMPLE for that date
        if (!billValue && dateStr === SAMPLE_DAILY_BILL.date) {
          console.debug('[fetchDailyBill] using SAMPLE_DAILY_BILL fallback for', dateStr);
          billValue = SAMPLE_DAILY_BILL.electricity_bill;
        }

        cache.dailyBill = billValue;
        cache.lastFetch['dailyBill'] = Date.now();
        renderDailyBill(cache.dailyBill);
      } catch (err) {
        console.error('Error fetching daily bill (inner):', err);
        // network failed or remote errored — use fallback sample when date matches, otherwise try sample anyway
        try {
          if (dateStr === SAMPLE_DAILY_BILL.date) {
            cache.dailyBill = SAMPLE_DAILY_BILL.electricity_bill;
            cache.lastFetch['dailyBill'] = Date.now();
            renderDailyBill(cache.dailyBill);
          } else {
            // as a last resort, use the sample to keep UI populated for testing
            cache.dailyBill = SAMPLE_DAILY_BILL.electricity_bill;
            cache.lastFetch['dailyBill'] = Date.now();
            renderDailyBill(cache.dailyBill);
          }
        } catch (e) {
          console.error('Fallback render failed', e);
        }
      } finally {
        cache._dailyBillFetching = false;
      }

    } catch (err) {
      console.error('Error fetching daily bill:', err);
      if (dailyBillEl) dailyBillEl.textContent = '';
      if (unitEl) unitEl.textContent = '';
    }
  }

  function renderDailyBill(bill) {
    const units = bill / pricePerUnit;
    if (dailyBillEl) dailyBillEl.textContent = Number(bill).toFixed(2) + ' THB';
    if (unitEl) unitEl.textContent = Number(units).toFixed(2) + ' Unit';
  }

  // Expose helper for manual testing from browser console: e.g. `fetchDailyBill('2025-11-18')`
  window.fetchDailyBill = fetchDailyBill;

  // initial load and polling
  fetchDailyBill();
  setInterval(() => fetchDailyBill(), 10000);

 // ================= Chart.js (ไม่มี scrollbar + cache) =================
let chartInitialized = false;
let chart = null;
let currentDate = new Date();

// Cache ข้อมูลตามวัน
const dailyDataCache = {};

// ฟังก์ชัน format วันที่
function formatDateDisplay(date){
  const d = String(date.getDate()).padStart(2,'0');
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const m = monthNames[date.getMonth()];     
  const y = date.getFullYear();
  return `${d} - ${m} - ${y}`;
}

// ฟังก์ชัน fetch ข้อมูล
async function fetchDailyData(date){
  // Use local-date as cache key (YYYY-MM-DD)
  const localKey = (function(d){ const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; })(date);

  // ใช้ cache ถ้ามี
  if (dailyDataCache[localKey]) return dailyDataCache[localKey];

  const storageKey = `dailyData-${localKey}`;
  const STORAGE_TTL = 1000 * 60 * 15; // 15 minutes

  // Try localStorage first for immediate response
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ts && (Date.now() - parsed.ts < STORAGE_TTL)) {
        dailyDataCache[localKey] = parsed.data || [];
        // Refresh in background
        (async () => {
          try {
            // background refresh: fetch the UTC dates that might contain data for this local date
            const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const utcStart = new Date(localMidnight.getTime() - (localMidnight.getTimezoneOffset() * 60000));
            const utcEnd = new Date(utcStart.getTime() + 24 * 3600 * 1000 - 1);
            const startDateUTC = utcStart.toISOString().split('T')[0];
            const endDateUTC = utcEnd.toISOString().split('T')[0];
            const fetchDates = (startDateUTC === endDateUTC) ? [startDateUTC] : [startDateUTC, endDateUTC];
            let combined = [];
            for (const dstr of fetchDates) {
              try {
                const r = await fetch(`${API_BASE}/daily-energy/pm_doc?date=${dstr}`);
                const j = await r.json();
                combined = combined.concat(j.data ?? []);
              } catch(e) { /* ignore per-day failure */ }
            }
            // filter to utc window
            const filtered = combined.filter(it => {
              try { const ts = new Date(it.timestamp); return ts >= utcStart && ts <= utcEnd; } catch(e){ return false; }
            });
            dailyDataCache[localKey] = filtered;
            try { localStorage.setItem(storageKey, JSON.stringify({ ts: Date.now(), data: filtered })); } catch (e) { /* ignore */ }
          } catch (e) { /* background refresh failed */ }
        })();
        return dailyDataCache[localKey];
      }
    }
  } catch (e) {
    console.warn('dailyData localStorage read failed', e);
  }
  // Fallback to network (fetch UTC days covering this local date and filter)
  try {
    const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const utcStart = new Date(localMidnight.getTime() - (localMidnight.getTimezoneOffset() * 60000));
    const utcEnd = new Date(utcStart.getTime() + 24 * 3600 * 1000 - 1);
    const startDateUTC = utcStart.toISOString().split('T')[0];
    const endDateUTC = utcEnd.toISOString().split('T')[0];
    const fetchDates = (startDateUTC === endDateUTC) ? [startDateUTC] : [startDateUTC, endDateUTC];

    let combined = [];
    for (const dstr of fetchDates) {
      try {
        const res = await fetch(`${API_BASE}/daily-energy/pm_doc?date=${dstr}`);
        const json = await res.json();
        combined = combined.concat(json.data ?? []);
      } catch (e) {
        console.error('Error fetching daily-energy for', dstr, e);
      }
    }

    // filter to utc window
    const filtered = combined.filter(it => {
      try { const ts = new Date(it.timestamp); return ts >= utcStart && ts <= utcEnd; } catch(e){ return false; }
    });

    dailyDataCache[localKey] = filtered; // เก็บ cache keyed by local date
    try { localStorage.setItem(storageKey, JSON.stringify({ ts: Date.now(), data: filtered })); } catch (e) { /* ignore */ }
    return filtered;
  } catch(err){
    console.error(err);
    return [];
  }
}

// ฟังก์ชันช่วยสร้าง labels นาทีสำหรับวัน
function getMinuteLabels() {
  return Array.from({ length: 1440 }, (_, i) => {
    const hour = String(Math.floor(i / 60)).padStart(2,'0');
    const min = String(i % 60).padStart(2,'0');
    return `${hour}:${min}`;
  });
}

// ฟังก์ชัน update chart
async function updateChartData(date){
  if (!chart) return;

  const chartSpinner = document.getElementById('chartSpinner');

  // For rooms without data, clear the chart
  if (!isRoomWithData(currentRoom)) {
    if (chartSpinner) chartSpinner.classList.remove('active');
    chart.data.datasets.forEach(ds => {
      ds.data = new Array(ds.data.length).fill(null);
    });
    chart.update('none');
    return;
  }

  // Show loading spinner
  if (chartSpinner) chartSpinner.classList.add('active');

  const values = await fetchDailyData(date);

  // สร้าง array 1440 จุด (1 นาทีต่อจุด) สำหรับ total และแต่ละเฟส A/B/C
  const chartData = new Array(1440).fill(null);
  const phaseA = new Array(1440).fill(null);
  const phaseB = new Array(1440).fill(null);
  const phaseC = new Array(1440).fill(null);
  values.forEach(item => {
    const t = new Date(item.timestamp);
    // use UTC hours/minutes so data aligns with API timestamps (no local +7 shift)
    const idx = t.getUTCHours()*60 + t.getUTCMinutes();
    if (idx >= 0 && idx < chartData.length) {
      // total prefers `active_power_total` then fallbacks
      chartData[idx] = item.active_power_total ?? item.power ?? item.power_active ?? null;
      // per-phase values (may be undefined)
      phaseA[idx] = (item.active_power_a !== undefined) ? item.active_power_a : null;
      phaseB[idx] = (item.active_power_b !== undefined) ? item.active_power_b : null;
      phaseC[idx] = (item.active_power_c !== undefined) ? item.active_power_c : null;
    }
  });

  // คำนวณ Max / Avg
  let maxVal = null, maxIdx = null, sum = 0, count = 0;
  chartData.forEach((v,i)=>{
    if(v!==null){
      if(maxVal===null||v>maxVal){ maxVal=v; maxIdx=i; }
      sum += v; count++;
    }
  });
  const avgVal = count>0 ? sum/count : null;

  // Downsample for faster rendering if needed
  const MAX_POINTS = 360; // target max points to render
  const fullLength = chartData.length;
  if (fullLength > MAX_POINTS) {
    const factor = Math.ceil(fullLength / MAX_POINTS);
    const sampled = [];
    const sampledMax = new Array(Math.ceil(fullLength / factor)).fill(null);
    const sampledAvg = new Array(Math.ceil(fullLength / factor)).fill(null);
    const sampledA = new Array(Math.ceil(fullLength / factor)).fill(null);
    const sampledB = new Array(Math.ceil(fullLength / factor)).fill(null);
    const sampledC = new Array(Math.ceil(fullLength / factor)).fill(null);
    const labels = getMinuteLabels();
    const sampledLabels = [];
    for (let i = 0, si = 0; i < fullLength; i += factor, si++) {
      const windowStart = i;
      const windowEnd = Math.min(i + factor - 1, fullLength - 1);
      // compute local max within the window so the sampled line passes through peaks
      let localMax = null;
      for (let j = windowStart; j <= windowEnd; j++) {
        const v = chartData[j];
        if (v !== null && (localMax === null || v > localMax)) localMax = v;
      }
      sampled.push(localMax);
      // if the global max index falls within this sampled window, mark it here
      if (maxIdx !== null && maxIdx >= windowStart && maxIdx <= windowEnd) {
        sampledMax[si] = maxVal;
      } else {
        sampledMax[si] = null;
      }
      sampledAvg[si] = avgVal;
      // sample per-phase: pick local max within window per phase so peaks remain visible
      let localA = null, localB = null, localC = null;
      for (let j = windowStart; j <= windowEnd; j++) {
        const va = phaseA[j];
        const vb = phaseB[j];
        const vc = phaseC[j];
        if (va !== null && va !== undefined && (localA === null || va > localA)) localA = va;
        if (vb !== null && vb !== undefined && (localB === null || vb > localB)) localB = vb;
        if (vc !== null && vc !== undefined && (localC === null || vc > localC)) localC = vc;
      }
      sampledA[si] = localA;
      sampledB[si] = localB;
      sampledC[si] = localC;
      sampledLabels.push(labels[windowStart]);
    }
    chart.data.labels = sampledLabels;
    chart.data.datasets[0].data = sampled;
    chart.data.datasets[1].data = sampledMax;
    chart.data.datasets[2].data = sampledAvg;
    chart.data.datasets[3].data = sampledA;
    chart.data.datasets[4].data = sampledB;
    chart.data.datasets[5].data = sampledC;
  } else {
    chart.data.labels = getMinuteLabels();
    chart.data.datasets[0].data = chartData;
    chart.data.datasets[1].data = new Array(fullLength).fill(null).map((_,i)=>i===maxIdx?maxVal:null);
    chart.data.datasets[2].data = new Array(fullLength).fill(avgVal);
    chart.data.datasets[3].data = phaseA;
    chart.data.datasets[4].data = phaseB;
    chart.data.datasets[5].data = phaseC;
  }

  chart.update('none'); // อัปเดตแบบไม่มี animation

  // Hide loading spinner
  const chartSpinnerEnd = document.getElementById('chartSpinner');
  if (chartSpinnerEnd) chartSpinnerEnd.classList.remove('active');

  // Prefetch adjacent days to make quick navigation (<2s) for next/prev
  try { prefetchAdjacentDays(date, 2); } catch (e) { /* ignore */ }
}

// Prefetch helper: fetch surrounding days to warm cache
function prefetchAdjacentDays(date, range = 1) {
  for (let d = -range; d <= range; d++) {
    if (d === 0) continue;
    const dt = new Date(date);
    dt.setDate(dt.getDate() + d);
    // fire-and-forget
    fetchDailyData(dt).catch(() => {});
  }
}

// ================= Initialize Chart =================
// Small plugin to draw an adjustable X-axis title (allows shifting left/right)
const xAxisTitlePlugin = {
  id: 'xAxisTitlePlugin',
  afterDraw(chart, args, options) {
    try {
      const cfg = chart.options && chart.options.plugins && chart.options.plugins.xAxisTitle;
      if (!cfg || !cfg.text) return;
      const ctx = chart.ctx;
      const chartArea = chart.chartArea;
      // center, then apply pixel offset and optional relative offset (percent of width)
      const rel = (typeof cfg.relativeOffsetPercent === 'number') ? cfg.relativeOffsetPercent : 0;
      const x = chartArea.left + chartArea.width / 2 + (cfg.offset || 0) + Math.round(chartArea.width * rel);
      const y = chartArea.bottom + (cfg.padding || 24);
      ctx.save();
      ctx.fillStyle = cfg.color || '#000';
      ctx.font = (cfg.font || '12px sans-serif');
      ctx.textAlign = cfg.align || 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cfg.text, x, y);
      ctx.restore();
    } catch (e) {
      // ignore drawing errors
    }
  }
};
Chart.register(xAxisTitlePlugin);
// Small plugin to reset the last-displayed-label map before each update
const dedupeTickPlugin = {
  id: 'dedupeTickPlugin',
  beforeUpdate(chart) {
    chart._lastDisplayedLabel = {};
  }
};
Chart.register(dedupeTickPlugin);
function initializeChart() {
  if (chartInitialized) return;

  const canvas = document.getElementById('EnergyChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const labels = Array.from({ length: 1440 }, (_, i) => {
    const hour = String(Math.floor(i / 60)).padStart(2,'0');
    const min = String(i % 60).padStart(2,'0');
    return `${hour}:${min}`;
  });

  // Gradient
  const gradient = ctx.createLinearGradient(0,0,0,400);
  gradient.addColorStop(0,'rgba(139,69,19,0.4)');
  gradient.addColorStop(0.5,'rgba(210,180,140,0.3)');
  gradient.addColorStop(1,'rgba(245,222,179,0.1)');

  // สร้าง chart ทันทีด้วย data ว่าง
  const data = { 
    labels,
    datasets:[
      {label:'Power', data:new Array(1440).fill(null), borderColor:'#8B4513', backgroundColor: gradient, fill:true, borderWidth:0.5, tension:0.3, pointRadius:0},
      {label:'Max', data:new Array(1440).fill(null), borderColor:'#ff9999', pointRadius:5, pointBackgroundColor:'#ff9999', fill:false, showLine:false},
      {label:'Average', data:new Array(1440).fill(null), borderColor:'#000', borderDash:[5,5], fill:false, pointRadius:0, borderWidth:1},
      {label:'Phase A', data:new Array(1440).fill(null), borderColor:'#ff0000', backgroundColor:'rgba(255,0,0,0.06)', fill:false, pointRadius:0, borderWidth:1, hidden:true},
      {label:'Phase B', data:new Array(1440).fill(null), borderColor:'#ffd700', backgroundColor:'rgba(255,215,0,0.06)', fill:false, pointRadius:0, borderWidth:1, hidden:true},
      {label:'Phase C', data:new Array(1440).fill(null), borderColor:'#1e90ff', backgroundColor:'rgba(30,144,255,0.06)', fill:false, pointRadius:0, borderWidth:1, hidden:true}
    ]
  };

  const config = {
    type: 'line',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // add layout padding so custom x-axis title has room
      layout: { padding: { bottom: 44 } },
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x:{ 
          type:'category', 
          grid:{ display:false },
          ticks: {
            autoSkip: false,
            maxRotation: 0,
            minRotation: 0,
            color: '#2c1810',
            font: { size: 10 },
            // Show labels every 3 hours: 00.00, 03.00, 06.00, 09.00, 12.00, 15.00, 18.00, 21.00, 24.00
            callback: function(v) {
              const l = this.getLabelForValue(v);
              if (!l) return '';
              const [h, m] = l.split(':');
              const hour = parseInt(h, 10);
              const idx = Number(v);
              const labelsLen = (this.chart && this.chart.data && this.chart.data.labels) ? this.chart.data.labels.length : null;
              
              // Always allow the final label to be 24.00 (deduped per-scale)
              if (labelsLen !== null && idx === labelsLen - 1) {
                const scaleId = this.id || this.axis || 'x';
                const map = (this.chart && this.chart._lastDisplayedLabel) ? this.chart._lastDisplayedLabel : (this.chart._lastDisplayedLabel = {});
                if (map[scaleId] === '24.00') return '';
                map[scaleId] = '24.00';
                return '24.00';
              }

              // Show every 3 hours: 0, 3, 6, 9, 12, 15, 18, 21
              if (m === '00' && (hour % 3) === 0) {
                const labelToShow = `${String(h).padStart(2,'0')}.00`;
                const scaleId = this.id || this.axis || 'x';
                const map = (this.chart && this.chart._lastDisplayedLabel) ? this.chart._lastDisplayedLabel : (this.chart._lastDisplayedLabel = {});
                if (map[scaleId] === labelToShow) return '';
                map[scaleId] = labelToShow;
                return labelToShow;
              }
              return '';
            }
          },
          title: {
            // Disabled because we draw a custom x-axis title via xAxisTitlePlugin
            display: false,
            text: 'Time (HH:MM)',
            color: '#2c1810',
            font: { size: 12, weight: 'bold' }
          }
        },
        y: {
          beginAtZero: true,
          grid: { display: false },
          min: 0,
          ticks: { color: '#2c1810', font: { size: 10 } },
          title: { display: true, text: 'Power (kW)', color: '#2c1810', font: { size: 14, weight: 'bold' } }
        }
      }
    }
    ,
    // configure our custom x-axis title drawing
    plugins: []
  };

  chart = new Chart(ctx, config);
  chartInitialized = true;

  // make chart canvas clickable to open fullscreen view
  try {
    canvas.style.cursor = 'zoom-in';
    canvas.addEventListener('click', () => openChartFullscreen(chart));
  } catch (e) { /* ignore */ }

  // Create a single toggle button: when ON show Phase A/B/C, when OFF show total power
  (function createPhaseToggleButton(){
    try {
      const container = canvas.parentElement || document.querySelector('.Realtime_Container');
      if (!container) return;
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

      const btn = document.createElement('button');
      btn.id = 'phaseToggleBtn';
      btn.type = 'button';
      // initial label shows 'Total power' and graph displays Total by default
      btn.textContent = 'Total power';
      btn.setAttribute('aria-pressed', 'false');
      btn.style.cssText = 'position:absolute; right:12px; bottom:30px; background:#fffef8; color:#3b3305; border:1px solid #74640a; padding:4px 8px; border-radius:6px; font-size:11px; z-index:40; cursor:pointer; box-shadow:inset 0 1px 0 rgba(255,255,255,0.6), 0 2px 0 #3b3305; max-width:120px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

      // initial state: OFF -> show total, hide phases (datasets 3/4/5 hidden by default)
      btn.addEventListener('click', () => {
        const isOn = btn.getAttribute('aria-pressed') === 'true';
        const turnOn = !isOn;
        btn.setAttribute('aria-pressed', String(turnOn));
        btn.style.background = turnOn ? '#f5f5f5' : '#fff';
        // show current view label: when ON we show phases, label 'Phase balance'; when OFF show total label
        btn.textContent = turnOn ? 'Phase balance' : 'Total power';
        // when ON -> show phases and hide total
        if (chart && chart.data && chart.data.datasets) {
          chart.data.datasets[0].hidden = turnOn; // total
          chart.data.datasets[3].hidden = !turnOn; // phase A
          chart.data.datasets[4].hidden = !turnOn; // phase B
          chart.data.datasets[5].hidden = !turnOn; // phase C
          chart.update();
        }
        // show/hide legend accordingly
        try {
          const lg = container.querySelector('#phaseLegend');
          if (lg) lg.style.display = turnOn ? 'flex' : 'none';
        } catch (e) { /* ignore */ }
      });

      container.appendChild(btn);

      // set initial datasets visibility: show total, hide phases
      try {
        if (chart && chart.data && chart.data.datasets) {
          chart.data.datasets[0].hidden = false; // show total
          if (chart.data.datasets[3]) chart.data.datasets[3].hidden = true; // hide A
          if (chart.data.datasets[4]) chart.data.datasets[4].hidden = true; // hide B
          if (chart.data.datasets[5]) chart.data.datasets[5].hidden = true; // hide C
          chart.update();
        }
      } catch (e) { /* ignore */ }

      // Legend (center-bottom) showing phase color mapping — hidden by default
      const legend = document.createElement('div');
      legend.id = 'phaseLegend';
      legend.style.cssText = 'position:absolute; left:50%; transform:translateX(-50%); bottom:10px; display:none; gap:8px; align-items:center; z-index:40; font-size:10px; background:transparent; padding:0; border:none; box-shadow:none;';

      const legendItems = [
        { label: 'Phase A', color: '#ff0000' },
        { label: 'Phase B', color: '#ffd700' },
        { label: 'Phase C', color: '#1e90ff' }
      ];
      legendItems.forEach(it => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; align-items:center; gap:6px; color:#222;';
        const dot = document.createElement('span');
        dot.style.cssText = `width:10px; height:10px; border-radius:50%; display:inline-block; background:${it.color}; border:1px solid rgba(0,0,0,0.06);`;
        const txt = document.createElement('span');
        txt.textContent = it.label;
        txt.style.fontSize = '10px';
        item.appendChild(dot);
        item.appendChild(txt);
        legend.appendChild(item);
      });

      container.appendChild(legend);
      // hide legend by default (graph shows total initially)
      try { legend.style.display = 'none'; } catch (e) {}
    } catch (e) { /* ignore UI errors */ }
  })();

  // Responsive axis font sizing helper
  function getResponsiveSizes() {
    if (typeof window === 'undefined') return { x: 14, y: 14, titleFont: '14px sans-serif' };
    if (window.innerWidth <= 600) return { x: 9, y: 9, titleFont: '11px sans-serif' };
    return { x: 10, y: 10, titleFont: '12px sans-serif' };
  }

  function applyResponsiveAxisFontSizes(targetChart) {
    if (!targetChart || !targetChart.options || !targetChart.options.scales) return;
    const sizes = getResponsiveSizes();
    try {
      if (targetChart.options.scales.x && targetChart.options.scales.x.ticks) {
        targetChart.options.scales.x.ticks.font = Object.assign({}, targetChart.options.scales.x.ticks.font || {}, { size: sizes.x });
      }
      if (targetChart.options.scales.y && targetChart.options.scales.y.ticks) {
        targetChart.options.scales.y.ticks.font = Object.assign({}, targetChart.options.scales.y.ticks.font || {}, { size: sizes.y });
      }
      // also adjust plugin-drawn title font if present
      if (targetChart.options.plugins && targetChart.options.plugins.xAxisTitle) {
        targetChart.options.plugins.xAxisTitle.font = sizes.titleFont;
      }
      targetChart.update('none');
    } catch (e) { /* ignore */ }
  }

  // apply initially and on resize (debounced)
  applyResponsiveAxisFontSizes(chart);
  let __axisResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(__axisResizeTimer);
    __axisResizeTimer = setTimeout(() => {
      applyResponsiveAxisFontSizes(chart);
      try { applyResponsiveAxisFontSizes(window.reportChart); } catch (e) {}
    }, 150);
  });

  // โหลดข้อมูลวันปัจจุบันทันทีหลัง chart พร้อม
  // set custom x-axis title (nudge left a bit so it appears centered in container)
  // ปรับ offset สำหรับหน้าจอต่างๆ
  const screenWidth = window.innerWidth || 375;
  let baseOffset = -80; // default
  if (screenWidth <= 360) {
    // Samsung S8 และหน้าจอเล็กกว่า: เลื่อนขวา 20% เพิ่มจาก -40
    baseOffset = 32; // -40 + (360 * 0.2) = 32
  } else if (screenWidth <= 375) {
    baseOffset = -40;
  }
  chart.options.plugins.xAxisTitle = { text: 'Time (HH:MM)', offset: baseOffset, relativeOffsetPercent: 0.2, padding: 36, color: '#000', font: '14px sans-serif', align: 'center' };
  updateChartData(currentDate);
}

// ===== Fullscreen chart helper =====
let _fullscreenOverlay = null;
let _fullscreenChart = null;
function openChartFullscreen(sourceChart) {
  try {
    if (_fullscreenOverlay) return; // already open

    // overlay
    const overlay = document.createElement('div');
    overlay.id = 'chart-fullscreen-overlay';
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; z-index:9999;';

    // container for card-like look
    const card = document.createElement('div');
    card.style.cssText = 'width:90%; max-width:1200px; height:80%; background:#fffef8; border-radius:10px; padding:12px; box-shadow:0 10px 30px rgba(0,0,0,0.4); display:flex; flex-direction:column; position:relative;';

    // close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'position:absolute; right:12px; top:8px; background:#fff; border:1px solid #74640a; color:#3b3305; padding:6px 10px; border-radius:6px; cursor:pointer;';
    closeBtn.addEventListener('click', closeFullscreenChart);

    // canvas
    const bigCanvas = document.createElement('canvas');
    bigCanvas.id = 'EnergyChartFull';
    bigCanvas.style.cssText = 'flex:1; width:100%; height:100%; display:block;';

    card.appendChild(closeBtn);
    card.appendChild(bigCanvas);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // copy config and data to new chart
    const ctx = bigCanvas.getContext('2d');
    // Deep clone config but keep data references (we want same data snapshot)
    const cfg = JSON.parse(JSON.stringify(sourceChart.config));
    // ensure responsive false so canvas respects container size; we'll set maintainAspectRatio false
    cfg.options = cfg.options || {};
    cfg.options.responsive = true;
    cfg.options.maintainAspectRatio = false;

    // recreate datasets' hidden flags using sourceChart state (sourceChart.config may be canonical but ensure visibility)
    for (let i = 0; i < (cfg.data.datasets || []).length; i++) {
      cfg.data.datasets[i].hidden = sourceChart.data.datasets[i] && sourceChart.data.datasets[i].hidden ? true : false;
    }

    // create chart instance
    _fullscreenChart = new Chart(ctx, cfg);
    _fullscreenOverlay = overlay;

    // allow close with ESC or backdrop click
    function onKey(e) { if (e.key === 'Escape') closeFullscreenChart(); }
    function onBackdropClick(e) { if (e.target === overlay) closeFullscreenChart(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onBackdropClick);

    // store listeners for removal
    overlay._onKey = onKey;
    overlay._onBackdrop = onBackdropClick;
  } catch (e) { console.error('Open fullscreen chart failed', e); }
}

function closeFullscreenChart() {
  try {
    if (!_fullscreenOverlay) return;
    // remove listeners
    document.removeEventListener('keydown', _fullscreenOverlay._onKey);
    _fullscreenOverlay.removeEventListener('click', _fullscreenOverlay._onBackdrop);
    // destroy chart
    if (_fullscreenChart) try { _fullscreenChart.destroy(); } catch (e) {}
    // remove overlay
    try { document.body.removeChild(_fullscreenOverlay); } catch (e) {}
  } finally {
    _fullscreenOverlay = null;
    _fullscreenChart = null;
  }
}

// ================= Date Picker =================
const prevBtn = document.getElementById('prevDay');
const nextBtn = document.getElementById('nextDay');
const currentDayEl = document.getElementById('currentDay');

if (currentDayEl) currentDayEl.textContent = formatDateDisplay(currentDate);

function handleDateChange(delta){
  currentDate.setDate(currentDate.getDate()+delta);
  if (currentDayEl) currentDayEl.textContent = formatDateDisplay(currentDate);
  if(chartInitialized && chart) {
    // Start warming cache for adjacent days immediately
    prefetchAdjacentDays(currentDate, 2);
    updateChartData(currentDate);
  }
}

prevBtn?.addEventListener('pointerdown', e => { e.preventDefault(); handleDateChange(-1); });
nextBtn?.addEventListener('pointerdown', e => { e.preventDefault(); handleDateChange(1); });

// Preload today's chart data (non-blocking) to speed first render
fetchDailyData(currentDate).catch(() => {});
// โหลด chart ทันที
initializeChart();


  // ================= FullCalendar =================
  let calendar = null;
  let eventCache = {};

  async function fetchEvents(year, month) {
    const key = `${year}-${String(month).padStart(2, "0")}`;

    // Debug: ensure month param formatting and log
    const monthParam = String(month).padStart(2, '0');

    if (eventCache[key]) return eventCache[key];

    try {
      const url = `${API_BASE}/calendar?year=${year}&month=${monthParam}`;
      console.log('[fetchEvents] requesting', url);
      const res = await fetch(url);
      const data = await res.json();
      console.log('[fetchEvents] raw data:', data);

      // Normalize events: parse body (if present) to extract bill and energy values
      eventCache[key] = (data || []).map(e => {
        let parsed = {};
        try { parsed = typeof e.body === 'string' ? JSON.parse(e.body) : (e.body || {}); } catch (err) { parsed = e.body || {}; }

        // possible keys: electricity_bill, energy_kwh, bill, energy
        const billRaw = parsed.electricity_bill ?? parsed.bill ?? e.electricity_bill ?? e.bill ?? null;
        const energyRaw = parsed.energy_kwh ?? parsed.energy ?? e.energy_kwh ?? e.energy ?? null;

        const bill = billRaw !== null && billRaw !== undefined ? Number(billRaw) : null;
        const energy = energyRaw !== null && energyRaw !== undefined ? Number(energyRaw) : null;

        // Ensure the event has a `start` property FullCalendar can use.
        // Common API fields we check: start, date, datetime, timestamp (ISO or epoch), day
        let startVal = e.start || e.date || e.datetime || e.timestamp || e.day || parsed.date || parsed.datetime || parsed.timestamp;
        if (startVal !== undefined && startVal !== null) {
          try {
            // If numeric (epoch seconds or ms), convert to ISO
            if (typeof startVal === 'number') {
              // assume milliseconds if large
              startVal = new Date(startVal).toISOString();
            } else if (/^\d{10}$/.test(String(startVal))) {
              // 10-digit epoch -> seconds
              startVal = new Date(Number(startVal) * 1000).toISOString();
            } else {
              // try constructing Date and toISOString if possible
              const tmp = new Date(startVal);
              if (!isNaN(tmp.getTime())) startVal = tmp.toISOString();
            }
          } catch (e) { /* ignore conversion errors */ }
        }

        const out = Object.assign({}, e, {
          textColor: '#000',
          extendedProps: Object.assign({}, e.extendedProps || {}, {
            bill,
            energy,
            _rawBody: parsed,
            // ordering: put bill-containing events before plain-energy events
            _order: (bill !== null && !Number.isNaN(bill)) ? 0 : 1
          })
        });

        if (startVal) {
          out.start = startVal;
        } else {
          console.warn('[fetchEvents] event missing start/date/timestamp:', e);
        }

        return out;
      });

      console.log('[fetchEvents] normalized events:', eventCache[key]);
      return eventCache[key];
    } catch (err) {
      console.error("Error loading events:", err);
      eventCache[key] = [];
      return [];
    }
  }

  async function preloadInitialMonths() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    await fetchEvents(currentYear, currentMonth);

    let prevYear = currentYear;
    let prevMonth = currentMonth - 1;
    if (prevMonth === 0) { prevMonth = 12; prevYear--; }

    await fetchEvents(prevYear, prevMonth);
  }

  async function initializeCalendar() {
    const calendarEl = document.getElementById("calendar");
    if (!calendarEl) return;

    await preloadInitialMonths();

    calendar = new FullCalendar.Calendar(calendarEl, {
      initialView: "dayGridMonth",
      locale: "en",
      height: 600,
      headerToolbar: { left: "prev", center: "title", right: "next" },

      // Custom content for events: always show bill on top and unit below
      eventOrder: 'extendedProps._order',
      eventContent: function(arg) {
        try {
          const props = arg.event.extendedProps || {};
          const bill = (props.bill !== null && props.bill !== undefined) ? Number(props.bill).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ฿' : '';
          const energy = (props.energy !== null && props.energy !== undefined) ? Number(props.energy).toFixed(2) + ' Unit' : '';

          // Title may still be used for the event header; we display bill first then energy
          const titleHtml = arg.event.title ? `<div style="font-size:11px; font-weight:700; color:#2c1810;">${arg.event.title}</div>` : '';
          const billHtml = bill ? `<div style="font-size:12px; font-weight:800; color:#5a2b00; margin-top:4px;">${bill}</div>` : '';
          const energyHtml = energy ? `<div style="font-size:11px; color:#333;">${energy}</div>` : '';

          return { html: `${titleHtml}${billHtml}${energyHtml}` };
        } catch (e) {
          return { html: arg.event.title || '' };
        }
      },

      events: async function(fetchInfo, successCallback) {
        const year = fetchInfo.start.getFullYear();
        const month = fetchInfo.start.getMonth() + 1;

        const events = await fetchEvents(year, month);
        successCallback(events);
      },

      dateClick: async function(info) {
        try {
          const pricePerUnit = 4.4;
          const datePopup = document.getElementById("DatePopup");
          if (!datePopup) {
            console.warn('DatePopup element not found');
            return;
          }
          
          const popupDateEl = datePopup.querySelector(".popup-date");
          const popupBillEl = document.getElementById("popup-bill");
          const popupUnitEl = document.getElementById("popup-unit");

          if (!popupDateEl || !popupBillEl || !popupUnitEl) {
            console.warn('Popup elements not found');
            return;
          }

          datePopup.style.display = "flex";
          datePopup.classList.add("active");
          popupDateEl.textContent = info.dateStr;

          try {
            const res = await fetch(`${API_BASE}/daily-bill?date=${info.dateStr}`);
            const json = await res.json();
            const bill = json.electricity_bill ?? 0;
            const unit = bill / pricePerUnit;

            popupBillEl.textContent = `${bill.toFixed(2)} THB`;
            popupUnitEl.textContent = `${unit.toFixed(2)} Unit`;
          } catch (err) {
            console.error('Error fetching daily bill:', err);
            popupBillEl.textContent = "Error";
            popupUnitEl.textContent = "";
          }
        } catch (err) {
          console.error('Error in dateClick handler:', err);
        }
      }
    });

    calendar.render();
  }

  initializeCalendar();

  const calendarIcon = document.querySelector("#icons-frame #Calendar_icon");
  const calendarIconImg = document.querySelector("#icons-frame #Calendar_icon img");
  const popup = document.getElementById("calendarPopup");

  if (popup) {
    // Bind click on both the div and img for maximum compatibility
    const openCalendar = () => {
      popup.classList.add("active");
      calendar?.updateSize();
    };
    if (calendarIcon) calendarIcon.addEventListener("click", openCalendar);
    if (calendarIconImg) calendarIconImg.addEventListener("click", (e) => {
      e.stopPropagation(); // prevent double-fire
      openCalendar();
    });
    popup.addEventListener("click", e => {
      if (e.target === popup) popup.classList.remove("active");
    });
  }

  // ================= Room Booking =================
  const roomBookingIcon = document.querySelector("#RoomBooking_icon img");
  const roomBookingPopup = document.getElementById("roomBookingPopup");
  const roomBookingTitle = document.getElementById("roomBookingTitle");
  const confirmBookingBtn = document.getElementById("confirmBooking");
  const cancelBookingBtn = document.getElementById("cancelBooking");
  const bookingOverlay = document.getElementById("overlay");
  
  // Bookings data cache
  let bookingsDataByDate = {};
  
  // Fetch bookings from API
  async function fetchBookings(date, room) {
    try {
      const params = new URLSearchParams();
      if (date) params.append('date', date);
      if (room) params.append('room', room);
      
      const response = await fetch(`/api/bookings?${params.toString()}`);
      const result = await response.json();
      
      if (result.success) {
        // Group by date
        result.data.forEach(booking => {
          if (!bookingsDataByDate[booking.date]) {
            bookingsDataByDate[booking.date] = [];
          }
          // Check if already exists
          const exists = bookingsDataByDate[booking.date].find(b => b._id === booking._id);
          if (!exists) {
            bookingsDataByDate[booking.date].push({
              _id: booking._id,
              startTime: booking.startTime,
              endTime: booking.endTime,
              booker: booking.bookerName,
              color: booking.color
            });
          }
        });
        return result.data;
      }
      return [];
    } catch (error) {
      console.error('Error fetching bookings:', error);
      return [];
    }
  }
  
  // Generate schedule table for selected date
  async function generateScheduleTable(selectedDate) {
    const scheduleBody = document.getElementById("scheduleBody");
    const scheduleRoomName = document.getElementById("scheduleRoomName");
    const roomLabel = document.getElementById("Total_Bar_Label");
    
    if (!scheduleBody) return;
    
    // Set room name in header
    const roomName = roomLabel ? roomLabel.textContent : '';
    if (scheduleRoomName && roomLabel) {
      scheduleRoomName.textContent = roomLabel.textContent;
    }
    
    // Fetch bookings from API
    await fetchBookings(selectedDate, roomName);
    
    // Get bookings for selected date
    const bookingsData = bookingsDataByDate[selectedDate] || [];
    
    // Clear existing rows
    scheduleBody.innerHTML = "";
    
    // Generate time slots from 00:00 to 24:00
    const timeSlots = [];
    for (let hour = 0; hour <= 23; hour++) {
      timeSlots.push(`${hour.toString().padStart(2, '0')}:00`);
      timeSlots.push(`${hour.toString().padStart(2, '0')}:30`);
    }
    
    timeSlots.forEach(time => {
      const row = document.createElement("div");
      row.className = "schedule-row";
      
      const timeCell = document.createElement("div");
      timeCell.className = "schedule-time";
      timeCell.textContent = time;
      
      const slotCell = document.createElement("div");
      slotCell.className = "schedule-slot";
      
      // Check if this time slot is booked
      const booking = bookingsData.find(b => {
        const startMinutes = parseInt(b.startTime.split(':')[0]) * 60 + parseInt(b.startTime.split(':')[1]);
        const endMinutes = parseInt(b.endTime.split(':')[0]) * 60 + parseInt(b.endTime.split(':')[1]);
        const slotMinutes = parseInt(time.split(':')[0]) * 60 + parseInt(time.split(':')[1]);
        return slotMinutes >= startMinutes && slotMinutes < endMinutes;
      });
      
      if (booking) {
        slotCell.classList.add("booked");
        slotCell.style.backgroundColor = booking.color;
        // Only show name at start time
        if (time === booking.startTime) {
          slotCell.classList.add("booked-start");
          slotCell.textContent = booking.booker;
        }
      } else {
        slotCell.classList.add("available");
      }
      
      row.appendChild(timeCell);
      row.appendChild(slotCell);
      scheduleBody.appendChild(row);
    });
  }
  
  // Date navigation for schedule
  const schedulePrevDay = document.getElementById("schedulePrevDay");
  const scheduleNextDay = document.getElementById("scheduleNextDay");
  const bookingDateInput = document.getElementById("bookingDate");
  
  if (schedulePrevDay) {
    schedulePrevDay.addEventListener("click", () => {
      if (bookingDateInput && bookingDateInput.value) {
        const currentDate = new Date(bookingDateInput.value);
        currentDate.setDate(currentDate.getDate() - 1);
        bookingDateInput.value = currentDate.toISOString().split('T')[0];
        generateScheduleTable(bookingDateInput.value);
      }
    });
  }
  
  if (scheduleNextDay) {
    scheduleNextDay.addEventListener("click", () => {
      if (bookingDateInput && bookingDateInput.value) {
        const currentDate = new Date(bookingDateInput.value);
        currentDate.setDate(currentDate.getDate() + 1);
        bookingDateInput.value = currentDate.toISOString().split('T')[0];
        generateScheduleTable(bookingDateInput.value);
      }
    });
  }
  
  if (bookingDateInput) {
    bookingDateInput.addEventListener("change", () => {
      generateScheduleTable(bookingDateInput.value);
    });
  }

  if (roomBookingIcon && roomBookingPopup) {
    roomBookingIcon.addEventListener("click", () => {
      // Get room name from Total_Bar_Label
      const roomLabel = document.getElementById("Total_Bar_Label");
      const roomName = roomLabel ? roomLabel.textContent : "ไม่ระบุห้อง";
      if (roomBookingTitle) {
        roomBookingTitle.textContent = `จองห้อง: ${roomName}`;
      }
      // Set default date to today
      const bookingDateInput = document.getElementById("bookingDate");
      const todayDate = new Date().toISOString().split('T')[0];
      if (bookingDateInput) {
        bookingDateInput.value = todayDate;
      }
      // Generate schedule table for today
      generateScheduleTable(todayDate);
      
      roomBookingPopup.style.display = "flex";
      if (bookingOverlay) bookingOverlay.style.display = "block";
    });
  }

  if (cancelBookingBtn) {
    cancelBookingBtn.addEventListener("click", () => {
      roomBookingPopup.style.display = "none";
      if (bookingOverlay) bookingOverlay.style.display = "none";
    });
  }

  if (confirmBookingBtn) {
    confirmBookingBtn.addEventListener("click", async () => {
      const bookingDate = document.getElementById("bookingDate")?.value;
      const startTime = document.getElementById("bookingStartTime")?.value;
      const endTime = document.getElementById("bookingEndTime")?.value;
      const bookerName = document.getElementById("bookerName")?.value;
      const purpose = document.getElementById("bookingPurpose")?.value;
      const roomLabel = document.getElementById("Total_Bar_Label");
      const roomName = roomLabel ? roomLabel.textContent : "ไม่ระบุห้อง";
      
      if (!bookingDate || !bookerName) {
        alert("กรุณากรอกวันที่และชื่อผู้จอง");
        return;
      }
      
      if (!startTime || !endTime) {
        alert("กรุณาเลือกเวลาเริ่มและเวลาสิ้นสุด");
        return;
      }
      
      // Disable button while processing
      confirmBookingBtn.disabled = true;
      confirmBookingBtn.textContent = "กำลังจอง...";
      
      try {
        // Send booking to API
        const response = await fetch('/api/bookings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            room: roomName,
            date: bookingDate,
            startTime: startTime,
            endTime: endTime,
            bookerName: bookerName,
            purpose: purpose
          })
        });
        
        const result = await response.json();
        
        if (!result.success) {
          // Show error - booking conflict
          alert(`❌ ไม่สามารถจองได้\n${result.error}`);
          confirmBookingBtn.disabled = false;
          confirmBookingBtn.textContent = "ยืนยันการจอง";
          return;
        }
        
        // Booking successful
        const booking = result.data;
        
        // Add to local cache
        if (!bookingsDataByDate[bookingDate]) {
          bookingsDataByDate[bookingDate] = [];
        }
        bookingsDataByDate[bookingDate].push({
          _id: booking._id,
          startTime: booking.startTime,
          endTime: booking.endTime,
          booker: booking.bookerName,
          color: booking.color
        });
        
        // Create QR Code data - keep it short to avoid overflow
        const qrData = `BK:${booking.bookingId}`;
      
        // Hide booking popup
        roomBookingPopup.style.display = "none";
      
        // Show QR Code popup
        const qrPopup = document.getElementById("qrCodePopup");
        const qrContainer = document.getElementById("qrCodeContainer");
        const qrInfo = document.getElementById("qrBookingInfo");
      
        if (qrPopup && qrContainer) {
          // Clear previous QR
          qrContainer.innerHTML = "";
        
          // Set booking info
          if (qrInfo) {
            qrInfo.innerHTML = `<strong>ห้อง:</strong> ${roomName}<br>
              <strong>วันที่:</strong> ${bookingDate}<br>
              <strong>เวลา:</strong> ${startTime} - ${endTime}<br>
              <strong>ผู้จอง:</strong> ${bookerName}<br>
              <strong>รหัสการจอง:</strong> ${booking.bookingId}`;
          }
        
          // Generate QR Code using qrcodejs library
          try {
            if (typeof QRCode === 'undefined') {
              console.error('QRCode library not loaded');
              qrContainer.innerHTML = '<p style="color:red;">ไม่สามารถสร้าง QR Code ได้ (Library not loaded)</p>';
            } else {
              new QRCode(qrContainer, {
                text: qrData,
                width: 180,
                height: 180,
                colorDark: "#74640a",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.H
              });
              
              // Auto download entire QR popup as image (wait for QR to render)
              setTimeout(async () => {
                const qrContent = document.querySelector('.qrCodeContent');
                if (qrContent && typeof html2canvas !== 'undefined') {
                  try {
                    const canvas = await html2canvas(qrContent, {
                      backgroundColor: '#fffef5',
                      scale: 2,
                      useCORS: true
                    });
                    const link = document.createElement('a');
                    link.download = `Booking_${booking.bookingId}_${roomName}_${bookingDate}.png`;
                    link.href = canvas.toDataURL('image/png');
                    link.click();
                  } catch (err) {
                    console.error('html2canvas error:', err);
                  }
                }
              }, 600);
            }
          } catch (error) {
            console.error('QR Code error:', error);
            qrContainer.innerHTML = '<p style="color:red;">ไม่สามารถสร้าง QR Code ได้</p>';
          }
        
          qrPopup.style.display = "flex";
        }
        
        // Reset form
        document.getElementById("bookerName").value = "";
        document.getElementById("bookingPurpose").value = "";
        
      } catch (error) {
        console.error('Booking error:', error);
        alert("เกิดข้อผิดพลาดในการจอง กรุณาลองใหม่อีกครั้ง");
      } finally {
        confirmBookingBtn.disabled = false;
        confirmBookingBtn.textContent = "ยืนยันการจอง";
      }
    });
  }
  
  // Close QR Popup
  const closeQrBtn = document.getElementById("closeQrPopup");
  if (closeQrBtn) {
    closeQrBtn.addEventListener("click", () => {
      const qrPopup = document.getElementById("qrCodePopup");
      if (qrPopup) qrPopup.style.display = "none";
      if (bookingOverlay) bookingOverlay.style.display = "none";
    });
  }

  // ================= Custom Select Dropdown =================
  function initCustomSelect() {
    const customSelects = document.querySelectorAll(".custom-select");
    
    customSelects.forEach(selectContainer => {
      const selected = selectContainer.querySelector(".select-selected");
      const items = selectContainer.querySelector(".select-items");
      const hiddenInput = selectContainer.querySelector("input[type='hidden']");
      
      if (!selected || !items) return;
      
      // Click on selected to show/hide items
      selected.addEventListener("click", (e) => {
        e.stopPropagation();
        // Close all other dropdowns
        document.querySelectorAll(".select-items").forEach(item => {
          if (item !== items) item.classList.add("select-hide");
        });
        document.querySelectorAll(".select-selected").forEach(sel => {
          if (sel !== selected) sel.classList.remove("select-arrow-active");
        });
        
        items.classList.toggle("select-hide");
        selected.classList.toggle("select-arrow-active");
      });
      
      // Click on item to select it
      items.querySelectorAll("div").forEach(item => {
        item.addEventListener("click", () => {
          const value = item.getAttribute("data-value");
          selected.textContent = value;
          if (hiddenInput) hiddenInput.value = value;
          
          // Update selected style
          items.querySelectorAll("div").forEach(i => i.classList.remove("same-as-selected"));
          item.classList.add("same-as-selected");
          
          items.classList.add("select-hide");
          selected.classList.remove("select-arrow-active");
        });
      });
    });
    
    // Close dropdown when clicking outside
    document.addEventListener("click", () => {
      document.querySelectorAll(".select-items").forEach(item => {
        item.classList.add("select-hide");
      });
      document.querySelectorAll(".select-selected").forEach(sel => {
        sel.classList.remove("select-arrow-active");
      });
    });
  }
  
  // Initialize custom select
  initCustomSelect();

  // ================= Weather Sukhothai =================
  async function fetchCurrentWeatherSukhothai() {
    try {
      if (isCacheValid('weather', CACHE_DURATION.weather) && cache.weather) {
        renderWeather(cache.weather);
        return;
      }

      const lat = 17.0080, lon = 99.8238;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=Asia/Bangkok`;
      const res = await fetch(url);
      const data = await res.json();
      
      cache.weather = data.current_weather;
      cache.lastFetch['weather'] = Date.now();
      
      renderWeather(data.current_weather);

    } catch (e) {
      console.error("Error fetching current weather:", e);
      document.getElementById('weather-city').innerText = "";
      document.getElementById('weather-icon').innerText = "❓";
      document.getElementById('weather-temp').innerText = "-°C";
    }
  }

  function renderWeather(weather) {
    const weatherCode = weather.weathercode;
    const temp = weather.temperature;
    
    function weatherCodeToEmoji(code) {
      if (code === 0) return "☀️";
      if ([1,2,3].includes(code)) return "⛅";
      if ([45,48].includes(code)) return "🌫️";
      if ([51,53,55].includes(code)) return "🌦️";
      if ([56,57].includes(code)) return "🌧️";
      if ([61,63,65].includes(code)) return "🌧️";
      if ([66,67].includes(code)) return "🌧️";
      if ([71,73,75].includes(code)) return "🌧️";
      if (code === 77) return "❄️";
      if ([80,81,82].includes(code)) return "🌧️";
      if ([85,86].includes(code)) return "🌧️";
      if (code === 95) return "⛈️";
      if ([96,99].includes(code)) return "⛈️";
      return "🌡️";
    }
    
    document.getElementById('weather-city').innerText = "";
    document.getElementById('weather-icon').innerText = weatherCodeToEmoji(weatherCode);
    document.getElementById('weather-temp').innerText = temp.toFixed(1) + "°C";
  }

  fetchCurrentWeatherSukhothai();
  setInterval(fetchCurrentWeatherSukhothai, 300000);

  // ================= Kwang Solar Popup =================
  const kwangIcon = document.getElementById("Kwang_icon");
  const overlay = document.getElementById("overlay");
  const kwangPopup = document.getElementById("kwangPopup");
  const kwangPowerEl = document.getElementById("kwangPower");
  const kwangBillEl = document.getElementById("kwangBill");
  const kwangCapacityEl = document.getElementById("kwangCapacity");
  const kwangMonthEl = document.getElementById("kwangMonth");
  const kwangnigtEl = document.getElementById("kwangnight");
  const TOTEl = document.getElementById("kwangTOTEL");
  const kwangPeakEl = document.getElementById("kwangPeak");
  const kwangTOTdayBill = document.getElementById("kwangTOTBill");

  const prevBtnKwang = document.getElementById('kwangPrevDay');
  const nextBtnKwang = document.getElementById('kwangNextDay');
  const currentDayElKwang = document.getElementById('kwangCurrentDay');

  let kwangDate = new Date();

  function formatDate(date) {
    const d = String(date.getDate()).padStart(2, '0');
    const monthNames = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    const m = monthNames[date.getMonth()];
    const y = date.getFullYear();
    return `${d} - ${m} - ${y}`;
  }

  function updateKwangDateUI() {
    if (currentDayElKwang) {
      currentDayElKwang.textContent = formatDate(kwangDate);
    }
    fetchKwangData(kwangDate.toISOString().split('T')[0]);
  }

  if (kwangIcon && kwangPopup && overlay) {
    kwangIcon.addEventListener("click", () => {
      kwangPopup.classList.add("active");
      kwangPopup.style.display = "flex";
      overlay.style.display = "block";
      updateKwangDateUI();
    });

    overlay.addEventListener("click", () => {
      kwangPopup.style.display = "none";
      kwangPopup.classList.remove("active");
      overlay.style.display = "none";
    });
  }

  if (prevBtnKwang) {
    prevBtnKwang.addEventListener('click', () => {
      kwangDate.setDate(kwangDate.getDate() - 1);
      updateKwangDateUI();
    });
  }

  if (nextBtnKwang) {
    nextBtnKwang.addEventListener('click', () => {
      kwangDate.setDate(kwangDate.getDate() + 1);
      updateKwangDateUI();
    });
  }

  if (currentDayElKwang) {
    currentDayElKwang.addEventListener('click', () => {
      const tmpInput = document.createElement('input');
      tmpInput.type = 'date';
      tmpInput.value = kwangDate.toISOString().split('T')[0];
      tmpInput.style.position = 'absolute';
      tmpInput.style.opacity = 0;
      document.body.appendChild(tmpInput);
      tmpInput.focus();

      tmpInput.onchange = () => {
        kwangDate = new Date(tmpInput.value);
        updateKwangDateUI();
        document.body.removeChild(tmpInput);
      };

      tmpInput.click();
    });
  }

  async function fetchKwangData(date) {
    try {
      const res = await fetch(`${API_BASE}/solar-size?date=${date}`);
      const json = await res.json();

      if (kwangPowerEl) kwangPowerEl.textContent = (json.dayEnergy ?? 0).toFixed(2) + " Unit";
      if (kwangCapacityEl) kwangCapacityEl.textContent = (json.solarCapacity_kW ?? 0).toFixed(2) + " kW";
      if (kwangBillEl) 
        kwangBillEl.textContent = (json.savingsDay ?? 0)
          .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " THB";     
      if (kwangMonthEl) 
        kwangMonthEl.textContent = (json.savingsMonth ?? 0)
          .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " THB";     
      if (kwangnigtEl) kwangnigtEl.textContent = (json.nightEnergy ?? 0).toFixed(2) + " Unit";
      if (TOTEl) TOTEl.textContent = (json.totalEnergyKwh ?? 0).toFixed(2) + " Unit";
      if (kwangPeakEl) kwangPeakEl.textContent = (json.peakPowerDay ?? 0).toFixed(2) + " kW";
      if (kwangTOTdayBill) kwangTOTdayBill.textContent = (json.totalCost ?? 0).toFixed(2) + " THB";

    } catch (err) {
      if (kwangPowerEl) kwangPowerEl.textContent = "- Unit";
      if (kwangCapacityEl) kwangCapacityEl.textContent = "- kW";
      if (kwangBillEl) kwangBillEl.textContent = "- THB";
      if (kwangMonthEl) kwangMonthEl.textContent = "- THB";
      if (kwangnigtEl) kwangnigtEl.textContent = "- Unit";
      if (TOTEl) TOTEl.textContent = "- Unit";
      if (kwangPeakEl) kwangPeakEl.textContent = "- kW";
      if (kwangTOTdayBill) kwangTOTdayBill.textContent = "- THB";

      console.error("Fetch Kwang Data Error:", err);
    }
  }

  // ================= Daily Diff =================
  const dailyYesterdayEl = document.getElementById("dailyYesterday");
  const dailyDayBeforeEl = document.getElementById("dailyDayBefore");
  const dailyDiffEl = document.getElementById("dailyDiffValue");
  const dailyPopupEl = document.getElementById('dailyPopup');
  const overlayEl = document.getElementById('overlay');

  async function fetchDailyDiff() {
    try {
      const res = await fetch(`${API_BASE}/daily-diff`);
      const json = await res.json();
      return json;
    } catch (err) {
      console.error("Error fetching daily diff:", err);
      return null;
    }
  }

  function formatDateDMY(dateStr) {
    const date = new Date(dateStr);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  }

  async function updateDailyDiff() {
    const data = await fetchDailyDiff();
    if (!data) return;

    if (document.getElementById("yesterdayDate") && dailyYesterdayEl) {
      document.getElementById("yesterdayDate").innerHTML = `
        <strong>${formatDateDMY(data.yesterday.date)}</strong>
      `;
      dailyYesterdayEl.innerHTML = `
        ${data.yesterday.energy_kwh.toFixed(2)} Unit<br>
        ${data.yesterday.electricity_bill.toFixed(2)} THB.
      `;
    }

    if (document.getElementById("dayBeforeDate") && dailyDayBeforeEl) {
      document.getElementById("dayBeforeDate").innerHTML = `
        <strong>${formatDateDMY(data.dayBefore.date)}</strong>
      `;
      dailyDayBeforeEl.innerHTML = `
        ${data.dayBefore.energy_kwh.toFixed(2)} Unit<br>
        ${data.dayBefore.electricity_bill.toFixed(2)} THB.
      `;
    }

    if (dailyDiffEl) {
      const bill = data.diff.electricity_bill;

      const arrowUp = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                         <path d="M12 2L5 10h14L12 2z" fill="red"/>
                       </svg>`;
      const arrowDown = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                           <path d="M12 22l7-8H5l7 8z" fill="green"/>
                         </svg>`;

      const color = bill < 0 ? 'red' : 'green';
      const arrow = bill < 0 ? arrowUp : arrowDown;

      dailyDiffEl.innerHTML = `
        <div style="text-align:center; display:inline-flex; align-items:center; gap:6px;">
          <span>Daily Bill Change: </span>
          <span style="color:${color}; font-weight:bold;">
            ${Math.abs(bill).toFixed(2)}฿
          </span>
          <span class="arrow">${arrow}</span>
        </div>
      `;
    }

    if (dailyPopupEl && overlayEl) {
      dailyPopupEl.style.display = 'block';
      overlayEl.style.display = 'block';
    }
  }

  async function showDailyPopup() {
    if (dailyPopupEl && overlayEl) {
      overlayEl.style.display = 'block';
      dailyPopupEl.style.display = 'block';

      dailyPopupEl.classList.add('show-popup');
      dailyPopupEl.classList.remove('hide-popup');

      if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
      }

      await updateDailyDiff();
    }
  }

  function hideDailyPopup() {
    if (dailyPopupEl && overlayEl) {
      dailyPopupEl.style.display = 'none';
      overlayEl.style.display = 'none';
    }
  }

  if (overlayEl) overlayEl.addEventListener('click', hideDailyPopup);

  showDailyPopup();

// ================= Notification System (Updated) =================
const bellIcon = document.getElementById('Bell_icon');
const bellBadge = document.getElementById('bellBadge');
const notificationPopup = document.getElementById('notificationPopup');
const notificationItems = document.getElementById('notificationItems');

let notifications = [];
let currentFilter = 'all'; // 'all', 'peak', 'daily_diff', 'test'

// เปิด/ปิด popup
if (bellIcon && notificationPopup) {
  bellIcon.addEventListener('click', () => {
    const isHidden = notificationPopup.style.display === 'none' || !notificationPopup.style.display;
    notificationPopup.style.display = isHidden ? 'block' : 'none';
    
    if (isHidden) {
      loadNotifications();
    }
  });
}

// ปิด popup เมื่อคลิกข้างนอก
document.addEventListener('click', (e) => {
  if (bellIcon && notificationPopup && 
      !bellIcon.contains(e.target) && 
      !notificationPopup.contains(e.target)) {
    notificationPopup.style.display = 'none';
  }
});

// Note: `loadNotifications` is defined later with richer behavior
// and will be used. This placeholder is intentionally removed to
// avoid duplicate definitions.

// แสดง notifications ใน popup
// แทนที่ส่วน renderNotifications() ใน frontend script

function renderNotifications() {
  if (!notificationItems) return;

  // Empty state
  if (!notifications.length) {
    notificationItems.innerHTML = `
      <div style="text-align:center; padding:30px; color:#000;">
        <p style="font-size:24px; margin-bottom:10px;">🔔</p>
        <p>No Notifications</p>
      </div>
    `;
    return;
  }

  // Helper: format timestamp to date/time like '16 Nov 2025 07:00'
  const formatDateTime = iso => {
    if (!iso) return '-';
    // Use UTC getters so we display the timestamp exactly as the API provided (no local +7 shift)
    const d = new Date(iso);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mmNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mm = mmNames[d.getUTCMonth()];
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2,'0');
    const min = String(d.getUTCMinutes()).padStart(2,'0');
    return `${dd} ${mm} ${yyyy} ${hh}:${min}`;
  };

  // Clear
  notificationItems.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    padding: 14px 16px;
    border: 6px solid #74640a;
    border-radius: 10px;
    background: linear-gradient(180deg,#f8f6f0 0%,#fffef8 45%,#fff8e8 55%,#f5f0e5 100%);
    box-shadow: inset 0 0 5px rgba(0,0,0,0.15),1px 1px 0 #000,-4px 3px #3b3305,0 0 12px rgba(255,230,160,0.55);
    font-weight:700; text-align:center; font-family:Roboto,sans-serif; color:#000; margin-bottom:6px;
  `;
  header.innerHTML = '<strong style="font-size:16px; color:#000;">Notifications</strong>';
  notificationItems.appendChild(header);

  // Builder per type / parsed body
  const buildDetails = (n) => {
    let parsed = {};
    try { parsed = JSON.parse(n.body || '{}'); } catch(e) { parsed = {}; }

    // If body contains a power value -> show Peak style
    if (parsed.power !== undefined) {
      const val = Number(parsed.power) || 0;
      return `
        <div style="margin-top:8px;">
          <div style="font-size:12px; color:#666; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px;">Current peak power is ${val.toFixed(2)} kW</div>
          <div style="background:#fff2cc; padding:12px; border-radius:8px; border:1px solid #f1dca3; box-shadow:inset 0 1px 0 rgba(255,255,255,0.6);">
            <div style="font-weight:800; color:#7b4f00; font-size:18px;">Peak Power: ${val.toFixed(2)} kW</div>
          </div>
        </div>`;
    }

    // Daily energy report style — Bill on top, Unit below (locked order)
    if (parsed.energy_kwh !== undefined || parsed.electricity_bill !== undefined) {
      const e = parsed.energy_kwh ? Number(parsed.energy_kwh).toFixed(2) : '0.00';
      const bill = parsed.electricity_bill ? Number(parsed.electricity_bill).toFixed(2) : '0.00';
      const date = parsed.date || '-';
      return `
        <div style="margin-top:8px;">
          <div style="font-size:12px; color:#666; margin-bottom:6px;">Yesterday (${date})</div>
          <div style="background:#dff0d8; padding:12px; border-radius:8px; border:1px solid #c3e6cb; color:#155724; font-size:13px;">
            <div style="display:block;">
              <div style="font-size:12px; color:#155724;">Total Bill</div>
              <div style="font-weight:800; font-size:18px; margin-bottom:8px;">${bill} THB</div>
            </div>
            <div style="display:block;">
              <div style="font-size:12px; color:#155724;">Energy</div>
              <div style="font-weight:700; font-size:16px;">${e} Unit</div>
            </div>
            <div style="margin-top:8px; border-top:1px solid rgba(0,0,0,0.05); padding-top:8px; font-size:12px; color:#666;">Date: <strong style="color:#155724">${date}</strong></div>
          </div>
        </div>`;
    }

    // fallback: no special details
    return '';
  };

  notifications.forEach(n => {
    const card = document.createElement('div');
    card.className = 'notification-item';
    card.style.cssText = `
      padding:14px 15px; margin:8px 0; background:${n.read ? '#fff' : '#f8f9ff'}; border:1px solid #e6e6e6; border-radius:12px; cursor:pointer; transition:background .15s; box-shadow: 0 2px 4px rgba(0,0,0,0.1);`
    ;

    const ts = formatDateTime(n.timestamp);

    // Title + subtitle layout (no medicine bottle image)
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
        <div style="flex:1">
          <div style="font-family: 'Georgia', serif; font-weight:700; color:#5a2b00; font-size:16px; margin-bottom:6px;">${n.title || '(No title)'}</div>
        </div>
        ${n.read ? '' : '<span style="width:10px;height:10px;background:#667eea;border-radius:50%;display:inline-block;margin-top:4px;" title="Unread"></span>'}
      </div>
      <div style="font-size:12px; color:#8a7f77; margin-top:2px;">${n.subtitle || ''}</div>
      ${buildDetails(n)}
      <div style="margin-top:10px; text-align:right;">
        <small style="color:#999; font-size:11px;">${ts}</small>
      </div>
    `;

    card.addEventListener('mouseenter', () => { card.style.background = '#f1f2f6'; });
    card.addEventListener('mouseleave', () => { card.style.background = n.read ? '#fff' : '#f8f9ff'; });
    card.addEventListener('click', async () => {
      if (!n.read && typeof markAsRead === 'function') {
        await markAsRead(n.type, n._id);
        n.read = true; // optimistically update UI
        card.querySelector('span[title="Unread"]')?.remove();
        card.style.background = '#fff';
      }
    });

    notificationItems.appendChild(card);
  });
}

// แสดง error
function renderError() {
  if (!notificationItems) return;

  notificationItems.innerHTML = `
    <div style="text-align:center; padding:30px; color:#d9534f;">
      <p style="font-size:24px; margin-bottom:10px;">⚠️</p>
      <p>เกิดข้อผิดพลาดในการโหลดข้อมูล</p>
      <button onclick="loadNotifications()" style="margin-top:10px; padding:8px 16px; background:#667eea; color:white; border:none; border-radius:5px; cursor:pointer;">
        ลองใหม่
      </button>
    </div>
  `;
}

// Mark as read (single)
async function markAsRead(type, id) {
  try {
    const res = await fetch(`${API_BASE}/api/notifications/mark-read`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ids: [id] })
    });
    
    if (res.ok) {
      const notif = notifications.find(n => n._id === id);
      if (notif) notif.read = true;
      await loadNotifications();
    }
  } catch (err) {
    console.error('Mark as read failed:', err);
  }
}

// Mark all as read
async function markAllAsRead() {
  try {
    const res = await fetch(`${API_BASE}/api/notifications/mark-all-read`, {
      method: 'PATCH'
    });
    
    if (res.ok) {
      await loadNotifications();
    }
  } catch (err) {
    console.error('Mark all as read failed:', err);
  }
}

// อัปเดต badge และสั่น bell icon
function updateBadge(count) {
  if (!bellBadge || !bellIcon) return;
  // Update badge text and visibility
  bellBadge.textContent = count > 0 ? String(count) : '';
  bellBadge.style.display = count > 0 ? 'inline-block' : 'none';
  
  // ถ้ามี notification ใหม่ ให้สั่น bell icon
  if (count > 0) shakeBellIcon();
}

// ฟังก์ชันสั่น bell icon
function shakeBellIcon() {
  if (!bellIcon) return;
  
  // เพิ่ม CSS animation
  bellIcon.style.animation = 'shake 0.5s';
  bellIcon.style.animationIterationCount = '3';
  
  // ลบ animation หลังจากเสร็จ
  setTimeout(() => {
    bellIcon.style.animation = '';
  }, 1500);
}

// เพิ่ม CSS keyframes สำหรับ shake animation
if (!document.getElementById('bell-shake-style')) {
  const style = document.createElement('style');
  style.id = 'bell-shake-style';
  style.textContent = `
    @keyframes shake {
      0%, 100% { transform: rotate(0deg); }
      10%, 30%, 50%, 70%, 90% { transform: rotate(-10deg); }
      20%, 40%, 60%, 80% { transform: rotate(10deg); }
    }
    
    @keyframes shake-loop {
      0%, 100% { transform: rotate(0deg); }
      10% { transform: rotate(-15deg); }
      20% { transform: rotate(15deg); }
      30% { transform: rotate(-15deg); }
      40% { transform: rotate(15deg); }
      50% { transform: rotate(0deg); }
    }
  `;
  document.head.appendChild(style);
}
function startLoopShake() {
  setInterval(() => {
    shakeBellIcon();
    setTimeout(() => shakeCalendarIcon(), 500);
    setTimeout(() => shakeKwangIcon(), 1000);
  }, 10000); // สั่นทุก 10 วินาที
}

// เริ่มสั่น loop
startLoopShake();

// Service Worker message listener (สำหรับ real-time notification)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const { title, body } = event.data;
    
    // แสดง browser notification
    if (Notification.permission === 'granted') {
      new Notification(title, {
        body: body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-72.png'
      });
    }
    
    // สั่น bell icon
    shakeBellIcon();
    
    // โหลด notifications ใหม่
    loadNotifications();
  });
}


// เพิ่มใน frontend script (หลังจากส่วน bell icon shake)

// ================= Shake Calendar & Kwang Icons =================

// ฟังก์ชันสั่น Calendar icon
function shakeCalendarIcon() {
  const calendarIcon = document.querySelector("#Calendar_icon img");
  if (!calendarIcon) return;
  
  calendarIcon.style.animation = 'shake 0.5s';
  calendarIcon.style.animationIterationCount = '3';
  
  setTimeout(() => {
    calendarIcon.style.animation = '';
  }, 1500);
}

// ฟังก์ชันสั่น Kwang icon
function shakeKwangIcon() {
  const kwangIcon = document.querySelector("#Kwang_icon img");
  if (!kwangIcon) return;
  
  kwangIcon.style.animation = 'shake 0.5s';
  kwangIcon.style.animationIterationCount = '3';
  
  setTimeout(() => {
    kwangIcon.style.animation = '';
  }, 1500);
}

// เรียกใช้ทดสอบ (สั่นทุก 10 วินาที)
// setInterval(() => {
//   shakeCalendarIcon();
//   setTimeout(() => shakeKwangIcon(), 500); // สั่นทีละอัน
// }, 10000);

// หรือสั่นเมื่อมี event เฉพาะ เช่น:
// - Calendar icon สั่นเมื่อมี daily_diff notification
// - Kwang icon สั่นเมื่อมี daily_bill notification

// อัปเดตฟังก์ชัน updateBadge เพื่อสั่น icon ตาม type
function updateBadgeWithShake(count, latestType) {
  if (!bellBadge || !bellIcon) return;
  // Update badge text and visibility
  bellBadge.textContent = count > 0 ? String(count) : '';
  bellBadge.style.display = count > 0 ? 'inline-block' : 'none';

  if (count > 0) {
    shakeBellIcon();
    
    if (latestType === 'daily_diff') {
      setTimeout(() => shakeCalendarIcon(), 300);
    } else if (latestType === 'daily_bill') {
      setTimeout(() => shakeKwangIcon(), 300);
    } else if (latestType === 'peak') {
      // สั่นทั้ง 3 icon เมื่อเป็น peak notification
      setTimeout(() => shakeCalendarIcon(), 300);
      setTimeout(() => shakeKwangIcon(), 600);
    }
  }
}

// อัปเดตฟังก์ชัน loadNotifications เพื่อส่ง type ล่าสุด
async function loadNotifications() {
  try {
    console.log('Fetching notifications from API: /api/notifications/all?limit=50');
    const res = await fetch(`${API_BASE}/api/notifications/all?limit=50`);
    const data = await res.json();
    
    if (data.success) {
      console.log('Notifications fetched successfully:', data);
      notifications = data.data || [];
      
      // หา notification ล่าสุดที่ยังไม่อ่าน
      const latestUnread = notifications.find(n => !n.read);
      const latestType = latestUnread ? latestUnread.type : null;
      
      updateBadgeWithShake(data.unreadCount || 0, latestType);
      renderNotifications();
    } else {
      console.error('Failed to fetch notifications:', data);
      notifications = [];
      renderError();
    }
  } catch (err) {
    console.error('Error while fetching notifications:', err);
    notifications = [];
    renderError();
  }
}

// Service Worker message listener (อัปเดตเพื่อสั่น icon ตาม type)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const { title, body, type } = event.data;
    
    if (Notification.permission === 'granted') {
      new Notification(title, {
        body: body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-72.png'
      });
    }
    
    shakeBellIcon();
    
    if (type === 'daily_diff') {
      setTimeout(() => shakeCalendarIcon(), 300);
    } else if (type === 'daily_bill') {
      setTimeout(() => shakeKwangIcon(), 300);
    } else if (type === 'peak') {
      // สั่นทั้ง 3 icon เมื่อเป็น peak notification
      setTimeout(() => shakeCalendarIcon(), 300);
      setTimeout(() => shakeKwangIcon(), 600);
    }
    
    loadNotifications();
  });
}

// โหลด notifications ตอนเริ่มต้น
loadNotifications();

// Refresh ทุก 30 วินาที
setInterval(loadNotifications, 30000);

// ขอ permission สำหรับ notification
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// ขอ permission สำหรับ notification
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}
  // ================= Report Generation =================
  let reportDataCache = null; // Cache สำหรับเก็บข้อมูล report

  async function prepareReportData() {
    const currentDayElKwang = document.getElementById('kwangCurrentDay');
    if (!currentDayElKwang) return null;
    
    const rawDate = currentDayElKwang.textContent.trim(); 
    const [dayStr, monthStr, yearStr] = rawDate.split(' - ');
    const monthNames = ["January","February","March","April","May","June",
                        "July","August","September","October","November","December"];
    const month = String(monthNames.indexOf(monthStr) + 1).padStart(2,'0');
    const day = dayStr.padStart(2,'0');
    const year = yearStr;
    const apiDate = `${year}-${month}-${day}`;

    const res = await fetch(`${API_BASE}/solar-size?date=${apiDate}`);
    if (!res.ok) throw new Error("Network response was not ok");
    const json = await res.json();

    const energyRes = await fetch(`${API_BASE}/daily-energy/pm_doc?date=${apiDate}`);
    const energyJson = await energyRes.json();
    const energyData = energyJson.data || [];

    return { rawDate, apiDate, json, energyData };
  }

  async function renderReport(rawDate, apiDate, json, energyData) {
    const wrapper = document.getElementById("reportWrapper");
    if (!wrapper) return null;

    document.getElementById("kwangDateReport").textContent = rawDate;
    document.getElementById("kwangPowerReport").textContent = (json.dayEnergy ?? 0).toFixed(2) + " Unit";
    document.getElementById("kwangCapacityReport").textContent = (json.solarCapacity_kW ?? 0).toFixed(2) + " kW";
    document.getElementById("kwangBillReport").textContent = (json.savingsDay ?? 0).toFixed(2) + " THB";
    document.getElementById("kwangMonthReport").textContent = 
      (json.savingsMonth ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " THB";

    const tbody = document.querySelector("#kwangHourlyTable tbody");
    if (tbody) {
      tbody.innerHTML = "";
      if (json.hourly && json.hourly.length > 0) {
        json.hourly.forEach(hourData => {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${hourData.hour}</td><td>${hourData.energy_kwh}</td>`;
          tbody.appendChild(tr);
        });
      } else {
        tbody.innerHTML = '<tr><td colspan="2">No data</td></tr>';
      }
    }

    const reportCanvas = document.getElementById('EnergyChartReport');
    if (reportCanvas) {
      const reportCtx = reportCanvas.getContext('2d');
      
      if (window.reportChart) {
        window.reportChart.destroy();
      }

      const labels = Array.from({ length: 1440 }, (_, i) => {
        const hour = String(Math.floor(i / 60)).padStart(2,'0');
        const min = String(i % 60).padStart(2,'0');
        return `${hour}:${min}`;
      });

      const chartData = new Array(1440).fill(null);
      energyData.forEach(item => {
        const t = new Date(item.timestamp);
        // use UTC hours/minutes so report chart follows API timestamps (no local +7 shift)
        const idx = t.getUTCHours() * 60 + t.getUTCMinutes();
        if (idx >= 0 && idx < chartData.length) chartData[idx] = item.active_power_total ?? item.power ?? item.power_active ?? null;
      });

      let maxVal = null, maxIdx = null, sum = 0, count = 0;
      chartData.forEach((v, i) => {
        if (v !== null) {
          if (maxVal === null || v > maxVal) {
            maxVal = v;
            maxIdx = i;
          }
          sum += v;
          count++;
        }
      });
      const avgVal = count > 0 ? sum / count : null;

      const gradient = reportCtx.createLinearGradient(0, 0, 0, 300);
      gradient.addColorStop(0, 'rgba(139,69,19,0.4)');
      gradient.addColorStop(0.5, 'rgba(210,180,140,0.3)');
      gradient.addColorStop(1, 'rgba(245,222,179,0.1)');

      window.reportChart = new Chart(reportCtx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Power',
              data: chartData,
              borderColor: '#8B4513',
              backgroundColor: gradient,
              fill: true,
              borderWidth: 0.5,
              tension: 0.3,
              pointRadius: 0.1
            },
            {
              label: 'Max',
              data: new Array(1440).fill(null).map((_, i) => i === maxIdx ? maxVal : null),
              borderColor: '#ff9999',
              pointRadius: 5,
              pointBackgroundColor: '#ff9999',
              fill: false,
              showLine: false
            },
            {
              label: 'Average',
              data: new Array(1440).fill(avgVal),
                           borderColor: '#000',
              borderDash: [5,  5],
              fill: false,
              pointRadius: 0,
              borderWidth: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          animation: false,
          interaction: { mode: null },
          plugins: {
            legend: { display: true },
            tooltip: { enabled: false }
          },
          scales: {
            x: {
              type: 'category',
              grid: { display: false },
              ticks: {
                autoSkip: false,
                color: '#000',
                maxRotation: 0,
                minRotation: 0,
                callback: function(v) {
                  const l = this.getLabelForValue(v);
                  if (!l) return '';
                  const [h, m] = l.split(':');
                  return m === '00' && parseInt(h) % 3 === 0 ? l : '';
                }
              },
              title: {
                display: true,
                text: 'Time (HH:MM)',
                color: '#000',
                font: { size: 12, weight: 'bold' }
              }
            },
            y: {
              grid: { display: false },
              beginAtZero: true,
              min: 0,
              ticks: { color: '#000' },
              title: {
                display: true,
                text: 'Power (kW)',
                color: '#000',
                font: { size: 12, weight: 'bold' }
              }
            }
          }
        }
      });
    }

    wrapper.style.opacity = 1;
    wrapper.style.position = 'absolute';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '0';
    wrapper.style.visibility = 'visible';

    return new Promise((resolve) => {
      setTimeout(() => {
        html2canvas(wrapper, { scale: 1.5, useCORS: true, logging: false, allowTaint: false, removeContainer: false }).then(canvas => {
          wrapper.style.opacity = 0;
          wrapper.style.left = '-9999px';
          resolve({ canvas, apiDate, rawDate });
        });
      }, 500);
    });
  }

  const generateReportBtn = document.getElementById("generateReport");
  const reportModal = document.getElementById("reportActionModal");
  const downloadReportBtn = document.getElementById("downloadReportBtn");
  const shareReportBtn = document.getElementById("shareReportBtn");
  const cancelReportBtn = document.getElementById("cancelReportBtn");

  if (generateReportBtn && reportModal) {
    // กดปุ่ม Report แล้วแสดง Modal เลือก
    generateReportBtn.addEventListener("click", async () => {
      try {
        reportDataCache = await prepareReportData();
        if (!reportDataCache) return;
        reportModal.style.display = "block";
      } catch (err) {
        console.error("Prepare report failed:", err);
        alert("ไม่สามารถเตรียมรายงานได้ ลองใหม่อีกครั้ง");
      }
    });

    // ปุ่มโหลด
    if (downloadReportBtn) {
      downloadReportBtn.addEventListener("click", async () => {
        if (!reportDataCache) return;
        reportModal.style.display = "none";
        
        try {
          const { rawDate, apiDate, json, energyData } = reportDataCache;
          const result = await renderReport(rawDate, apiDate, json, energyData);
          if (!result) return;

          result.canvas.toBlob(blob => {
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `KwangReport-${result.apiDate}.png`;
            link.click();
            URL.revokeObjectURL(link.href);
          });
        } catch (err) {
          console.error("Download report failed:", err);
          alert("ไม่สามารถโหลดรายงานได้");
        }
      });
    }

    // ปุ่มแชร์
    if (shareReportBtn) {
      shareReportBtn.addEventListener("click", async () => {
        if (!reportDataCache) return;
        reportModal.style.display = "none";

        try {
          const { rawDate, apiDate, json, energyData } = reportDataCache;
          const result = await renderReport(rawDate, apiDate, json, energyData);
          if (!result) return;

          result.canvas.toBlob(blob => {
            const file = new File([blob], `KwangReport-${result.apiDate}.png`, { type: 'image/png' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              navigator.share({
                title: 'Kwang Solar Report',
                text: `รายงานพลังงานวันที่ ${result.rawDate}`,
                files: [file],
              }).catch(err => {
                console.error('Share failed:', err);
                alert("ไม่สามารถแชร์ได้ กรุณาลองอีกครั้ง");
              });
            } else {
              alert("อุปกรณ์นี้ไม่รองรับการแชร์");
            }
          });
        } catch (err) {
          console.error("Share report failed:", err);
          alert("ไม่สามารถแชร์รายงานได้");
        }
      });
    }

    // ปุ่มยกเลิก
    if (cancelReportBtn) {
      cancelReportBtn.addEventListener("click", () => {
        reportModal.style.display = "none";
      });
    }

    // คลิกนอก Modal
    reportModal.addEventListener("click", (e) => {
      if (e.target === reportModal) {
        reportModal.style.display = "none";
      }
    });
  }

  // ================= Info Icon Toggle =================
  const infoIcon = document.getElementById('info_icon');
  const mainConInfo = document.getElementById('maincon_info');

  if (infoIcon && mainConInfo) {
    infoIcon.addEventListener('click', () => {
      if (mainConInfo.style.display === 'none' || mainConInfo.style.display === '') {
        mainConInfo.style.display = 'block';
        setTimeout(() => {
          mainConInfo.style.opacity = '1';
        }, 10);
      } else {
        mainConInfo.style.opacity = '0';
        setTimeout(() => {
          mainConInfo.style.display = 'none';
        }, 400);
      }
    });
  }

  // =================== Room Switching Function ===================
  function switchRoom(roomName) {
    currentRoom = roomName;

    if (isRoomWithData(roomName)) {
      // --- Room with data: reload everything ---
      // 1. Reload main chart — clear cache for current date to force re-fetch
      if (chartInitialized && chart) {
        // Reset chart labels to full 1440 so updateChartData can rebuild properly
        chart.data.labels = getMinuteLabels();
        chart.data.datasets.forEach(ds => {
          ds.data = new Array(1440).fill(null);
        });
        chart.update('none');
        // Now fetch and render fresh data
        updateChartData(currentDate);
      }
      // 2. Reload daily bill
      cache.dailyBill = null;
      cache.lastFetch['dailyBill'] = 0;
      fetchDailyBill();
      // 3. Reload bill comparison
      updateBillCompare();
      // 4. Reload energy day/night chart
      renderEnergyChart();
      // 5. Reload total donut (power data)
      cache.powerData = null;
      cache.lastFetch['active_power_total'] = 0;
      updateBarsAndKW();
    } else {
      // --- Room without data: clear everything to empty ---
      // 1. Clear main chart
      if (chart && chart.data) {
        chart.data.datasets.forEach(ds => {
          ds.data = new Array(ds.data.length).fill(null);
        });
        chart.update('none');
      }
      // 2. Clear daily bill
      const dailyBillElRoom = document.getElementById('DailyBill');
      const unitElRoom = document.querySelector('.unit');
      if (dailyBillElRoom) dailyBillElRoom.textContent = '0.00 THB';
      if (unitElRoom) unitElRoom.textContent = '0.00 Unit';
      // 3. Clear bill comparison
      const billTodayData = document.getElementById('billTodayData');
      const billYesterdayData = document.getElementById('billYesterdayData');
      const billDiffValue = document.getElementById('billDiffValue');
      if (billTodayData) billTodayData.innerHTML = '0.00 Unit<br>0.00 THB.';
      if (billYesterdayData) billYesterdayData.innerHTML = '0.00 Unit<br>0.00 THB.';
      if (billDiffValue) billDiffValue.innerHTML = '<span>Daily Bill Change: </span><span style="font-weight:bold;">0.00฿</span>';
      // 4. Clear energy day/night chart
      if (energyChartInstance) {
        energyChartInstance.data.datasets.forEach(ds => {
          ds.data = new Array(ds.data.length).fill(0);
        });
        energyChartInstance.update('none');
      }
      // 5. Clear total donut
      if (totalDonutChart) {
        totalDonutChart.data.datasets[0].data = [0.01, 99.99];
        totalDonutChart.data.datasets[0].backgroundColor = ['#e0e0e0', '#f8f6f0'];
        totalDonutChart.data.datasets[0].borderColor = ['#e0e0e0', '#f8f6f0'];
        totalDonutChart.update('none');
      }
      // Clear glow effects
      if (mainContainer) mainContainer.style.boxShadow = 'none';
      if (glowEl) glowEl.style.boxShadow = 'none';
      if (glow) {
        glow.style.background = 'none';
        glow.style.width = '100%';
        glow.style.height = '100%';
      }
    }
  }

  // Expose for debugging
  window.switchRoom = switchRoom;

  // =================== Room Selector Dropdown ===================
  const roomLabel = document.getElementById('Total_Bar_Label');
  const roomDropdown = document.getElementById('roomDropdown');
  const roomDots = document.querySelectorAll('.room-dots .dot[data-room]');

  // Helper: update active dot to match room
  function updateRoomDots(roomName) {
    roomDots.forEach(d => {
      d.classList.toggle('active', d.dataset.room === roomName);
    });
  }

  // Helper: update dropdown selected state
  function updateDropdownSelected(roomName) {
    if (!roomDropdown) return;
    roomDropdown.querySelectorAll('.room-option').forEach(o => {
      o.classList.toggle('selected', o.dataset.room === roomName);
    });
  }

  // Helper: update label
  function updateRoomLabel(roomName) {
    if (roomLabel) roomLabel.innerHTML = roomName + ' <span class="room-arrow">▼</span>';
  }

  // Helper: full room UI switch (label + dots + dropdown + data)
  function selectRoom(roomName) {
    updateRoomLabel(roomName);
    updateRoomDots(roomName);
    updateDropdownSelected(roomName);
    // Update booking popup title if exists
    const roomBookingTitle = document.getElementById('roomBookingTitle');
    if (roomBookingTitle) roomBookingTitle.textContent = 'จองห้อง: ' + roomName;
    // Update schedule room name
    const scheduleRoomName = document.getElementById('scheduleRoomName');
    if (scheduleRoomName) scheduleRoomName.textContent = roomName;
    // Switch data
    switchRoom(roomName);
    // Refresh checkin
    if (typeof updateCheckinStatus === 'function') updateCheckinStatus();
  }

  if (roomLabel && roomDropdown) {
    // Toggle dropdown
    roomLabel.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = roomDropdown.style.display === 'block';
      roomDropdown.style.display = isOpen ? 'none' : 'block';
    });

    // Select room from dropdown
    roomDropdown.querySelectorAll('.room-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        roomDropdown.style.display = 'none';
        selectRoom(opt.dataset.room);
      });
    });

    // Close dropdown when clicking elsewhere
    document.addEventListener('click', () => {
      roomDropdown.style.display = 'none';
    });
  }

  // Room dots click handler
  roomDots.forEach(dot => {
    dot.addEventListener('click', () => {
      const roomName = dot.dataset.room;
      selectRoom(roomName);
    });
  });

  // Swipe left/right on page-track to change rooms
  (function setupRoomSwipe() {
    const track = document.querySelector('.page-track');
    if (!track) return;
    const roomList = ['ห้อง101โถงชั้น1', 'ห้อง200', 'ห้อง300'];
    let startX = 0;
    let dragging = false;
    const threshold = 80;

    function getCurrentRoomIndex() {
      return roomList.indexOf(currentRoom);
    }

    track.addEventListener('pointerdown', (e) => { dragging = true; startX = e.clientX || 0; }, { passive: true });
    track.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const endX = e.clientX || startX;
      const dx = endX - startX;
      if (Math.abs(dx) > threshold) {
        let idx = getCurrentRoomIndex();
        if (dx < 0 && idx < roomList.length - 1) selectRoom(roomList[idx + 1]);
        else if (dx > 0 && idx > 0) selectRoom(roomList[idx - 1]);
      }
    }, { passive: true });
    track.addEventListener('touchstart', (e) => { dragging = true; startX = (e.touches && e.touches[0].clientX) || 0; }, { passive: true });
    track.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const endX = (e.changedTouches && e.changedTouches[0].clientX) || startX;
      const dx = endX - startX;
      if (Math.abs(dx) > threshold) {
        let idx = getCurrentRoomIndex();
        if (dx < 0 && idx < roomList.length - 1) selectRoom(roomList[idx + 1]);
        else if (dx > 0 && idx > 0) selectRoom(roomList[idx - 1]);
      }
    }, { passive: true });
  })();

});
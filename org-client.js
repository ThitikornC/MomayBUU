// ==================== Momay Organization Client ====================
// Loads the current organization's rooms, meters and settings from /api/org/config.
// The server knows which organization this page is for (the /o/<slug>/ path sets a cookie),
// so the same files work for every organization.
(function () {
  'use strict';

  let loading = null;

  // Resolves to the config, or null if it can't be loaded (callers then use their built-in defaults)
  function load() {
    if (loading) return loading;
    loading = fetch('/api/org/config', { headers: { 'Accept': 'application/json' } })
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        const config = json && json.success ? json.data : null;
        window.MomayOrg.config = config;
        return config;
      })
      .catch(err => {
        console.warn('[org] config load failed', err);
        return null;
      });
    return loading;
  }

  function roomByKey(key) {
    const config = window.MomayOrg.config;
    return config ? config.rooms.find(r => r.key === key) || null : null;
  }

  window.MomayOrg = { config: null, load, roomByKey };
})();

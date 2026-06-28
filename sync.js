/* Live cross-device sync via Firebase Realtime Database REST API.
   Set the SAME sync code on two devices (phone app + PC browser) and they mirror each
   other. Only the /sync/<code> node is read/written. Last-writer-wins by a timestamp.
   No SDK, no API key — the databaseURL + rules scoped to /sync are all that's needed. */
window.SYLOX_SYNC = (function () {
  const DB = 'https://test-predictor-demo-default-rtdb.asia-southeast1.firebasedatabase.app';
  const KEY = 'sylox_sync_code';
  let code = null, getState = null, applyRemote = null, statusCb = null;
  let pollTimer = null, lastSeen = 0, pushT = null;

  const nodeUrl = () => DB + '/sync/' + encodeURIComponent(code) + '.json';
  const setStatus = s => { if (statusCb) statusCb(s); };

  async function push() {
    if (!code) return;
    try {
      const st = getState(); st._sync = Date.now();
      const r = await fetch(nodeUrl(), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st)
      });
      if (r.ok) { lastSeen = st._sync; setStatus('synced'); } else setStatus('err');
    } catch (e) { setStatus('offline'); }
  }
  function pushSoon() { if (!code) return; clearTimeout(pushT); pushT = setTimeout(push, 800); }

  async function pull() {
    if (!code) return;
    try {
      const r = await fetch(nodeUrl(), { cache: 'no-store' });
      if (!r.ok) { setStatus('err'); return; }
      const st = await r.json();
      if (st && st.v === 2 && (st._sync || 0) > lastSeen + 300) {
        lastSeen = st._sync || 0; applyRemote(st); setStatus('pulled');
      } else setStatus('synced');
    } catch (e) { setStatus('offline'); }
  }

  return {
    // getStateFn(): the current state object; applyFn(remoteState): load a remote update.
    enable(c, getStateFn, applyFn, statusFn) {
      code = c.trim(); getState = getStateFn; applyRemote = applyFn; statusCb = statusFn || null;
      localStorage.setItem(KEY, code); lastSeen = 0;
      if (pollTimer) clearInterval(pollTimer);
      setStatus('connecting');
      pull().then(() => { if (code) push(); });   // pull first; seed the node if empty/older
      pollTimer = setInterval(pull, 4000);
    },
    disable() { code = null; if (pollTimer) clearInterval(pollTimer); localStorage.removeItem(KEY); setStatus('off'); },
    pushSoon,
    savedCode() { return localStorage.getItem(KEY); },
    active() { return !!code; }
  };
})();

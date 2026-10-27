/* Live cross-device sync via Firebase Realtime Database REST API.
   Set the SAME sync code on two devices (phone app + PC browser) and they mirror each
   other. Only the /sync/<code> node is read/written. Every pull is MERGED by the page
   (applyRemote unions rounds + deletions and re-pushes if the server lacks anything), so
   simultaneous writes converge instead of last-writer-wins dropping a round.
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
      if (!code) return;                                   // disabled while the request was in flight
      if (st && st.v === 2) {                              // always merge — the page decides what's new
        lastSeen = st._sync || 0; setStatus(applyRemote(st) ? 'pulled' : 'synced');
      } else push();                                       // empty node: seed it
    } catch (e) { setStatus('offline'); }
  }

  return {
    // getStateFn(): the current state object; applyFn(remoteState): merge a remote copy in,
    // returning true if local data changed (and calling pushSoon itself if the remote is stale).
    enable(c, getStateFn, applyFn, statusFn) {
      code = c.trim(); getState = getStateFn; applyRemote = applyFn; statusCb = statusFn || null;
      localStorage.setItem(KEY, code); lastSeen = 0;
      if (pollTimer) clearInterval(pollTimer);
      setStatus('connecting');
      pull();                                      // merge first; applyFn pushes back whatever the node lacks
      pollTimer = setInterval(pull, 4000);
    },
    disable() { code = null; if (pollTimer) clearInterval(pollTimer); localStorage.removeItem(KEY); setStatus('off'); },
    pushSoon,
    savedCode() { return localStorage.getItem(KEY); },
    active() { return !!code; }
  };
})();

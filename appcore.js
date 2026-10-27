/* Shared app logic — the ONE implementation of how a round is predicted and scored, used by both
   the Android floating window (overlay.html) and the web tool (fairness_demo.html), so both show
   the exact same BET 7 / ENG 7 / NEW 4 numbers and hit rates for the same rounds.
   Pure (no DOM). Needs engine.js loaded first.

   Rows:  BET 7 = what to actually bet: the central baseline until ENG proves an edge (do no harm)
          ENG 7 = the evidence-gated engine's own picks (+ AI picks once those prove an edge)
          NEW 4 = the same engine aimed at the provably-fair commit-reveal result (it should fail)
   Every round is predicted BEFORE its result; replay (rebuildFrom) re-derives each round with the
   ENG tuning that was live at that time, so the history is never scored with hindsight. */
window.SYLOX_CORE = (function () {
  const K_OLD = 7, K_NEW = 4, CONF_THR = 0.15;   // CONF_THR = "the engine is sure" cutoff for the trust meter
  const ENGV = 3;   // bump when scoring changes -> stored stats are replayed once from the round log (v3: ENG row = raw live picks)
  const BASE7 = new Set(topK(PRIOR, K_OLD));     // the no-skill central-7 block (10-16)
  const dayKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

  function fresh() { return { v: 2, created: Date.now(), mode: 'sum', Hold: [], Hnew: [], reels: [],
    Wold: newWeights(), Wnew: newWeights(), Wr: [newWeights(), newWeights(), newWeights()],
    oH: 0, oR: 0, bH: 0, nH: 0, nR: 0, streak: 0, best: 0, days: {}, lastTs: null, rounds: [], del: [], lastExport: 0,
    engV: ENGV, engLog: [], aiN: 0, aiH: 0, aiB: 0,   // engLog = timestamped ENG re-tunes (synced); ai* = AI-pick track record
    t1N: 0, t1Hit: 0, t1SumP: 0, cHiN: 0, cHiHit: 0, shN: 0, shH: 0,   // trust meter + shadow (ENG hits, drives do-no-harm)
    seed: 'player-' + Math.floor(Math.random() * 1e9).toString(36) }; }
  // fill defaults on a loaded/imported state; null if it isn't a v2 test
  function normalize(s) {
    if (!s || s.v !== 2) return null;
    if (!s.rounds) s.rounds = []; if (!s.del) s.del = []; if (!s.engLog) s.engLog = []; if (s.lastExport == null) s.lastExport = 0;
    if (!s.Wold) s.Wold = newWeights(); if (!s.Wnew) s.Wnew = newWeights();
    if (!s.reels) s.reels = []; if (!s.Wr) s.Wr = [newWeights(), newWeights(), newWeights()]; if (!s.days) s.days = {};
    return s;
  }
  // true when the stored derived stats can't be trusted and must be replayed from the round log
  // (old engine version, missing trust meter, retired seed rounds, or the web tool's old format
  // that kept a pasted-history prefix in Hold)
  const needsRebuild = s => s.engV !== ENGV || s.t1N == null || s.shN == null ||
    s.rounds.some(r => r && r.seed) || (s.Hold || []).length !== s.rounds.length;

  // record one round's top-pick confidence + whether it landed (prequential)
  function trackTrust(o, pool, actual) { if (o.Hold.length < 12 || !pool) return;
    const t1 = topK(pool, 1)[0], t1p = pool[t1];
    o.t1N = (o.t1N || 0) + 1; o.t1SumP = (o.t1SumP || 0) + t1p; if (t1 === actual) o.t1Hit = (o.t1Hit || 0) + 1;
    if (t1p >= CONF_THR) { o.cHiN = (o.cHiN || 0) + 1; if (t1 === actual) o.cHiHit = (o.cHiHit || 0) + 1; } }
  // "DO NO HARM": bet the central baseline until ENG's shadow record proves an edge over it; then
  // trust it proportionally. Never sits below the central-7 baseline on structureless data.
  function trustK(s) { const sN = s.shN || 0; if (sN < 50) return 0;
    const sRate = (s.shH || 0) / sN, bRate = s.oR ? (s.bH / s.oR) : 0;
    return Math.max(0, Math.min(1, ((sRate - bRate) - 0.005) / 0.045)); }   // ramp 0..1 as edge goes ~0.5%->5%
  // BET = evidence-gated pool blended toward the prior by trustK. ENG row (fullList/fullPool) = the
  // engine's RAW live picks, so you can watch what it actually thinks every round; they are scored
  // as ENG's shadow record, and only reach BET once that record beats the baseline.
  function blendBet(full, s) { const k = trustK(s);
    const pool = full.pool ? full.pool.map((v, i) => (1 - k) * PRIOR[i] + k * (isFinite(v) ? v : PRIOR[i])) : full.pool;
    const raw = full.raw || full.pool;
    return { list: topK(pool, K_OLD), pool, fullPool: raw, dists: full.dists, fullList: full.rawList || full.list, k }; }
  // the ENG tuning that was live at time t (re-tunes apply forward only)
  function paramsAt(s, t) { let p = null; for (const e of (s.engLog || [])) if (e.t <= t) p = e; return p || {}; }
  // AI picks sway ENG only in proportion to the AI's own measured edge over the central baseline
  function aiTrust(s) { const n = s.aiN || 0; if (n < 30) return 0; return Math.max(0, Math.min(1, (((s.aiH || 0) - (s.aiB || 0)) / n) / 0.05)); }
  function engineFor(s, aiPicks, t) {
    let reel = null;
    if (s.reels && s.reels.length >= 12 && s.Wr) { try { reel = predictReels(s.reels, s.Wr, K_OLD); } catch (e) { reel = null; } }
    const p = paramsAt(s, t == null ? Date.now() : t);
    const params = { signals: p.signals, ai: aiPicks ? { picks: aiPicks, weight: p.aiWeight == null ? 0.5 : p.aiWeight } : null };
    const r = predictEng(s.Hold, s.Wold, K_OLD, params, reel && reel.sumDist, aiTrust(s));
    r.reel = reel; return r;
  }
  // the prediction for the NEXT round (before its result). withFair=false skips the commit-reveal
  // draw (replay supplies the stored Sylox result instead).
  function predictRound(s, aiPicks, t, withFair) {
    const eng = engineFor(s, aiPicks || null, t);
    return { n: s.rounds.length, ai: aiPicks || null, eng, old: blendBet(eng, s), reel: eng.reel,
      nw: predict(s.Hnew, s.Wnew, K_NEW), fair: withFair === false ? null : fairRound(s.seed, s.Hnew.length) };
  }
  function trackAi(o, picks, actual) { if (!picks) return; o.aiN = (o.aiN || 0) + 1;
    if (picks.indexOf(actual) >= 0) o.aiH = (o.aiH || 0) + 1; if (BASE7.has(actual)) o.aiB = (o.aiB || 0) + 1; }
  // Score + learn one round. entry: an existing round (replay) — otherwise a new one is created.
  // Returns the round's full story: what each row predicted and whether it landed.
  function applyRound(s, cur, actual, reels, entry) {
    const betHit = cur.old.list.indexOf(actual) >= 0, engHit = cur.old.fullList.indexOf(actual) >= 0;
    s.oR++; if (betHit) s.oH++; if (BASE7.has(actual)) s.bH++;
    if (s.Hold.length >= 12) { s.shN = (s.shN || 0) + 1; if (engHit) s.shH = (s.shH || 0) + 1; }   // ENG shadow record
    trackTrust(s, cur.old.fullPool, actual); trackAi(s, cur.ai, actual);
    updateEng(s.Wold, cur.eng, actual, K_OLD); s.Hold.push(actual);
    if (reels && cur.reel && s.Wr) { for (let r = 0; r < 3; r++) updateWeights(s.Wr[r], cur.reel.per[r].dists, reels[r], 3); s.reels.push(reels); }
    const res = entry ? entry.nr : cur.fair.result, ok = entry ? null : fairVerify(cur.fair), newHit = cur.nw.list.indexOf(res) >= 0;
    s.nR++; if (newHit) s.nH++; updateWeights(s.Wnew, cur.nw.dists, res, K_NEW); s.Hnew.push(res);
    s.streak = betHit ? s.streak + 1 : 0; if (s.streak > s.best) s.best = s.streak;
    const ts = entry ? entry.t : Date.now(); s.lastTs = ts; const dk = dayKey(ts);
    const dd = s.days[dk] || (s.days[dk] = { oH: 0, oR: 0, bH: 0 }); dd.oR++; if (betHit) dd.oH++; if (BASE7.has(actual)) dd.bH++;
    const e = entry || { t: ts, id: newRoundId(ts), s: actual, r: reels || null, oh: betHit, nr: res, nh: newHit, ai: cur.ai || null };
    s.rounds.push(e);
    return { i: s.rounds.length, t: ts, s: actual, r: reels || null, bet: cur.old.list.slice(), eng: cur.old.fullList.slice(),
      nw: cur.nw.list.slice(), nr: res, ai: cur.ai, betHit, engHit, newHit, aiHit: cur.ai ? cur.ai.indexOf(actual) >= 0 : null,
      ok, gate: cur.eng.trust, k: cur.old.k };
  }
  // Deterministically rebuild the full state by replaying a timestamped round log (undo, merge,
  // import, version upgrades). onRound(story) receives each replayed round, e.g. for a history table.
  function rebuildFrom(rounds, seed, created, engLog, onRound) {
    const np = fresh(); np.seed = seed; np.created = created; np.engLog = (engLog || []).slice();
    for (const e of rounds) {
      if (e.seed) continue;   // warm-up/seed rounds retired: never re-enter via sync
      const story = applyRound(np, predictRound(np, e.ai || null, e.t, false), e.s, e.r || null, e);
      if (onRound) onRound(story);
    }
    return np;
  }
  // Score an ENG tuning walk-forward on results H, counting only rounds from index `from` on (the
  // held-out window). The engine still learns from every round before each prediction, exactly as
  // live — only the scoring is restricted. Returns {h: ENG hits, b: central-7 hits, n: rounds scored}.
  function scoreTuning(H, signals, from) {
    let W = newWeights(), h = 0, b = 0, n = 0;
    for (let i = 0; i < H.length; i++) {
      const p = predictEng(H.slice(0, i), W, K_OLD, { signals });
      if (i >= from) { n++; if (p.rawList.indexOf(H[i]) >= 0) h++; if (BASE7.has(H[i])) b++; }
      updateEng(W, p, H[i], K_OLD);
    }
    return { h, b, n };
  }
  // Round identity: a per-round random id (two phones can tap in the same millisecond);
  // legacy rounds without one fall back to their timestamp.
  const newRoundId = ts => ts.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const rk = e => e.id || e.t;
  // union two round logs by id, chronological (id tie-break so every device replays the same
  // order); a round is dropped only if it is tombstoned in del (an undo on any device)
  function mergeRounds(a, b, del) {
    const m = new Map(), gone = new Set(del || []);
    for (const e of [...(a || []), ...(b || [])]) if (e && e.t != null && !e.seed && !gone.has(rk(e)) && !m.has(rk(e))) m.set(rk(e), e);
    return [...m.values()].sort((x, y) => (x.t - y.t) || String(rk(x)).localeCompare(String(rk(y))));
  }
  const unionDel = (a, b) => [...new Set([...(a || []), ...(b || [])])].sort((x, y) => x - y);
  function mergeLog(a, b) { const m = new Map(); for (const e of [...(a || []), ...(b || [])]) if (e && e.t != null && !m.has(e.id || e.t)) m.set(e.id || e.t, e);
    return [...m.values()].sort((x, y) => x.t - y.t); }
  // Merge a remote copy into local state P. Returns {state, localChanged, remoteStale}; state is a
  // rebuilt state when local data changed (else P itself).
  function mergeRemote(P, s) {
    const del = unionDel(P.del, s.del), merged = mergeRounds(P.rounds, s.rounds, del), log = mergeLog(P.engLog, s.engLog);
    const keys = a => (a || []).map(rk).join(',');
    const localChanged = keys(merged) !== keys(P.rounds) || del.length !== (P.del || []).length || log.length !== (P.engLog || []).length;
    const remoteStale = keys(merged) !== keys(s.rounds) || del.length !== (s.del || []).length || log.length !== (s.engLog || []).length;
    if (!localChanged) return { state: P, localChanged, remoteStale };
    const np = rebuildFrom(merged, P.seed || s.seed, Math.min(P.created || Date.now(), s.created || Date.now()), log);
    np.lastExport = Math.min(P.lastExport || 0, np.oR); np.mode = P.mode || s.mode || 'sum'; np._last = P._last; np.del = del;
    return { state: np, localChanged, remoteStale };
  }

  return { K_OLD, K_NEW, CONF_THR, BASE7, dayKey, fresh, normalize, needsRebuild, trackTrust, trustK, blendBet,
    paramsAt, aiTrust, engineFor, predictRound, applyRound, rebuildFrom, newRoundId, rk, mergeRounds, unionDel,
    mergeLog, mergeRemote, scoreTuning };
})();

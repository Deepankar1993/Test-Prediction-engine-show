/* Chamet Race engine — predicts which of the 3 cars wins from the ONE road shown before the race.
   Zero dependencies (plain JS), shared by the Android overlay. Pure logic + a small localStorage log.

   Model (fitted Oct 2026, see docs/car-race-progress.md):
     * every vehicle has a speed per road type (the radar on its "?" page, 0–400 scale);
     * a race is 3 equal segments, each a road type; race time = Σ 1/speed over the segments;
     * the game adds luck: each car's time is multiplied by exp(σ·z), z ~ N(0,1).
   With uniform roads and σ≈0.3 this reproduces all 9 published "Victory %" figures within ~2.5 pts.
   Before the race only one segment's road is shown, so P(win) averages over the 2 hidden segments
   (weighted by how often each road type has been seen) and integrates the luck term exactly.

   Honesty: every prediction is stored BEFORE the result and scored against two no-skill baselines —
   "fav" (best historical Victory %) and "crowd" (most money / lowest live odds) — with a Wilson CI.
   Simulated ceiling with 1 visible road: engine ~44% vs fav ~39% vs random 33%. */
window.SYLOX_RACE = (function () {
  const ROADS = ['Expressway', 'Highway', 'Dirt', 'Bumpy', 'Potholes', 'Desert'];
  // speed per road, same order as ROADS (radar charts, pixel-measured from the game, Oct 2026)
  const SPEED = {
    'ORV': [236, 227, 190, 188, 103, 161], 'Monster Truck': [222, 203, 141, 199, 157, 115],
    'SUV': [276, 254, 237, 161, 99, 122], 'Stock Car': [208, 211, 169, 169, 127, 173],
    'Car': [306, 275, 231, 161, 102, 118], 'ATV': [165, 162, 160, 148, 143, 142],
    'Motorcycle': [190, 180, 161, 164, 129, 122], 'Sports Car': [352, 319, 231, 142, 76, 88],
    'Supercar': [393, 364, 208, 130, 64, 76] };
  // the game's own long-run win rate per vehicle (its "?" page)
  const VICTORY = { 'ORV': 40.3, 'Monster Truck': 39.4, 'SUV': 38.9, 'Stock Car': 37.7, 'Car': 36.7,
    'ATV': 32.5, 'Motorcycle': 28.5, 'Sports Car': 25.4, 'Supercar': 21.4 };
  const SIGMA0 = 0.3, MIN_N = 80, LS = 'sylox_race_v1';
  const MEAN = ROADS.map((_, i) => Object.values(SPEED).reduce((a, v) => a + v[i], 0) / Object.keys(SPEED).length);
  const speedOf = n => SPEED[n] || MEAN;   // unknown new vehicle → average profile

  // ---- maths -------------------------------------------------------------------------------
  function Phi(x) {   // standard normal CDF (Abramowitz–Stegun 26.2.17, |err| < 7.5e-8)
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p; }
  const QZ = [], QW = []; (function () { let s = 0;   // 41-point grid for ∫ φ(z) f(z) dz on [-5, 5]
    for (let i = 0; i <= 40; i++) { const z = -5 + i * 0.25, w = Math.exp(-z * z / 2); QZ.push(z); QW.push(w); s += w; }
    for (let i = 0; i < QW.length; i++) QW[i] /= s; })();
  // P(each car fastest) for KNOWN race times T (log-normal luck σ): car i wins when every other car
  // is slower: ln Tj + σ zj > ln Ti + σ z  →  P = Φ((ln Tj − ln Ti)/σ − z) for each j, integrated over z
  function winProbs(T, sig) {
    const L = T.map(Math.log);
    return L.map((li, i) => { let p = 0;
      for (let q = 0; q < QZ.length; q++) { let f = QW[q];
        for (let j = 0; j < L.length; j++) if (j !== i) f *= Phi((L[j] - li) / sig - QZ[q]);
        p += f; }
      return p; });
  }
  // P(win) before the race: road `road` sits at segment `idx` (0–2), the other two are hidden and
  // drawn from `prior` (probabilities per road type). idx −1 / unknown road → all three hidden.
  function predict(cars, road, idx, params) {
    const sig = (params && params.sigma) || SIGMA0, prior = (params && params.prior) || ROADS.map(() => 1 / 6);
    const k = ROADS.indexOf(road), S = cars.map(speedOf), out = [0, 0, 0];
    const segs = [0, 1, 2].map(p => (k >= 0 && p === idx) ? [[k, 1]] : ROADS.map((_, r) => [r, prior[r]]));
    for (const [a, wa] of segs[0]) for (const [b, wb] of segs[1]) for (const [c, wc] of segs[2]) {
      const w = wa * wb * wc; if (!w) continue;
      const T = S.map(v => 1 / v[a] + 1 / v[b] + 1 / v[c]);
      winProbs(T, sig).forEach((p, i) => { out[i] += w * p; });
    }
    const tot = out.reduce((x, y) => x + y, 0) || 1;
    return out.map(p => p / tot);
  }

  // ---- parsing what the reader hands over ---------------------------------------------------------
  // "4.7/3.5" → {live:4.7, fixed:3.5}; "- /2.4" → {live:null, fixed:2.4}
  function parseOdds(s) { const m = /^\s*([\d.]+|-)?\s*\/\s*([\d.]+)/.exec(s || '');
    return { live: m && m[1] && m[1] !== '-' ? +m[1] : null, fixed: m ? +m[2] : null }; }
  const favOf = cars => cars.reduce((b, n) => ((VICTORY[n] || 0) > (VICTORY[b] || 0) ? n : b), cars[0]);
  function crowdOf(cars, odds) { let best = null, bo = Infinity;   // lowest live odds = most money on it
    cars.forEach((n, i) => { const o = odds[i] && odds[i].live; if (o != null && o < bo) { bo = o; best = n; } });
    return best; }
  // the house-rigging test: if the game quietly lets the car with the LEAST money win, this baseline
  // will beat everything else in the log (highest live odds = least money on it)
  function contraOf(cars, odds) { let best = null, bo = -Infinity;
    cars.forEach((n, i) => { const o = odds[i] && odds[i].live; if (o != null && o > bo) { bo = o; best = n; } });
    return best; }

  // ---- learning (forward only: params fitted on past races, used for the next ones) -----------------
  // road prior: how often each road type has been the revealed one (Laplace +2 so nothing is 0)
  function fitPrior(races) { const c = ROADS.map(() => 2);
    for (const r of races) { const k = ROADS.indexOf(r.road); if (k >= 0) c[k]++; }
    const s = c.reduce((a, b) => a + b, 0); return c.map(x => x / s); }
  // luck σ: the value that makes the logged winners most likely (grid search; needs some races)
  function fitSigma(races, prior) { if (races.length < 40) return SIGMA0;
    let best = SIGMA0, bl = -Infinity;
    for (let s = 0.1; s <= 0.71; s += 0.1) { let ll = 0;
      for (const r of races) { const i = r.cars.indexOf(r.winner); if (i < 0) continue;
        ll += Math.log(Math.max(1e-6, predict(r.cars, r.road, r.ri, { sigma: s, prior })[i])); }
      if (ll > bl) { bl = ll; best = Math.round(s * 100) / 100; } }
    return best; }

  // ---- log + scoring ---------------------------------------------------------------------------
  function load() { try { const s = JSON.parse(localStorage.getItem(LS)); if (s && s.v === 1) return s; } catch (e) {}
    return { v: 1, races: [], params: { sigma: SIGMA0, prior: ROADS.map(() => 1 / 6) } }; }
  function save(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch (e) {} }
  function wilson(h, n) { if (!n) return [0, 0]; const z = 1.96, p = h / n, d = 1 + z * z / n;
    const c = (p + z * z / (2 * n)) / d, m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, c - m), Math.min(1, c + m)]; }
  function stats(s) { const R = s.races.filter(r => r.winner); const n = R.length;
    const h = k => R.filter(r => r[k] === r.winner).length;
    // flat 1-unit bet on the engine's pick at the last live odds seen before the race
    let ret = 0, bets = 0; for (const r of R) { const o = r.pickOdds; if (o) { bets++; if (r.pick === r.winner) ret += o; } }
    const e = h('pick');
    return { n, eng: e, fav: h('fav'), crowd: h('crowd'), contra: h('contra'), ci: wilson(e, n), roi: bets ? (ret - bets) / bets : null, bets,
      ready: n >= MIN_N }; }

  // A betting-phase reading: predict now (it's re-done as odds move; the last one before the race counts).
  const NAME = /^[A-Za-z0-9 ]{1,24}$/;   // vehicle names as the game prints them; anything else is junk
  function forecast(s, st) {
    const cars = (st.cars || []).map(n => (NAME.test(n) ? n : '?')), odds = (st.odds || []).map(parseOdds);
    const road = ROADS.indexOf(st.road) >= 0 ? st.road : '', ri = road ? (+st.roadIdx | 0) : -1;
    st = Object.assign({}, st, { road, roadIdx: ri });
    const p = predict(cars, st.road, st.roadIdx, s.params);
    const pick = cars[p.indexOf(Math.max(...p))];
    const ev = cars.map((n, i) => odds[i].live ? p[i] * odds[i].live - 1 : null);
    return { t: Date.now(), cars, road: st.road, ri: st.roadIdx, odds: odds.map(o => o.live), fixed: odds.map(o => o.fixed),
      p: p.map(x => Math.round(x * 1000) / 1000), pick, pickOdds: odds[cars.indexOf(pick)].live, fav: favOf(cars),
      crowd: crowdOf(cars, odds), contra: contraOf(cars, odds), ev, cd: st.t };
  }
  // The result banner: score the last forecast for that same lineup, log it, refit for next time.
  function settle(s, pending, winner) {
    if (!pending || !NAME.test(winner || '') || pending.cars.indexOf(winner) < 0) return null;
    const r = Object.assign({}, pending, { winner }); delete r.ev;
    s.races.push(r);
    s.params.prior = fitPrior(s.races);
    // σ refit is the costly part: every 20 races, on the latest 200 (fast enough for a phone)
    if (s.races.length % 20 === 0) s.params.sigma = fitSigma(s.races.slice(-200), s.params.prior);
    save(s); return r;
  }
  return { ROADS, SPEED, VICTORY, SIGMA0, MIN_N, predict, winProbs, parseOdds, forecast, settle, stats, load, save, wilson };
})();
if (typeof module !== 'undefined') module.exports = window.SYLOX_RACE;

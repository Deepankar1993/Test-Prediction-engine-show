/* AI analyst for the ENG prediction (on demand or live), via the Claude API.
   Two jobs, both returning validated JSON (structured outputs):
     predict(ctx) -> {picks:[7 numbers], pattern_found, note}      the AI's own pick for the next round
     tune(ctx)    -> {signals:{..multipliers..}, ai_weight, pattern_found, note}   re-tunes the ENG params
   The page never trusts either blindly: picks are tracked as their own shadow row and only sway the
   ENG pool in proportion to the AI's MEASURED edge; tuned params apply to future rounds only.
   Zero dependencies (plain fetch). The API key + workspace live ONLY in this device's localStorage
   (never in the synced/exported test state). Spend is metered per calendar month against a budget. */
window.SYLOX_AI = (function () {
  const API = 'https://api.anthropic.com/v1/messages';
  const CFG_KEY = 'sylox_ai_cfg', USE_KEY = 'sylox_ai_usage';
  // $ per 1M tokens (input / output) — used for the on-device spend meter
  const MODELS = {
    'claude-opus-5-5':   { label: 'Opus 5.5',   in: 4.0, out: 20.0, fallbacks: true },
    'claude-sonnet-5-5': { label: 'Sonnet 5.5', in: 2.0, out: 10.0, fallbacks: true },
    'claude-haiku-5-5':  { label: 'Haiku 5.5',  in: 0.10, out: 0.50, fallbacks: false }
  };
  const DEFAULTS = { key: '', ws: '', model: 'claude-opus-5-5', mode: 'off', retuneEvery: 25, budget: 20 };
  const SIGNALS = ['marginal', 'freq', 'markov1', 'markov2', 'vomm', 'period', 'gap'];

  const read = (k, d) => { try { return Object.assign({}, d, JSON.parse(localStorage.getItem(k)) || {}); } catch (e) { return Object.assign({}, d); } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const month = () => new Date().toISOString().slice(0, 7);
  function cfg() { return read(CFG_KEY, DEFAULTS); }
  function setCfg(patch) { const c = Object.assign(cfg(), patch); write(CFG_KEY, c); return c; }
  function usage() { const u = read(USE_KEY, { month: month(), usd: 0, calls: 0 }); return u.month === month() ? u : { month: month(), usd: 0, calls: 0 }; }
  function ready() { const c = cfg(); return !!(c.key && c.ws && c.mode !== 'off'); }

  const SYSTEM =
    'You are the analyst inside a live prediction tool for a per-minute number game. Each round result is ' +
    'the SUM of three 0-9 digits (0-27; a fair game gives a fixed triangular distribution peaking at 13-14, ' +
    'where the 7 central numbers 10-16 cover about 52% by pure chance). You get the full result history ' +
    '(oldest first), optional per-reel digits, and the tool\'s own measured scores. ' +
    'Your job is to find REAL, exploitable structure (repeats, cycles, digit bias, conditional patterns, ' +
    'drifts) and act on it. Be rigorous and honest: on short samples apparent patterns are usually noise. ' +
    'If the evidence does not clearly beat the central baseline, say so (pattern_found=false) and stay close ' +
    'to the central numbers — a confident wrong call costs the user money. Never invent certainty. ' +
    'Keep "note" to one or two plain sentences the user will read on a phone.';

  const PICK_SCHEMA = { type: 'object', additionalProperties: false,
    required: ['picks', 'pattern_found', 'note'],
    properties: { picks: { type: 'array', items: { type: 'integer' } },
      pattern_found: { type: 'boolean' }, note: { type: 'string' } } };
  const TUNE_SCHEMA = { type: 'object', additionalProperties: false,
    required: ['signals', 'ai_weight', 'pattern_found', 'note'],
    properties: {
      signals: { type: 'object', additionalProperties: false, required: SIGNALS,
        properties: Object.fromEntries(SIGNALS.map(s => [s, { type: 'number' }])) },
      ai_weight: { type: 'number' }, pattern_found: { type: 'boolean' }, note: { type: 'string' } } };

  async function call(userText, schema, effort, maxTokens) {
    const c = cfg(), m = MODELS[c.model] || MODELS[DEFAULTS.model];
    if (!c.key || !c.ws) throw new Error('add your API key + workspace ID in AI settings');
    const u = usage(); if (u.usd >= (+c.budget || 0)) throw new Error(`monthly AI budget reached ($${u.usd.toFixed(2)})`);
    const body = { model: c.model, max_tokens: maxTokens, system: SYSTEM,
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: userText }] };
    const headers = { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01',
      'anthropic-workspace-id': c.ws, 'anthropic-dangerous-direct-browser-access': 'true' };
    const send = async (withFallback) => {
      const h = Object.assign({}, headers), b = Object.assign({}, body);
      if (withFallback) { h['anthropic-beta'] = 'server-side-fallback-2026-07-01'; b.fallbacks = 'default'; }
      return fetch(API, { method: 'POST', headers: h, body: JSON.stringify(b) });
    };
    let r = await send(m.fallbacks), j = await r.json().catch(() => ({}));
    if (r.status === 400 && m.fallbacks && /fallback/i.test(JSON.stringify(j))) { r = await send(false); j = await r.json().catch(() => ({})); }
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    const uu = j.usage || {}, cost = ((uu.input_tokens || 0) + (uu.cache_creation_input_tokens || 0)) * m.in / 1e6
      + (uu.cache_read_input_tokens || 0) * m.in * 0.1 / 1e6 + (uu.output_tokens || 0) * m.out / 1e6;
    const nu = usage(); nu.usd += cost; nu.calls++; write(USE_KEY, nu);
    if (j.stop_reason === 'refusal') throw new Error('the model declined this request');
    if (j.stop_reason === 'max_tokens') throw new Error('AI answer was cut off — try again');
    const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    try { return JSON.parse(txt); } catch (e) { throw new Error('AI returned unreadable output'); }
  }

  // ctx: {history:[sums], reels:[[a,b,c]..], stats:{...}, weights:{...}, params:{...}}
  function brief(ctx, ask) {
    const H = ctx.history.slice(-600);
    return [
      `Rounds so far: ${ctx.history.length} (showing last ${H.length}, oldest first):`,
      H.join(','),
      ctx.reels && ctx.reels.length ? `Per-reel digits for the last ${Math.min(ctx.reels.length, 200)} rounds that logged them: ` +
        ctx.reels.slice(-200).map(r => r.join('')).join(',') : 'No per-reel digits logged.',
      'Measured so far (walk-forward, never hindsight): ' + JSON.stringify(ctx.stats),
      'Engine signal weights it learned (higher = has been predicting better): ' + JSON.stringify(ctx.weights),
      'Current ENG tuning: ' + JSON.stringify(ctx.params),
      '', ask
    ].join('\n');
  }

  async function predict(ctx) {
    const out = await call(brief(ctx,
      'Give exactly 7 distinct numbers (0-27) most likely to be the NEXT result. If you see no real ' +
      'pattern, return the central numbers 10-16.'), PICK_SCHEMA, 'low', 8000);
    let picks = [...new Set((out.picks || []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 27))];
    for (const n of [13, 14, 12, 15, 11, 16, 10, 17, 9, 18]) { if (picks.length >= 7) break; if (!picks.includes(n)) picks.push(n); }
    return { picks: picks.slice(0, 7), pattern_found: !!out.pattern_found, note: String(out.note || '').slice(0, 300) };
  }

  async function tune(ctx) {
    const out = await call(brief(ctx,
      'Re-tune the ENG engine. The signals are: marginal (the fair central prior), freq (recently hot ' +
      'numbers), markov1/markov2 (what followed the last 1/2 results), vomm (longest repeating context ' +
      'match), period (cycles), gap (overdue numbers). Give a multiplier 0-3 for each (1 = unchanged, ' +
      '0 = mute it, >1 = trust it more) based on which kinds of structure the data actually shows. ' +
      'Also give ai_weight 0-1: how strongly YOUR per-round picks should be blended into ENG once they ' +
      'prove an edge. With no real pattern, keep multipliers near 1 and ai_weight low.'), TUNE_SCHEMA, 'medium', 16000);
    const signals = {};
    for (const s of SIGNALS) { const v = +out.signals?.[s]; signals[s] = isFinite(v) ? Math.max(0, Math.min(3, v)) : 1; }
    const w = +out.ai_weight;
    return { signals, aiWeight: isFinite(w) ? Math.max(0, Math.min(1, w)) : 0,
      pattern_found: !!out.pattern_found, note: String(out.note || '').slice(0, 400) };
  }

  return { cfg, setCfg, usage, ready, predict, tune, MODELS };
})();

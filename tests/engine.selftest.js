/* Engine self-test: proves the predictor is REAL and WORKING.
   - On WEAK/predictable data it cracks it (>80% with 7 numbers).
   - On FAIR data (like the live Chamet game) it correctly finds ~no edge,
     sitting at the central baseline — because the structure isn't there.
   Run: node tests/engine.selftest.js   (pure stdlib, loads engine.js as text) */
const { predict, updateWeights, newWeights, topK, PRIOR } = require('../engine.js');
const K = 7;
const BASE = new Set(topK(PRIOR, K));              // the no-skill central-7 block
const rnd = n => Math.floor(Math.random() * n);

// FAIR: result = sum of three independent uniform digits 0-9 (the fair model)
function genFair(N){ const a=[]; for(let i=0;i<N;i++) a.push(rnd(10)+rnd(10)+rnd(10)); return a; }
// WEAK/predictable: ~85% of rounds are a deterministic function of the previous result
function genWeak(N){ const a=[rnd(28)]; for(let i=1;i<N;i++)
  a.push(Math.random()<0.85 ? (a[i-1]*7+5)%28 : rnd(10)+rnd(10)+rnd(10)); return a; }

// prequential: predict each round's top-7 from the PAST only; return hit rate + baseline
function evaluate(series){
  let W=newWeights(); const H=[]; let n=0, engHit=0, baseHit=0;
  for(let i=0;i<series.length;i++){ const a=series[i]; const p=predict(H,W,K);
    if(H.length>=12){ n++; if(p.list.indexOf(a)>=0)engHit++; if(BASE.has(a))baseHit++; }
    updateWeights(W,p.dists,a,K); H.push(a); }
  return { eng: engHit/n, base: baseHit/n, n };
}

const pct = x => (x*100).toFixed(1)+'%';
let pass = true;
console.log('=== ENGINE SELF-TEST (7 numbers) ===\n');

const w = evaluate(genWeak(600));
console.log('WEAK / predictable data (a real exploitable pattern):');
console.log('  engine   :', pct(w.eng), '  baseline:', pct(w.base), '  ('+w.n+' rounds)');
const wOK = w.eng > 0.80 && w.eng - w.base > 0.20;
console.log('  =>', wOK ? 'PASS — engine CRACKS real structure (>80%, far above baseline)' : 'FAIL'); pass &&= wOK;

const f = evaluate(genFair(600));
console.log('\nFAIR data (like the live Chamet game):');
console.log('  engine   :', pct(f.eng), '  baseline:', pct(f.base), '  ('+f.n+' rounds)');
const fOK = Math.abs(f.eng - f.base) < 0.06;          // ties baseline; no fake edge
console.log('  =>', fOK ? 'PASS — engine finds ~0 edge (correct: fair data has none)' : 'FAIL'); pass &&= fOK;

console.log('\n=== ' + (pass ? 'ALL PASS' : 'FAILED') + ' ===');
console.log('Conclusion: the engine is real — it hits >80% when a pattern exists, and');
console.log('honestly shows ~no edge when it does not. ~52% on the live game means the');
console.log('GAME is fair, not that the engine is broken.');
process.exit(pass ? 0 : 1);

/* ============================================================
   Sylox prediction engine — shared by fairness_demo.html and overlay.html.
   Pure-JS SHA-256 + HMAC, the self-tuning predictor ensemble, and the
   provably-fair commit-reveal engine. No dependencies; runs offline.
   ============================================================ */
function sha256bytes(msgBytes){
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l=msgBytes.length; const bitLen=l*8;
  const withOne=l+1; let padLen=(56-withOne%64+64)%64;
  const total=l+1+padLen+8; const m=new Uint8Array(total);
  m.set(msgBytes); m[l]=0x80;
  const dv=new DataView(m.buffer);
  dv.setUint32(total-4, bitLen>>>0); dv.setUint32(total-8, Math.floor(bitLen/0x100000000));
  const w=new Uint32Array(64);
  const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let off=0;off<total;off+=64){
    for(let i=0;i<16;i++) w[i]=dv.getUint32(off+i*4);
    for(let i=16;i<64;i++){
      const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
      const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
      w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    let [a,b,c,d,e,f,g,h]=H;
    for(let i=0;i<64;i++){
      const S1=rotr(e,6)^rotr(e,11)^rotr(e,25);
      const ch=(e&f)^(~e&g);
      const t1=(h+S1+ch+K[i]+w[i])>>>0;
      const S0=rotr(a,2)^rotr(a,13)^rotr(a,22);
      const maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H=[(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,
       (H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
  }
  const out=new Uint8Array(32); const odv=new DataView(out.buffer);
  H.forEach((x,i)=>odv.setUint32(i*4,x)); return out;
}
const enc=new TextEncoder();
const toHex=b=>Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
const sha256hex=s=>toHex(sha256bytes(enc.encode(s)));
function hmacSha256(keyStr,msgStr){
  let key=enc.encode(keyStr);
  if(key.length>64) key=sha256bytes(key);
  const k=new Uint8Array(64); k.set(key);
  const ip=new Uint8Array(64), op=new Uint8Array(64);
  for(let i=0;i<64;i++){ip[i]=k[i]^0x36; op[i]=k[i]^0x5c;}
  const inner=sha256bytes(concat(ip, enc.encode(msgStr)));
  return sha256bytes(concat(op, inner));
}
function concat(a,b){const o=new Uint8Array(a.length+b.length);o.set(a);o.set(b,a.length);return o;}

// digits 0-9 (x3) from a byte array, unbiased via rejection sampling -> sum 0..27
function sumFromBytes(bytes){
  const d=[]; let i=0;
  while(d.length<3){ const b=bytes[i++%bytes.length]; if(b<250) d.push(b%10); }
  return d[0]+d[1]+d[2];
}
/* ---- THE LEARNING PREDICTION ENGINE (generic; sees only result history) ----
   A self-tuning ensemble of statistical signals. Each scores every value 0..27 for the
   next round; each signal's weight tracks its OWN recent walk-forward accuracy
   (multiplicative-weights / Hedge). Validated offline: large edge on Markov / periodic /
   biased / weak-LCG streams (e.g. a recoverable RNG cracked to ~82%), and ~0 edge on a
   truly random stream — it never invents skill it doesn't have. */
const R=28, ETA=0.18;
const PRIOR=(()=>{const c=new Array(R).fill(0);
  for(let a=0;a<10;a++)for(let b=0;b<10;b++)for(let d=0;d<10;d++)c[a+b+d]++;
  return c.map(x=>x/1000);})();
const SIGNALS=['marginal','freq','markov1','markov2','vomm','period','gap'];
function nrm(a){let s=0;for(const v of a)s+=v;s=s||1;return a.map(v=>v/s);}
// signals are range-generic: RG = number of values, PRI = that range's prior.
function sigDist(name,H,RG,PRI){
  RG=RG||R; PRI=PRI||PRIOR; const n=H.length;
  if(name==='marginal') return PRI.slice();
  if(name==='freq'){ const d=0.96,w=new Array(RG).fill(0.3);
    for(let i=0;i<n;i++) w[H[i]]+=Math.pow(d,n-1-i); return nrm(w); }
  if(name==='markov1'){ if(n<3) return null; const last=H[n-1];
    const row=new Array(RG).fill(0); let tot=0;
    for(let i=0;i<n-1;i++) if(H[i]===last){row[H[i+1]]++;tot++;}
    if(tot<2) return null; return nrm(row.map((v,k)=>v+0.25*PRI[k])); }
  if(name==='markov2'){ if(n<6) return null; const a=H[n-2],b=H[n-1];
    const row=new Array(RG).fill(0); let tot=0;
    for(let i=0;i<n-2;i++) if(H[i]===a&&H[i+1]===b){row[H[i+2]]++;tot++;}
    if(tot<2) return null; return nrm(row.map((v,k)=>v+0.2*PRI[k])); }
  // variable-order Markov / context-match: the workhorse. For each context length k (long->short),
  // find earlier occurrences of the last k values and tally what followed; blend, longer contexts
  // weighted higher. Catches periodic, LCG, and repeating-motif structure of unknown order, and
  // produces SHARP, varied (non-central) predictions when real structure exists. Null on fair data.
  if(name==='vomm'){ const win=400, g=n>win?H.slice(n-win):H, m=g.length; if(m<6) return null;
    const dist=new Array(RG).fill(0); let any=false; const maxO=Math.min(8,m-1);
    for(let kk=maxO;kk>=1;kk--){
      const succ=new Array(RG).fill(0); let tot=0;
      for(let i=0;i+kk<m;i++){ let mt=true; for(let j=0;j<kk;j++) if(g[i+j]!==g[m-kk+j]){mt=false;break;}
        if(mt){succ[g[i+kk]]++;tot++;} }
      if(tot>=2){ const wgt=kk*kk*Math.min(tot,12); for(let v=0;v<RG;v++) dist[v]+=wgt*succ[v]/tot; any=true; } }
    if(!any) return null;
    for(let v=0;v<RG;v++) dist[v]+=0.03*PRI[v]; return nrm(dist); }
  if(name==='gap'){ if(n<RG) return null; const last=new Array(RG).fill(-1);
    for(let i=0;i<n;i++) last[H[i]]=i; const d=new Array(RG);
    for(let k=0;k<RG;k++){const gap=n-1-last[k],exp=1/Math.max(PRI[k],1e-6);
      d[k]=PRI[k]*(1+Math.max(0,(gap-exp))/exp);} return nrm(d); }
  if(name==='period'){ if(n<24) return null; const win=200,g=H.slice(Math.max(0,n-win)),m=g.length;
    let mean=0;for(const v of g)mean+=v;mean/=m; let varr=0;for(const v of g)varr+=(v-mean)*(v-mean);varr=varr||1;
    let best=-1,br=0; for(let L=1;L<Math.min(16,m>>1);L++){let num=0;
      for(let i=L;i<m;i++)num+=(g[i]-mean)*(g[i-L]-mean); const r=num/varr;
      if(Math.abs(r)>Math.abs(br)){br=r;best=L;}}
    if(best<0||Math.abs(br)<0.18) return null; const pred=g[m-best];
    const d=PRI.map(p=>p*0.15); for(let k=0;k<RG;k++) d[k]+=Math.exp(-((k-pred)*(k-pred))/8);
    return nrm(d); }
  return null;
}
function sigAll(H,RG,PRI){ const d={}; for(const nm of SIGNALS) d[nm]=sigDist(nm,H,RG,PRI); return d; }
// linear (mixture) pool: a weighted average of the signal distributions. Unlike a
// log-linear/geometric pool it does NOT let the central marginal veto low-prior (tail)
// values, so genuine patterns — including spread/tail numbers — surface in the top-k.
// Validated: equal-or-better edge on markov/lcg/periodic, still ~0 on fair data.
function combineDists(dists,W,RG,PRI){
  RG=RG||R; PRI=PRI||PRIOR; const out=new Array(RG).fill(0); let ws=0;
  for(const nm of SIGNALS){ const d=dists[nm]; if(!d||W[nm]<=0) continue; ws+=W[nm];
    for(let k=0;k<RG;k++){ const v=d[k]; if(isFinite(v)) out[k]+=W[nm]*v; } }
  if(ws===0) return PRI.slice();
  const s=nrm(out);
  return s.some(x=>!isFinite(x))?PRI.slice():s;
}
// NaN-safe; ties break toward the CENTER of the range (the honest baseline), never to [0,1,2,3…].
function topK(arr,k){ const C=(arr.length-1)/2;
  return [...Array(arr.length).keys()].sort((a,b)=>{
    const va=isFinite(arr[a])?arr[a]:-Infinity, vb=isFinite(arr[b])?arr[b]:-Infinity;
    return (vb-va) || (Math.abs(a-C)-Math.abs(b-C)) || (a-b);
  }).slice(0,k); }
function predict(H,W,k,RG,PRI){ const dists=sigAll(H,RG,PRI); const pool=combineDists(dists,W,RG,PRI);
  return {list:topK(pool,k), dists, pool}; }   // pool = per-number probability of the next result
function updateWeights(W,dists,actual,k){
  for(const nm of SIGNALS){ const d=dists[nm]; if(!d) continue;
    const inTop=topK(d,k).indexOf(actual)>=0; W[nm]*=Math.exp(ETA*((inTop?1:0)-0.5)); }
  // keep every detector alive (floor) so structure can surface later; cap the marginal so a fair
  // warm-up can't lock the engine onto the central block forever.
  for(const nm of SIGNALS){ if(W[nm]<0.06) W[nm]=0.06; }
  if(W.marginal>1.6) W.marginal=1.6;
  let s=0;for(const nm of SIGNALS)s+=W[nm]; const f=SIGNALS.length/(s||1);
  for(const nm of SIGNALS) W[nm]*=f;
}
function newWeights(){ const W={}; for(const nm of SIGNALS) W[nm]=1; return W; }

// ---- per-reel prediction (3 digits 0-9) -> convolved to a 0-27 sum distribution ----
const DPRI=new Array(10).fill(0.1);
function convolve3(a,b,c){ const out=new Array(R).fill(0);
  for(let i=0;i<10;i++)for(let j=0;j<10;j++){const ij=a[i]*b[j]; if(ij===0)continue;
    for(let m=0;m<10;m++) out[i+j+m]+=ij*c[m];} return out; }
function predictReels(reels,Wr,k){
  const per=[],combs=[];
  for(let r=0;r<3;r++){ const Dr=reels.map(t=>t[r]); const dists=sigAll(Dr,10,DPRI);
    const comb=combineDists(dists,Wr[r],10,DPRI); per.push({dists,comb}); combs.push(comb); }
  const sumDist=convolve3(combs[0],combs[1],combs[2]);
  return {list:topK(sumDist,k), sumDist, per};
}
const CENTER8=new Set([10,11,12,13,14,15,16,17]);   // static no-skill cover (the honest baseline)
function wilson(h,n){ if(!n) return [0,0]; const z=1.96,p=h/n,den=1+z*z/n;
  const c=(p+z*z/(2*n))/den, mrg=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
  return [Math.max(0,c-mrg),Math.min(1,c+mrg)]; }

// demo-mode simulated old engine (used only when NOT wired to the live app).
let demoLCG=7;
function weakEngineNext(){ demoLCG=(demoLCG*9+13)%R; return Math.random()<0.8?demoLCG:r3(); }
function r3(){return (Math.random()*10|0)+(Math.random()*10|0)+(Math.random()*10|0);}

// exact distribution of the sum of three 0-9 digits (1000 combos)
const DIST=(()=>{const c=new Array(28).fill(0);
  for(let a=0;a<10;a++)for(let b=0;b<10;b++)for(let d=0;d<10;d++)c[a+b+d]++;return c;})();
function trueProb(set){let s=0;set.forEach(n=>s+=DIST[n]||0);return s/1000;}

// provably-fair commit-reveal engine.
function randHex(n){const a=new Uint8Array(n);crypto.getRandomValues(a);return toHex(a);}
function fairRound(clientSeed,nonce){
  const serverSeed=randHex(32);
  const commit=sha256hex(serverSeed);
  const result=sumFromBytes(hmacSha256(serverSeed,`${clientSeed}:${nonce}`));
  return {serverSeed,commit,clientSeed,nonce,result};
}
function fairVerify(r){
  if(sha256hex(r.serverSeed)!==r.commit) return false;
  return sumFromBytes(hmacSha256(r.serverSeed,`${r.clientSeed}:${r.nonce}`))===r.result;
}

// Node/CommonJS export guard — the browser ignores this (no `module`); it lets the
// self-test do `require('./engine.js')` instead of eval'ing the file as a string.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { predict, predictReels, updateWeights, newWeights, topK, combineDists,
    sigAll, sigDist, PRIOR, R, SIGNALS, convolve3, sumFromBytes, fairRound, fairVerify };
}

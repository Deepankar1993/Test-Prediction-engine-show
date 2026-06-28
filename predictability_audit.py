#!/usr/bin/env python3
"""
predictability_audit.py  —  Sylox Tech

Reads a column of game results from a CSV file or a SQLite database and runs a
battery of statistical tests for the one thing that matters in a result engine:
is the next result tied to the ones before it?  A fair engine passes every test.
A predictable engine — the kind expert players reach ~80% against — fails them.

No third-party packages. Python 3.8+ standard library only.

USAGE
  python predictability_audit.py results.csv
  python predictability_audit.py results.db --table rounds --column result
  python predictability_audit.py --make-samples        # writes fair + predictable test files
  python predictability_audit.py fair_sample.csv
  python predictability_audit.py predictable_sample.csv

The tool auto-detects CSV vs SQLite by file extension (.csv / .db / .sqlite).
"""

import sys, os, csv, math, sqlite3, argparse, random
from collections import Counter, defaultdict

# ---------------------------------------------------------------------------
# numerics (stdlib only): normal & chi-square tail probabilities
# ---------------------------------------------------------------------------
def norm_sf(z):                       # one-sided upper tail of standard normal
    return 0.5 * math.erfc(z / math.sqrt(2))

def _gser(a, x):                      # regularized lower incomplete gamma, series
    if x <= 0: return 0.0
    ap, s, d = a, 1.0 / a, 1.0 / a
    for _ in range(500):
        ap += 1; d *= x / ap; s += d
        if abs(d) < abs(s) * 1e-13: break
    return s * math.exp(-x + a * math.log(x) - math.lgamma(a))

def _gcf(a, x):                       # regularized upper incomplete gamma, cont. fraction
    FPMIN = 1e-300
    b, c, d = x + 1 - a, 1 / FPMIN, 1 / (x + 1 - a)
    h = d
    for i in range(1, 500):
        an = -i * (i - a); b += 2
        d = an * d + b;  d = FPMIN if abs(d) < FPMIN else d
        c = b + an / c;  c = FPMIN if abs(c) < FPMIN else c
        d = 1 / d; delt = d * c; h *= delt
        if abs(delt - 1) < 1e-13: break
    return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h

def chi2_sf(x, df):                   # P(chi2_df > x)
    if x <= 0 or df <= 0: return 1.0
    a = df / 2.0
    return 1.0 - _gser(a, x / 2.0) if (x / 2.0) < a + 1 else _gcf(a, x / 2.0)

# ---------------------------------------------------------------------------
# data loading
# ---------------------------------------------------------------------------
PREFERRED = ("result", "sum", "outcome", "value", "number", "roll", "results")

def load_csv(path, column=None):
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    if not rows: raise SystemExit("empty CSV")
    header, body = None, rows
    first = rows[0]
    if any(not _isnum(c) for c in first):       # looks like a header
        header, body = first, rows[1:]
    idx = 0
    if header:
        if column and column in header: idx = header.index(column)
        else:
            for p in PREFERRED:
                if p in [h.lower() for h in header]:
                    idx = [h.lower() for h in header].index(p); break
            else: idx = _last_numeric_col(body)
    else:
        idx = 0 if len(first) == 1 else _last_numeric_col(body)
    out = []
    for r in body:
        if idx < len(r) and _isint(r[idx]): out.append(int(float(r[idx])))
    return out, (header[idx] if header else f"col {idx}")

def load_sqlite(path, table=None, column=None):
    con = sqlite3.connect(path); cur = con.cursor()
    if not table:
        tbls = [r[0] for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")]
        if not tbls: raise SystemExit("no tables in database")
        table = tbls[0]
    cols = [r[1] for r in cur.execute(f"PRAGMA table_info({table})")]
    if not cols: raise SystemExit(f"table {table} not found / has no columns")
    if not column:
        low = [c.lower() for c in cols]
        column = next((cols[low.index(p)] for p in PREFERRED if p in low), cols[-1])
    vals = [r[0] for r in cur.execute(f"SELECT {column} FROM {table}")]
    con.close()
    return [int(v) for v in vals if _isint(v)], f"{table}.{column}"

def _isnum(s):
    try: float(s); return True
    except (ValueError, TypeError): return False
def _isint(s):
    try: return float(s) == int(float(s))
    except (ValueError, TypeError): return False
def _last_numeric_col(body):
    width = max(len(r) for r in body)
    for j in range(width - 1, -1, -1):
        if all(_isnum(r[j]) for r in body if j < len(r)): return j
    return 0

# ---------------------------------------------------------------------------
# theoretical distribution of sum-of-three-0..9-digits (for the bias test)
# ---------------------------------------------------------------------------
def sum3_dist():
    c = Counter()
    for a in range(10):
        for b in range(10):
            for d in range(10):
                c[a + b + d] += 1
    return {k: v / 1000 for k, v in c.items()}

# ---------------------------------------------------------------------------
# tests  -> each returns dict(name, stat, detail, p, passed)
# ---------------------------------------------------------------------------
ALPHA = 0.01    # flag a test when p < 1%

def t_distribution(x):
    if not all(0 <= v <= 27 for v in x):
        return {"name": "Marginal distribution (bias)", "skip":
                "values fall outside 0–27; not a 3-digit-sum game — skipped"}
    n = len(x); exp_p = sum3_dist(); obs = Counter(x)
    # merge categories until every expected count >= 5
    cats = sorted(exp_p); merged_o, merged_e, bucket_o, bucket_e = [], [], 0, 0.0
    for c in cats:
        bucket_o += obs.get(c, 0); bucket_e += exp_p[c] * n
        if bucket_e >= 5:
            merged_o.append(bucket_o); merged_e.append(bucket_e); bucket_o, bucket_e = 0, 0.0
    if bucket_e > 0:
        if merged_e: merged_o[-1] += bucket_o; merged_e[-1] += bucket_e
        else: merged_o.append(bucket_o); merged_e.append(bucket_e)
    chi = sum((o - e) ** 2 / e for o, e in zip(merged_o, merged_e))
    df = max(len(merged_e) - 1, 1); p = chi2_sf(chi, df)
    return {"name": "Marginal distribution (bias)", "stat": f"chi2={chi:.1f} df={df}",
            "detail": "do outcome frequencies match a fair sum-of-digits curve?",
            "p": p, "passed": p >= ALPHA}

def t_autocorr(x, lags=5):
    n = len(x); m = sum(x) / n
    den = sum((v - m) ** 2 for v in x) or 1e-9
    worst_p, worst = 1.0, ""
    for k in range(1, lags + 1):
        num = sum((x[i] - m) * (x[i + k] - m) for i in range(n - k))
        r = num / den; z = r * math.sqrt(n); p = 2 * norm_sf(abs(z))
        if p < worst_p: worst_p, worst = p, f"lag {k}: r={r:+.3f}"
    return {"name": "Serial autocorrelation", "stat": worst,
            "detail": "does a result correlate linearly with recent results?",
            "p": worst_p, "passed": worst_p >= ALPHA}

def t_runs(x):
    n = len(x); med = sorted(x)[n // 2]
    seq = [1 if v > med else 0 for v in x if v != med]
    n1, n2 = sum(seq), len(seq) - sum(seq)
    if n1 == 0 or n2 == 0:
        return {"name": "Runs test (clustering)", "stat": "degenerate",
                "detail": "skipped — no variation around the median", "p": 1.0, "passed": True}
    runs = 1 + sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
    mu = 2 * n1 * n2 / (n1 + n2) + 1
    var = 2 * n1 * n2 * (2 * n1 * n2 - n1 - n2) / ((n1 + n2) ** 2 * (n1 + n2 - 1))
    z = (runs - mu) / math.sqrt(var) if var > 0 else 0.0
    p = 2 * norm_sf(abs(z))
    return {"name": "Runs test (clustering)", "stat": f"runs={runs} z={z:+.2f}",
            "detail": "are highs and lows ordered randomly, not streaked?",
            "p": p, "passed": p >= ALPHA}

def _bins(x, q=4):
    cuts = [sorted(x)[int(len(x) * i / q)] for i in range(1, q)]
    def b(v):
        for i, c in enumerate(cuts):
            if v < c: return i
        return q - 1
    return [b(v) for v in x], q

def t_conditional(x):
    b, q = _bins(x); table = [[0] * q for _ in range(q)]
    for i in range(len(b) - 1): table[b[i]][b[i + 1]] += 1
    tot = sum(sum(r) for r in table)
    rowsum = [sum(r) for r in table]; colsum = [sum(table[r][c] for r in range(q)) for c in range(q)]
    chi, df = 0.0, 0
    for r in range(q):
        for c in range(q):
            e = rowsum[r] * colsum[c] / tot if tot else 0
            if e > 0: chi += (table[r][c] - e) ** 2 / e
    df = (q - 1) * (q - 1); p = chi2_sf(chi, df)
    return {"name": "Previous→next independence", "stat": f"chi2={chi:.1f} df={df}",
            "detail": "knowing the last result, can you narrow down the next?",
            "p": p, "passed": p >= ALPHA}

def t_predictor(x, trials=400, seed=12345):
    """Train a prev-bin -> most-likely-next-bin predictor; measure its accuracy
    lift over always-guess-the-mode, then test that lift against shuffled data."""
    b, q = _bins(x)
    def lift(seq):
        tr = defaultdict(Counter)
        for i in range(len(seq) - 1): tr[seq[i]][seq[i + 1]] += 1
        pred = {k: c.most_common(1)[0][0] for k, c in tr.items()}
        hits = sum(1 for i in range(len(seq) - 1) if pred.get(seq[i]) == seq[i + 1])
        acc = hits / (len(seq) - 1)
        base = Counter(seq[1:]).most_common(1)[0][1] / (len(seq) - 1)
        return acc - base, acc, base
    obs_lift, acc, base = lift(b)
    rng = random.Random(seed); ge = 1
    for _ in range(trials):
        s = b[:]; rng.shuffle(s)
        if lift(s)[0] >= obs_lift: ge += 1
    p = ge / (trials + 1)
    return {"name": "Trained predictor lift", "stat": f"acc={acc:.1%} vs base {base:.1%}",
            "detail": "a predictor trained on history vs blind best-guess",
            "p": p, "passed": p >= ALPHA}

TESTS = [t_distribution, t_autocorr, t_runs, t_conditional, t_predictor]

# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------
def audit(x, label):
    n = len(x)
    print("=" * 70)
    print(f"PREDICTABILITY AUDIT  ·  source: {label}  ·  n = {n} results")
    print("=" * 70)
    if n < 50:
        print("  ! fewer than 50 results — tests have little power; collect more.\n")
    results, flags = [], 0
    for fn in TESTS:
        r = fn(x); results.append(r)
        if "skip" in r:
            print(f"  --   {r['name']:<32} {r['skip']}"); continue
        verdict = "PASS" if r["passed"] else "FLAG"
        if not r["passed"]: flags += 1
        print(f"  [{verdict}] {r['name']:<32} {r['stat']:<22} p={r['p']:.4f}")
        print(f"         {r['detail']}")
    print("-" * 70)
    if flags == 0:
        print("  VERDICT:  PASS — no predictable structure detected.")
        print("            Each result is statistically independent of the ones before it.")
    else:
        print(f"  VERDICT:  FLAGGED — {flags} test(s) show structure a fair engine would not.")
        print("            Results are not independent; a predictor can gain an edge here.")
    if n < 300:
        print(f"  (note: {n} results is workable but >=500 gives the tests full power.)")
    print("=" * 70 + "\n")
    return flags

# ---------------------------------------------------------------------------
# sample generators (so the tool can be proven before real data)
# ---------------------------------------------------------------------------
def make_samples(n=800):
    import secrets
    fair = [secrets.randbelow(10) + secrets.randbelow(10) + secrets.randbelow(10) for _ in range(n)]
    # predictable: ~85% of rounds are a deterministic function of the previous result
    pred, x = [], 7
    for _ in range(n):
        if random.random() < 0.15: x = secrets.randbelow(10)+secrets.randbelow(10)+secrets.randbelow(10)
        else: x = (x * 7 + 5) % 28
        pred.append(x)
    for name, data in (("fair_sample", fair), ("predictable_sample", pred)):
        with open(name + ".csv", "w", newline="") as f:
            w = csv.writer(f); w.writerow(["round", "result"])
            for i, v in enumerate(data, 1): w.writerow([i, v])
        con = sqlite3.connect(name + ".db"); c = con.cursor()
        c.execute("DROP TABLE IF EXISTS rounds")
        c.execute("CREATE TABLE rounds (round INTEGER, result INTEGER)")
        c.executemany("INSERT INTO rounds VALUES (?,?)", list(enumerate(data, 1)))
        con.commit(); con.close()
    print(f"wrote fair_sample.csv/.db and predictable_sample.csv/.db ({n} rows each)\n"
          "try:  python predictability_audit.py fair_sample.csv\n"
          "      python predictability_audit.py predictable_sample.db --table rounds --column result")

# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Audit game results for predictability.")
    ap.add_argument("path", nargs="?", help="CSV or SQLite file of results")
    ap.add_argument("--table", help="SQLite table name")
    ap.add_argument("--column", help="column holding the result")
    ap.add_argument("--make-samples", action="store_true", help="write fair + predictable test files")
    a = ap.parse_args()
    if a.make_samples: make_samples(); return
    if not a.path: ap.error("give a CSV/SQLite file, or use --make-samples")
    ext = os.path.splitext(a.path)[1].lower()
    if ext in (".db", ".sqlite", ".sqlite3"):
        x, label = load_sqlite(a.path, a.table, a.column)
    else:
        x, label = load_csv(a.path, a.column)
    if len(x) < 5: raise SystemExit("not enough numeric results found in that source")
    flags = audit(x, label)
    sys.exit(1 if flags else 0)        # non-zero exit if flagged (handy for CI)

if __name__ == "__main__":
    main()

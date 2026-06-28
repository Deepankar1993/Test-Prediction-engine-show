# Provably-Fair Engine — Evaluation Kit

**Sylox Tech** · a result engine for licensed gaming operators that players can
**verify** and exploiters **can't predict**.

**▶ Live prediction tool:** https://deepankar1993.github.io/Test-Prediction-engine-show/
— learns a game's result history, posts its 8 most-likely numbers for the next round to
check against the live game (or 3 reel digits for deeper structure), and shows that the
same engine gets no edge against the commit-reveal engine. Your test is saved in the
browser across days; use **export/import** to carry it between machines.

This kit lets you evaluate it yourself in a few minutes. It has three pieces and
two ways to open them — pick whichever fits you.

---

## Quickest start (one click)

- **Windows** — double-click **`Start-Windows.bat`**
- **Mac / Linux** — double-click **`Start-Mac-Linux.command`**

That opens the interactive demo in your browser and shows a small menu for the
rest. (Requires Python 3.8+, which most machines already have. If a technical
review isn't needed, you can also just open the two files below directly.)

## One command (for engineers)

```
python sylox_kit.py            # opens the demo + menu
python sylox_kit.py --demo     # runs the predictable-vs-fair audit, no browser
python sylox_kit.py --audit path/to/results.csv
python sylox_kit.py --check    # confirms the kit is intact
```

---

## What's inside

**1 · `fairness_demo.html` — the interactive demo**
Double-click to open in any browser; works offline. Press **Run comparison** to
watch the same betting attack run against an incumbent-style engine and the Sylox
engine. Drag **Incumbent predictability** and watch the exploit rise and fall;
the Sylox side never moves. The live preview computes a real commit/reveal hash
on your device — the crypto is genuine, not a mockup.

**2 · `sylox_brief.pdf` — the one-page summary**
For the decision-maker: the two numbers that matter, what "provably fair" means
in plain language, and why it matters for compliance, trust, and margin.

**3 · `predictability_audit.py` — the audit tool**
Point it at any results file and it reports whether the next result is tied to
the previous ones — the test a regulator's auditor runs. No installs needed.

```
python predictability_audit.py results.csv
python predictability_audit.py results.db --table rounds --column result
python predictability_audit.py --make-samples     # writes test fixtures
```

A clean engine **passes** all five tests; a predictable one is **flagged**.

**`samples/`** — ready-made data to prove the tool before using real data:
`fair_sample` (passes) and `predictable_sample` (flagged), each as CSV and
SQLite, plus `observed_history.csv`.

---

## Suggested 3-minute walkthrough

1. Open the demo, press **Run comparison**, then drag the predictability slider.
2. In a terminal: `python predictability_audit.py samples/predictable_sample.csv`
   → five flags. Then `samples/fair_sample.csv` → five passes. Same tool, only
   the engine differs.
3. Read `sylox_brief.pdf`.

---

*Note: the audit measures predictability from logged results — it is an
evaluation tool, not a live-betting client. Point it at any published history,
including ours.*

Deepankar Singh · Founder, Sylox Tech (OPC) Pvt. Ltd.
[ your email ] · [ sylox.tech ]

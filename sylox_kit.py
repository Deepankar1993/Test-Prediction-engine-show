#!/usr/bin/env python3
"""
Sylox Tech — Provably-Fair Engine · Evaluation Kit launcher.

One command opens the interactive demo in your browser and gives a small menu
to run the predictability audit on your own data. Pure standard library.

  python sylox_kit.py            # open demo + interactive menu
  python sylox_kit.py --audit FILE
  python sylox_kit.py --demo     # run the predictable-vs-fair demonstration (no browser)
  python sylox_kit.py --check    # verify the kit is intact
"""
import os, sys, subprocess, threading, webbrowser, http.server, socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable or "python3"
SAMPLES = os.path.join(ROOT, "samples")
AUDIT = os.path.join(ROOT, "predictability_audit.py")

def _serve():
    os.chdir(ROOT)
    h = http.server.SimpleHTTPRequestHandler
    h.log_message = lambda *a, **k: None
    for port in range(8765, 8786):
        try:
            httpd = socketserver.TCPServer(("127.0.0.1", port), h)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            return port
        except OSError:
            continue
    return None

def open_demo(port):
    url = (f"http://127.0.0.1:{port}/fairness_demo.html" if port
           else "file://" + os.path.join(ROOT, "fairness_demo.html"))
    print(f"  opening demo:  {url}")
    try: webbrowser.open(url)
    except Exception: print("  (open it manually in a browser)")

def open_file(path):
    try:
        if sys.platform.startswith("darwin"): subprocess.run(["open", path])
        elif os.name == "nt": os.startfile(path)            # type: ignore
        else: subprocess.run(["xdg-open", path])
    except Exception:
        print(f"  open manually: {path}")

def run_audit(path):
    if not os.path.isabs(path) and not os.path.exists(path):
        alt = os.path.join(SAMPLES, path)
        if os.path.exists(alt): path = alt
    if not os.path.exists(path):
        print(f"  ! file not found: {path}"); return
    subprocess.run([PY, AUDIT, path])

def demonstration():
    print("\n>>> 1/2  A PREDICTABLE engine (what incumbents ship):")
    run_audit(os.path.join(SAMPLES, "predictable_sample.csv"))
    print(">>> 2/2  A PROVABLY-FAIR engine (what Sylox builds):")
    run_audit(os.path.join(SAMPLES, "fair_sample.csv"))
    print("Same tests, same tool. The only variable is the engine.\n")

def regenerate():
    subprocess.run([PY, AUDIT, "--make-samples"], cwd=SAMPLES)

def check():
    need = ["fairness_demo.html", "sylox_brief.pdf", "predictability_audit.py"]
    ok = all(os.path.exists(os.path.join(ROOT, f)) for f in need)
    print("kit files present:", "OK" if ok else "MISSING")
    r = subprocess.run([PY, AUDIT, os.path.join(SAMPLES, "fair_sample.csv")],
                       capture_output=True, text=True)
    print("audit tool runs:", "OK" if r.returncode == 0 else "FAIL")
    sys.exit(0 if ok else 1)

BANNER = r"""
  ============================================================
   SYLOX TECH  ·  Provably-Fair Engine — Evaluation Kit
  ============================================================
   A result engine for licensed operators that players can
   verify and exploiters can't predict. Three pieces:
     - interactive demo (incumbent vs Sylox, run live)
     - one-page brief (the decision-maker summary)
     - predictability audit (run it on any results file)
  ============================================================
"""

def menu():
    print(BANNER)
    port = _serve()
    open_demo(port)
    while True:
        print("""
  What would you like to do?
    1) Open the interactive demo again
    2) Run the demonstration  (predictable vs fair, in this window)
    3) Audit YOUR results file (CSV or SQLite)
    4) Open the one-page brief (PDF)
    5) Regenerate sample data
    q) Quit""")
        try: c = input("  > ").strip().lower()
        except (EOFError, KeyboardInterrupt): print(); break
        if c == "1": open_demo(port)
        elif c == "2": demonstration()
        elif c == "3":
            p = input("  path to CSV/SQLite file: ").strip().strip('"')
            if p: run_audit(p)
        elif c == "4": open_file(os.path.join(ROOT, "sylox_brief.pdf"))
        elif c == "5": regenerate()
        elif c in ("q", "quit", "exit"): break
        else: print("  ? pick 1–5 or q")
    print("  Closing. The demo and brief are plain files you can reopen anytime.\n")

def main():
    a = sys.argv[1:]
    if not a: menu()
    elif a[0] == "--audit" and len(a) > 1: run_audit(a[1])
    elif a[0] == "--demo": demonstration()
    elif a[0] == "--check": check()
    else:
        print("usage: python sylox_kit.py [--audit FILE | --demo | --check]")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
audit-gate.py — npm audit gate that distinguishes fixable from migration-only.

`npm audit --audit-level=high` can never go green while a high advisory has
no non-breaking fix: the only offered fix is a breaking major bump that is a
project decision (e.g. tailwindcss 3 → 4 to drop the unpatched braces chain),
not a patch. A gate that can never go green blocks every merge with an alert
nobody can clear — alert fatigue, and the gate stops meaning anything.

Policy:
  FAIL (exit 1) when any high/critical advisory has a fix available WITHOUT a
  breaking major bump (fixAvailable: true, or an object with isSemVerMajor
  false) — those are patchable in place right now.
  PASS (exit 0, loudly) when the only remaining high/critical advisories are
  major-bump-only fixes — still printed, so they stay visible and tracked.

Run from the package directory you want audited:
  python3 scripts/audit-gate.py            # backend (repo root)
  cd synthetic-nature && python3 ../scripts/audit-gate.py
"""
import json
import subprocess
import sys

# The audit runs through a pinned npm 11: npm 10 (Node 20's bundled npm)
# mis-resolves transitive chains — it reports `fixAvailable: true` for
# fast-glob when the only real fix is the breaking tailwindcss@4 bump that
# npm 11 correctly reports as isSemVerMajor. Pinning makes the gate's
# verdict identical on every runner.
audit = subprocess.run(["npx", "-y", "npm@11", "audit", "--json"],
                       capture_output=True, text=True)
try:
    data = json.loads(audit.stdout)
except json.JSONDecodeError:
    # npm audit --json failed to produce JSON (registry down, no lockfile…)
    # — fall through to the plain gate so a broken audit never silently passes.
    plain = subprocess.run(["npm", "audit", "--audit-level=high"])
    sys.exit(plain.returncode)

blocking, migration_only = [], []
for name, v in (data.get("vulnerabilities") or {}).items():
    if v.get("severity") not in ("high", "critical"):
        continue
    fix = v.get("fixAvailable")
    if fix is True or (isinstance(fix, dict) and not fix.get("isSemVerMajor")):
        blocking.append(f"{name} ({v['severity']}) — in-place fix available: {fix}")
    else:
        major = fix.get("version") if isinstance(fix, dict) else None
        migration_only.append(
            f"{name} ({v['severity']}) — only fix is a breaking major bump"
            + (f" ({major})" if major else "") + " — a migration decision, not a patch")

if blocking:
    print("FAIL — high/critical vulnerabilities with an in-place fix:", file=sys.stderr)
    for b in blocking:
        print("  " + b, file=sys.stderr)
    if migration_only:
        print("also present (major-bump-only, not gating):", file=sys.stderr)
        for w in migration_only:
            print("  " + w, file=sys.stderr)
    sys.exit(1)

for w in migration_only:
    print("warning: " + w, file=sys.stderr)
if migration_only:
    print("audit gate: no in-place fixable high/critical advisories"
          " (major-bump-only ones warned above) — PASS")
else:
    print("audit gate: 0 high/critical advisories — PASS")
sys.exit(0)

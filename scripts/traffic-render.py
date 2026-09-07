#!/usr/bin/env python3
"""
traffic-render.py — archive GitHub repo traffic into TRAFFIC.md + badge JSONs.

GitHub's traffic API (views/clones/referrers) only retains 14 days and is
only visible to users with push access, so a weekly Actions run snapshots
it into committed files everyone can read:

  TRAFFIC.md                — rolling archive: per-day table, weekly summary,
                              all-time totals, referrers. Each run appends/
                              updates the current week without duplicating.
  traffic/total-views.json  — { "schema": 1, "total": N }   → shields.io badge
  traffic/total-clones.json
  traffic/unique-views.json
  traffic/unique-clones.json

Badge URL shape: https://img.shields.io/endpoint?url=<raw-file-url>

Auth: reads GITHUB_TOKEN (set by the workflow). Repo/owner default to this
repository (public ENZO); override with GITHUB_REPOSITORY. Never-throw on
API failure: the workflow exits non-zero only if NOTHING could be fetched.

Run: GITHUB_TOKEN=… python3 scripts/traffic-render.py   (from repo root)

Security note: this script only ever writes numbers. The token stays in env,
and nothing it fetches contains secrets (traffic endpoints return counts).
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
REPO = os.environ.get("GITHUB_REPOSITORY") or "theguysudo/ENZO"
API_REPO = f"https://api.github.com/repos/{REPO}"
API = f"{API_REPO}/traffic"
REQ_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "traffic-render",
    **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
}

if not TOKEN:
    # Local/dry runs without a token still work against PUBLIC endpoints
    # (views/clones need auth, referrers too) — warn loudly instead of failing
    # half-silently.
    print("warning: no GITHUB_TOKEN/GH_TOKEN — API may refuse traffic data",
          file=sys.stderr)


def get(path, base=API):
    req = urllib.request.Request(base + path, headers=REQ_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    ok_any = False
    views = None
    clones = None
    referrers = None
    stars = None
    for name, fn in (("views", lambda: get("/views")),
                     ("clones", lambda: get("/clones")),
                     ("referrers", lambda: get("/popular/referrers")),
                     ("repo", lambda: get("", base=API_REPO))):
        try:
            data = fn()
            ok_any = True
            if name == "views":
                views = data
            elif name == "clones":
                clones = data
            elif name == "referrers":
                referrers = data
            elif name == "repo":
                stars = data.get("stargazers_count")
        except urllib.error.HTTPError as e:
            # Surface the response body — GitHub puts the real reason there
            # ("Resource not accessible by integration", rate limit, …).
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:  # noqa: BLE001
                detail = ""
            print(f"warning: {name} fetch failed: {e}"
                  + (f" — {detail}" if detail else ""), file=sys.stderr)
        except Exception as e:  # noqa: BLE001 — one endpoint down ≠ abort
            print(f"warning: {name} fetch failed: {e}", file=sys.stderr)

    if not ok_any:
        print("error: no endpoint responded — aborting", file=sys.stderr)
        return 1

    # Previous snapshot's numbers (the committed badge files are the record
    # of the last run that actually got data). A failed fetch this run keeps
    # them instead of zeroing the archive.
    def load_prev(*paths):
        vals = {}
        for p in paths:
            try:
                with open(p) as f:
                    vals[p] = int(json.load(f)["message"])
            except Exception:  # noqa: BLE001 — missing/corrupt = no prev value
                vals[p] = None
        return vals

    pv = load_prev("traffic/total-views.json", "traffic/unique-views.json")
    pc = load_prev("traffic/total-clones.json", "traffic/unique-clones.json")
    ps = load_prev("traffic/stars.json")
    prev_v = ({"count": pv["traffic/total-views.json"],
               "uniques": pv["traffic/unique-views.json"]}
              if pv["traffic/total-views.json"] is not None else None)
    prev_c = ({"count": pc["traffic/total-clones.json"],
               "uniques": pc["traffic/unique-clones.json"]}
              if pc["traffic/total-clones.json"] is not None else None)
    prev_s = ps["traffic/stars.json"]

    if views or clones or stars is not None:
        # Merge into the existing snapshot: keep last week's real numbers
        # wherever this fetch has no data, so a 403 run can never zero the
        # archive. (Values the API returned always win.)
        merged_v = views or prev_v
        merged_c = clones or prev_c
        merged_s = stars if stars is not None else prev_s
    else:
        merged_v, merged_c, merged_s = prev_v, prev_c, prev_s
        print("warning: no traffic data this run — kept the previous snapshot",
              file=sys.stderr)

    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%d")
    week_label = f"{now.year}-W{now.isocalendar()[1]:02d}"

    # ── badge JSONs (schema shields.io understands) ──────────────────────────
    os.makedirs("traffic", exist_ok=True)
    badges = {
        "total-views": merged_v.get("count"),
        "unique-views": merged_v.get("uniques"),
        "total-clones": merged_c.get("count"),
        "unique-clones": merged_c.get("uniques"),
    }
    # Dynamic badge colors: bigger = warmer. Tasteful, not traffic-light.
    def color(n):
        if n >= 1000: return "brightgreen"
        if n >= 100: return "green"
        if n >= 10: return "yellowgreen"
        return "yellow"

    for key, value in badges.items():
        with open(f"traffic/{key}.json", "w") as f:
            json.dump({"schemaVersion": 1, "label": key.replace("-", " "),
                       "message": f"{value if value is not None else 'no data'}",
                       "color": color(value) if value is not None else "lightgrey"}, f, indent=2)
        print(f"traffic/{key}.json -> {value if value is not None else 'no data'}")

    # Stars badge comes straight from the repo object (no 14-day retention).
    if merged_s is not None:
        with open("traffic/stars.json", "w") as f:
            json.dump({"schemaVersion": 1, "label": "stars",
                       "message": f"{merged_s}", "color": color(merged_s)}, f, indent=2)
        print(f"traffic/stars.json -> {merged_s}")

    # ── TRAFFIC.md rolling archive ────────────────────────────────────────────
    # Layout: header (badges) → current week table → all-time totals →
    # weekly history (latest first). Each run rewrites the current week's
    # block; older weeks are never touched.
    with open("TRAFFIC.md", "a+") as f:
        pass  # ensure exists

    with open("TRAFFIC.md") as f:
        existing = f.read()

    header = (
        "# Traffic\n\n"
        "> Visitor and clone statistics, snapshotted automatically every week by\n"
        "> GitHub Actions. GitHub's API only retains 14 days of detail — this\n"
        "> page is the permanent record. Raw numbers live in [`traffic/`](traffic/).\n\n"
        "## Latest snapshot\n\n"
        f"**Week {week_label}** (updated {stamp})\n\n"
        f"| Last 14 days | Views | Unique visitors | Clones | Unique cloners | Stars |\n"
        f"|---|---|---|---|---|---|\n"
        f"| totals | {(merged_v or {}).get('count', 0)} | {(merged_v or {}).get('uniques', 0)} "
        f"| {(merged_c or {}).get('count', 0)} | {(merged_c or {}).get('uniques', 0)} "
        f"| {merged_s if merged_s is not None else '—'} |\n\n"
    )

    # Daily rows for the snapshot window (most recent first, zeros included so
    # gaps stay visible). Written only when this run actually got fresh daily
    # data — a 403 run keeps last week's rows instead of collapsing to zero.
    daily_rows = ""
    for day in reversed((views or {}).get("views", [])):
        d = day["timestamp"][:10]
        v, u = day["count"], day["uniques"]
        # clone counts for the same day, when available (— when the clones
        # fetch failed — never a fake 0)
        c = next((x for x in (clones or {}).get("clones", [])
                  if x["timestamp"][:10] == d), None)
        cc = f"{c['count']}" if c else ("—" if clones is None else 0)
        cu = f"{c['uniques']}" if c else ("—" if clones is None else 0)
        daily_rows += f"| {d} | {v} | {u} | {cc} | {cu} |\n"
    if daily_rows:
        header += (
            "| Day | Views | Unique | Clones | Unique |\n"
            "|---|---|---|---|---|\n" + daily_rows + "\n"
        )

    if referrers:
        header += "### Top referrers (last 14 days)\n\n"
        header += "| Source | Views | Unique |\n|---|---|---|\n"
        for ref in referrers:
            # API docs say 'name', the live payload says 'referrer' — accept both
            src = ref.get("referrer") or ref.get("name") or "?"
            header += f"| {src} | {ref['count']} | {ref['uniques']} |\n"
        header += "\n"

    if "## Latest snapshot" in existing:
        if not (views or clones):
            # No fresh 14-day data this run (only stars, or nothing) —
            # leave the previous snapshot's daily table intact.
            print("TRAFFIC.md unchanged (no fresh traffic data)", file=sys.stderr)
            return 0
        # Replace everything from '## Latest snapshot' up to the next '## '
        # (or EOF) with the new snapshot, keeping weekly history below.
        start = existing.index("## Latest snapshot")
        rest = existing[start:]
        nxt = rest.find("\n## ", 1)
        keep = existing[start + nxt:] if nxt > -1 else ""
        body = existing[:start] + header.split("# Traffic\n\n", 1)[1] + keep
        with open("TRAFFIC.md", "w") as f:
            f.write(body)
    else:
        with open("TRAFFIC.md", "w") as f:
            f.write(header + "---\n\n"
                    "## Weekly history\n\n"
                    "Each week's 14-day snapshot is archived below, newest first.\n")
    print("TRAFFIC.md updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
traffic-render.py — archive GitHub repo traffic into TRAFFIC.md + badge JSONs.

GitHub's traffic API (views/clones/referrers) only retains a rolling 14-day
window and is only visible to users with push access, so an hourly Actions
run snapshots it into committed files everyone can read.

The 14-day window is why the "total" badges used to show wrong numbers: as
the window slid past the launch spike, the badge DROPPED (2407 → 593) while
labeled "total". The fix is a persistent per-day record:

  TRAFFIC.md                — rolling archive: per-day table, all-time row,
                              referrers. Each run rewrites the current week.
  traffic/history.json      — persistent per-day history {date: {views, uv,
                              clones, uc}}. Each run merges the fetched
                              14-day window into it (max per field, so a
                              downward revision never erases a recorded day).
  traffic/total-views.json  — ALL-TIME views (sum of history.json)  → badge
  traffic/total-clones.json — ALL-TIME clones (sum of history.json) → badge
  traffic/unique-views.json — last-14-days unique visitors (labeled "(14d)":
                              uniques dedupe across days, so a sum of daily
                              uniques would overcount — a true all-time
                              unique count cannot be built from daily data)
  traffic/unique-clones.json — same, cloners
  traffic/docker-pulls.json — ghcr pull count, scraped from the public
                              package page (no token needed)

Badge URL shape: https://img.shields.io/endpoint?url=<raw-file-url>

Auth: reads GITHUB_TOKEN (set by the workflow). Repo/owner default to this
repository (public ENZO); override with GITHUB_REPOSITORY. Never-throw on
API failure: the workflow exits non-zero only if NOTHING could be fetched.

Run: GITHUB_TOKEN=… python3 scripts/traffic-render.py   (from repo root)

Security note: this script only ever writes numbers. The token stays in env,
and nothing it fetches contains secrets (traffic endpoints return counts;
the package page is a public HTML page).
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
REPO = os.environ.get("GITHUB_REPOSITORY") or "theguysudo/ENZO"
OWNER = REPO.split("/")[0]
PACKAGE = "enzo"
API_REPO = f"https://api.github.com/repos/{REPO}"
API = f"{API_REPO}/traffic"
PACKAGE_PAGE = f"https://github.com/users/{OWNER}/packages/container/package/{PACKAGE}"
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


def fetch_docker_pulls():
    """Scrape the public ghcr package page for its Total downloads count.

    The Packages REST API needs read:packages (a scope the workflow token
    does not carry), but this page is public and carries the same number as
    `<h3 title="N">N</h3>` right under the "Total downloads" label — verified
    against this repo's page. Returns None when the page or pattern is gone;
    the caller then keeps the previous value (never a fake 0).
    """
    req = urllib.request.Request(PACKAGE_PAGE, headers={
        "User-Agent": "traffic-render",
        "Accept": "text/html",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8", "replace")
    m = re.search(r"Total downloads</span>\s*<h3[^>]*>\s*([\d,.]+)", html)
    if not m:
        return None
    return int(m.group(1).replace(",", ""))


def load_prev(*paths):
    """Previous snapshot's numbers (the committed badge files are the record
    of the last run that actually got data). A failed fetch this run keeps
    them instead of zeroing the archive."""
    vals = {}
    for p in paths:
        try:
            with open(p) as f:
                vals[p] = int(json.load(f)["message"])
        except Exception:  # noqa: BLE001 — missing/corrupt = no prev value
            vals[p] = None
    return vals


def load_history(path="traffic/history.json"):
    try:
        with open(path) as f:
            raw = json.load(f)
        return {d: {k: int(v) for k, v in day.items()} for d, day in raw.items()}
    except Exception:  # noqa: BLE001 — missing/corrupt = start from today
        return {}


def merge_history(hist, views, clones):
    """Merge the fetched 14-day per-day arrays into the persistent history.

    max() per field: GitHub occasionally revises a day downward after the
    fact, and the whole point is that days must never fall out of the record
    when the 14-day window slides past them.
    """
    for day in (views or {}).get("views", []):
        d = day["timestamp"][:10]
        h = hist.setdefault(d, {"views": 0, "uv": 0, "clones": 0, "uc": 0})
        h["views"] = max(h["views"], int(day.get("count", 0)))
        h["uv"] = max(h["uv"], int(day.get("uniques", 0)))
    for day in (clones or {}).get("clones", []):
        d = day["timestamp"][:10]
        h = hist.setdefault(d, {"views": 0, "uv": 0, "clones": 0, "uc": 0})
        h["clones"] = max(h["clones"], int(day.get("count", 0)))
        h["uc"] = max(h["uc"], int(day.get("uniques", 0)))
    return hist


def main():
    ok_any = False
    views = None
    clones = None
    referrers = None
    stars = None
    pulls = None
    for name, fn in (("views", lambda: get("/views")),
                     ("clones", lambda: get("/clones")),
                     ("referrers", lambda: get("/popular/referrers")),
                     ("repo", lambda: get("", base=API_REPO)),
                     ("pulls", fetch_docker_pulls)):
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
            elif name == "pulls":
                pulls = data
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

    prev_badges = load_prev("traffic/total-views.json", "traffic/unique-views.json",
                            "traffic/total-clones.json", "traffic/unique-clones.json",
                            "traffic/stars.json", "traffic/docker-pulls.json")

    # ── persistent per-day history → true all-time totals ───────────────────
    hist = load_history()
    had_history = bool(hist)
    if views or clones:
        hist = merge_history(hist, views, clones)
        os.makedirs("traffic", exist_ok=True)
        with open("traffic/history.json", "w") as f:
            json.dump(dict(sorted(hist.items())), f, indent=1)
    all_time_views = sum(h["views"] for h in hist.values())
    all_time_clones = sum(h["clones"] for h in hist.values())
    if views or clones:
        print(f"history.json -> {len(hist)} days, all-time views={all_time_views},"
              f" clones={all_time_clones}"
              + ("" if had_history else " (started fresh)"))
    elif not had_history:
        # No history file, no fresh data — the totals fall back to whatever
        # the previous badge files hold (which were written under the old
        # 14-day scheme; the next run with data rebuilds them).
        all_time_views = prev_badges["traffic/total-views.json"]
        all_time_clones = prev_badges["traffic/total-clones.json"]

    # ── badge JSONs (schema shields.io understands) ──────────────────────────
    os.makedirs("traffic", exist_ok=True)
    badges = {
        "total-views": all_time_views,
        "unique-views": (views or {}).get("uniques"),
        "total-clones": all_time_clones,
        "unique-clones": (clones or {}).get("uniques"),
    }
    # Dynamic badge colors: bigger = warmer. Tasteful, not traffic-light.
    def color(n):
        if n >= 1000: return "brightgreen"
        if n >= 100: return "green"
        if n >= 10: return "yellowgreen"
        return "yellow"

    labels = {
        "total-views": "total views",
        "unique-views": "unique visitors (14d)",
        "total-clones": "total clones",
        "unique-clones": "unique cloners (14d)",
    }
    for key, value in badges.items():
        if value is None:
            # A failed 14-day fetch keeps the previous number (never a zero
            # and never "no data" — the badge must not collapse).
            value = prev_badges[f"traffic/{key}.json"]
        with open(f"traffic/{key}.json", "w") as f:
            json.dump({"schemaVersion": 1, "label": labels[key],
                       "message": f"{value}", "color": color(value)}, f, indent=2)
        print(f"traffic/{key}.json -> {value}")

    # Stars badge comes straight from the repo object (no 14-day retention).
    stars_out = stars if stars is not None else prev_badges["traffic/stars.json"]
    if stars_out is not None:
        with open("traffic/stars.json", "w") as f:
            json.dump({"schemaVersion": 1, "label": "stars",
                       "message": f"{stars_out}", "color": color(stars_out)}, f, indent=2)
        print(f"traffic/stars.json -> {stars_out}")

    # Docker pulls: scrape may fail (page moved) — keep the previous count.
    pulls_out = pulls if pulls is not None else prev_badges["traffic/docker-pulls.json"]
    if pulls_out is not None:
        with open("traffic/docker-pulls.json", "w") as f:
            json.dump({"schemaVersion": 1, "label": "docker pulls",
                       "message": f"{pulls_out}", "color": color(pulls_out)}, f, indent=2)
        print(f"traffic/docker-pulls.json -> {pulls_out}")

    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%d")
    week_label = f"{now.year}-W{now.isocalendar()[1]:02d}"

    # ── TRAFFIC.md rolling archive ────────────────────────────────────────────
    # Layout: header (snapshot tables) → per-day table → referrers → weekly
    # history. Each run rewrites the current snapshot block; older weeks are
    # never touched.
    with open("TRAFFIC.md", "a+") as f:
        pass  # ensure exists

    with open("TRAFFIC.md") as f:
        existing = f.read()

    table = (
        "## Latest snapshot\n\n"
        f"**Week {week_label}** (updated {stamp})\n\n"
        "| Snapshot | Views | Unique visitors | Clones | Unique cloners | Stars |\n"
        "|---|---|---|---|---|---|\n"
        f"| last 14 days | {(views or {}).get('count', 0)} | {(views or {}).get('uniques', 0)} "
        f"| {(clones or {}).get('count', 0)} | {(clones or {}).get('uniques', 0)} "
        f"| {stars_out if stars_out is not None else '—'} |\n"
        f"| all time | {all_time_views} | — | {all_time_clones} | — "
        f"| {stars_out if stars_out is not None else '—'} |\n\n"
    )
    if pulls_out is not None:
        table += f"Docker pulls ([ghcr.io/{OWNER}/{PACKAGE}]"
        table += f"(https://github.com/{REPO}/pkgs/container/{PACKAGE})): **{pulls_out}**\n\n"
    table += ("All-time totals are the sum of the persistent per-day record in\n"
              "[`traffic/history.json`](traffic/history.json) — days stay in the record\n"
              "after GitHub's 14-day window slides past them. Unique counts are windowed\n"
              "(a sum of daily uniques would overcount repeat visitors).\n\n")

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
        table += (
            "| Day | Views | Unique | Clones | Unique |\n"
            "|---|---|---|---|---|\n" + daily_rows + "\n"
        )

    if referrers:
        table += "### Top referrers (last 14 days)\n\n"
        table += "| Source | Views | Unique |\n|---|---|---|\n"
        for ref in referrers:
            # API docs say 'name', the live payload says 'referrer' — accept both
            src = ref.get("referrer") or ref.get("name") or "?"
            table += f"| {src} | {ref['count']} | {ref['uniques']} |\n"
        table += "\n"

    quote = (
        "> Visitor and clone statistics, snapshotted automatically every hour by\n"
        "> GitHub Actions. GitHub's API only retains 14 days of detail — this\n"
        "> page is the permanent record. Raw numbers live in [`traffic/`](traffic/).\n\n"
    )

    if "## Latest snapshot" in existing:
        if not (views or clones):
            # No fresh 14-day data this run (only stars, or nothing) —
            # leave the previous snapshot's daily table intact.
            print("TRAFFIC.md unchanged (no fresh traffic data)", file=sys.stderr)
            return 0
        # Replace everything from '## Latest snapshot' up to the next '## '
        # (or EOF) with the new snapshot, keeping weekly history below.
        # The header (title + blockquote) is rebuilt from scratch — reusing
        # existing[:start] would stack a second blockquote under the previous
        # run's, one duplicate per run.
        start = existing.index("## Latest snapshot")
        rest = existing[start:]
        nxt = rest.find("\n## ", 1)
        keep = existing[start + nxt:] if nxt > -1 else ""
        body = "# Traffic\n\n" + quote + table + keep
        with open("TRAFFIC.md", "w") as f:
            f.write(body)
    else:
        with open("TRAFFIC.md", "w") as f:
            f.write("# Traffic\n\n" + quote + table + "---\n\n"
                    "## Weekly history\n\n"
                    "Each week's 14-day snapshot is archived below, newest first.\n")
    print("TRAFFIC.md updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())

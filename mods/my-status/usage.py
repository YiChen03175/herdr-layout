#!/usr/bin/env python3
"""Prints the Claude plan's usage: {five_hour, week, fable, at}, each {pct, resets} or null.

It asks Claude Code itself (its experimental get_usage request, what /usage shows)
from a clean start: --safe-mode loads no CLAUDE.md, skills, plugins or hooks,
--strict-mcp-config starts no MCP servers, and nothing is sent to a model, so it
costs no tokens. Claude Code reads its own login; this script never sees it.
The last answer is kept in <app home>/data/my-status/usage.json.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime

HOME = os.path.expanduser("~")
APP = os.environ.get("HERDR_APP_HOME") or os.path.join(HOME, ".config/herdr-app")
OUT = os.path.join(APP, "data/my-status/usage.json")
REQUEST = {"type": "control_request", "request_id": "usage",
           "request": {"subtype": "get_usage", "skip_behaviors": True}}


def window(w):
    """{pct, resets} from a {utilization, resets_at} window, or None."""
    if not w or w.get("utilization") is None:
        return None
    resets = w.get("resets_at")
    try:
        resets = round(datetime.fromisoformat(resets).timestamp()) if resets else None
    except ValueError:
        resets = None
    return {"pct": round(w["utilization"], 1), "resets": resets}


def main():
    exe = shutil.which("claude") or os.path.join(HOME, ".local/bin/claude")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    r = subprocess.run(
        [exe, "-p", "--safe-mode", "--strict-mcp-config", "--no-session-persistence",
         "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        input=json.dumps(REQUEST) + "\n", capture_output=True, text=True, timeout=45,
        cwd=os.path.dirname(OUT))
    answer = None
    for line in r.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        resp = msg.get("response") or {}
        if msg.get("type") == "control_response" and resp.get("request_id") == "usage":
            if resp.get("error"):
                sys.exit(f"usage.py: {resp['error']}")
            answer = resp.get("response") or {}
    if answer is None:
        sys.exit(f"usage.py: no answer (exit {r.returncode})")
    limits = answer.get("rate_limits") or {}
    is_fable = lambda name: "fable" in (name or "").lower()
    fable = next((m for m in limits.get("model_scoped") or [] if is_fable(m.get("display_name"))), None)
    week, fable = window(limits.get("seven_day")), window(fable)
    # Fable's part of the weekly limit, and the most of it Fable may use (both % of the week).
    rows = limits.get("limits") or []
    for share in limits.get("weekly_scoped_shares") or []:
        i = share.get("limit_index")
        row = rows[i] if isinstance(i, int) and 0 <= i < len(rows) else {}
        if is_fable((((row.get("scope") or {}).get("model")) or {}).get("display_name")):
            if week and share.get("used_percent_of_weekly") is not None:
                week["fable"] = share["used_percent_of_weekly"]
            if fable and share.get("allowance_percent_of_weekly") is not None:
                fable["cap"] = share["allowance_percent_of_weekly"]
    # Some answers leave the shares out: then the cap last seen gives Fable's part (its % times the cap).
    if fable and fable.get("cap") is None:
        try:
            with open(OUT) as f:
                cap = (json.load(f).get("fable") or {}).get("cap")
        except (OSError, ValueError):
            cap = None
        if cap is not None:
            fable["cap"] = cap
    if week and week.get("fable") is None and fable and fable.get("cap") is not None:
        week["fable"] = round(fable["pct"] * fable["cap"] / 100, 1)
    out = {"five_hour": window(limits.get("five_hour")), "week": week,
           "fable": fable, "plan": answer.get("subscription_type"), "at": int(time.time())}
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f)
    os.replace(tmp, OUT)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()

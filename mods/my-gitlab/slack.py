#!/usr/bin/env python3
"""Prints the GitLab merge requests linked in Slack messages that mention me.

[{"path": "group/project", "iid": "12", "at": <unix time of the newest mention>}]
from the last DAYS days, newest first; DMs left out. With no token: [].

The token is a Slack user token (xoxp-, scope search:read) in
<app home>/secrets/slack.token, outside anything that gets exported.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

APP = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")
TOKEN_FILE = os.path.join(APP, "secrets/slack.token")
DAYS = 7
MR = re.compile(r"https://gitlab\.com/([\w.-]+(?:/[\w.-]+)*)/-/merge_requests/(\d+)")


def api(token, method, **params):
    req = urllib.request.Request(f"https://slack.com/api/{method}?{urllib.parse.urlencode(params)}",
                                 headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.load(r)
    if not body.get("ok"):
        raise RuntimeError(f"{method}: {body.get('error')}")
    return body


def main():
    try:
        token = open(TOKEN_FILE).read().strip()
    except OSError:
        print("[]")
        return
    me = api(token, "auth.test")["user_id"]
    after = time.strftime("%Y-%m-%d", time.localtime(time.time() - DAYS * 86400))
    found = {}
    for m in api(token, "search.messages", query=f"<@{me}> after:{after}", count=100, sort="timestamp")["messages"]["matches"]:
        channel = m.get("channel") or {}
        if channel.get("is_im") or channel.get("is_mpim") or f"<@{me}>" not in (m.get("text") or ""):
            continue
        at = float(m.get("ts") or 0)
        # The text and any attachments (a pasted link's preview) alike.
        for path, iid in MR.findall(json.dumps(m)):
            key = (path, iid)
            if at > found.get(key, 0):
                found[key] = at
    out = [{"path": p, "iid": i, "at": at} for (p, i), at in sorted(found.items(), key=lambda kv: -kv[1])]
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # the panel goes on without Slack
        print(f"slack.py: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)

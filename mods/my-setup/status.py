#!/usr/bin/env python3
"""Prints what each part of this layout needs, and whether it has it:

  status.py [id...]         {"gitlab": {"state", "detail"}, "openrouter": ..., ...}
                            (only the named items when some are given)
  status.py --verify <id>   the same for one item, asking its service whether the
                            saved key works (openrouter, slack)

state is "ok", "missing" (nothing set up), "logged_out", "bad" (a key the service
refused) or "unknown". Keys are read from <app home>/secrets/ and never printed.
"""
import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "my-agents"))
from common import APP, OPENROUTER_KEYS, read_secret, write_json  # noqa: E402

HOME = os.path.expanduser("~")
# The last answer each service gave about a key, by the key's hash: shown until the
# key changes, so the dialog's periodic check doesn't hide a refused key.
VERIFIED = os.path.join(APP, "data/my-setup/verified.json")
# Which OpenRouter key each feature reads first (its own, then the shared ones).
FEATURES = (("改名", "openrouter-rename.key"), ("agent 狀態", "openrouter-decider.key"))

# The first file that exists is the key; the setup dialog writes the first one.
KEYS = {"openrouter": OPENROUTER_KEYS, "slack": ("slack.token",)}


def fingerprint(text):
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def verified():
    try:
        with open(VERIFIED, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def remember(item, text, answer):
    d = verified()
    d[item] = {"key": fingerprint(text), **answer}
    write_json(VERIFIED, d)


def run(*argv, timeout=10):
    """(exit code, stdout, stderr); (None, "", "") when it can't run or doesn't finish in time."""
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except (OSError, subprocess.TimeoutExpired):
        return None, "", ""


def gitlab():
    """Asks GitLab who we are through glab: what the panel itself will need."""
    if not shutil.which("glab"):
        return {"state": "missing", "detail": "未安裝 glab"}
    code, out, err = run("glab", "api", "user", timeout=20)
    if code == 0:
        try:  # stdout only: glab's notices (a new version) go to stderr
            return {"state": "ok", "detail": f"已登入（{json.loads(out)['username']}）"}
        except (ValueError, LookupError, TypeError):
            return {"state": "ok", "detail": "已登入"}
    if code is not None and re.search(r"401|unauthori[sz]ed|unauthenticated|no token|not logged in|auth login",
                                      out + err, re.I):
        return {"state": "logged_out", "detail": "尚未登入"}
    return {"state": "unknown", "detail": "無法連線至 GitLab，請稍後再試"}


def secret(item):
    text, _ = read_secret(*KEYS[item])
    if not text:
        return {"state": "missing", "detail": "尚未設定"}
    known = verified().get(item)
    out = ({"state": known["state"], "detail": known.get("detail") or ""}
           if isinstance(known, dict) and known.get("key") == fingerprint(text) and known.get("state")
           else {"state": "ok", "detail": "已設定"})
    if item == "openrouter":
        # Features with a key of their own don't use the one set here: say which they use.
        used = [(what, read_secret(own, *OPENROUTER_KEYS)[1]) for what, own in FEATURES]
        if any(name != OPENROUTER_KEYS[0] for _, name in used):
            out["detail"] += "；" + "、".join(f"{what}使用 {name}" for what, name in used)
    return out


def notifier():
    if shutil.which("terminal-notifier"):
        return {"state": "ok", "detail": "已安裝；需在「系統設定 → 通知」允許"}
    return {"state": "missing", "detail": "未安裝：通知仍會顯示，但點擊後無法切換至 agent"}


def claude():
    if not shutil.which("claude") and not os.path.exists(os.path.join(HOME, ".local/bin/claude")):
        return {"state": "missing", "detail": "未安裝 Claude Code"}
    try:
        with open(os.path.join(APP, "data/my-status/usage.json"), encoding="utf-8") as f:
            at = json.load(f).get("at", 0)
        if time.time() - at < 86400:
            return {"state": "ok", "detail": "已取得用量"}
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return {"state": "unknown", "detail": "尚未取得用量：請在 Claude Code 以 claude.ai 帳號登入（/login）"}


def verify(item):
    text, _ = read_secret(*KEYS[item])
    if not text:
        return secret(item)
    answer = ask(item, text)
    if answer["state"] in ("ok", "bad"):
        remember(item, text, answer)
        return secret(item)
    return answer


def ask(item, text):
    service = "OpenRouter" if item == "openrouter" else "Slack"
    if item == "openrouter":
        req = urllib.request.Request("https://openrouter.ai/api/v1/key", headers={
            "Authorization": "Bearer " + text, "User-Agent": "herdr-setup/1.0"})
    else:
        req = urllib.request.Request("https://slack.com/api/auth.test", data=b"", headers={
            "Authorization": "Bearer " + text, "User-Agent": "herdr-setup/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        return {"state": "bad", "detail": f"金鑰無效（HTTP {e.code}）" if e.code in (401, 403) else f"{service} 回應錯誤（HTTP {e.code}）"}
    # Never the error itself: some (a malformed header) quote the key.
    except (OSError, ValueError, http.client.HTTPException):
        return {"state": "unknown", "detail": f"無法連線至 {service}，請稍後再試"}
    if not isinstance(body, dict):
        return {"state": "unknown", "detail": f"無法連線至 {service}，請稍後再試"}
    if item == "slack":
        if not body.get("ok"):
            return {"state": "bad", "detail": f"Token 無效（{body.get('error', 'error')}）"}
        return {"state": "ok", "detail": f"已連線：{body.get('team', '')}（{body.get('user', '')}）"}
    left = (body.get("data") or {}).get("limit_remaining")
    return {"state": "ok", "detail": "可用" + (f"（剩餘額度 ${left:.2f}）" if isinstance(left, (int, float)) else "")}


CHECKS = {"gitlab": gitlab, "openrouter": lambda: secret("openrouter"), "slack": lambda: secret("slack"),
          "notifier": notifier, "claude": claude}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--verify" and sys.argv[2] in KEYS:
        json.dump({sys.argv[2]: verify(sys.argv[2])}, sys.stdout, ensure_ascii=False)
    else:
        # Named items only (the dialog asks for GitLab, the slow one, on its own).
        wanted = [k for k in sys.argv[1:] if k in CHECKS] or list(CHECKS)
        json.dump({k: CHECKS[k]() for k in wanted}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

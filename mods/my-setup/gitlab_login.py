#!/usr/bin/env python3
"""Logs glab in to gitlab.com through the browser (GitLab's own OAuth page),
answering glab's questions so the person only clicks Authorize. Prints
{"ok": true, "user": "..."} or {"ok": false, "error": "..."}.

  gitlab_login.py --open <url>   glab's browser: keeps the authorize URL (so the
                                 dialog can copy it for another browser profile)
                                 and opens it in the default browser
  gitlab_login.py --cancel       ends a login still waiting

glab only offers its web login interactively (a menu: Token / Web), so it runs
in a headless herdr-core terminal (`hc run --bg`, not shown anywhere); this reads
its screen and answers each menu: Web, SSH, otherwise the default. glab opens the browser
itself and stores the login (with its refresh token) in its own config.
"""
import json
import os
import shlex
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
APP = os.environ.get("HERDR_APP_HOME") or os.path.join(HOME, ".config/herdr-app")
URL_FILE = os.path.join(APP, "data/my-setup/gitlab-login-url")
NAME = "glab-login"
WAIT = 300  # seconds for the person to authorize in the browser
# glab's menus and the choice to make (by its text); any other menu: its default.
PICK = {"sign in": ("Web",), "git protocol": ("SSH",)}


def hc(*args, timeout=10):
    exe = shutil.which("hc") or os.path.join(HOME, ".local/bin/hc")
    try:
        r = subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except (OSError, subprocess.TimeoutExpired):
        return None, ""


def alive():
    """Whether glab is still running (a finished terminal stays readable)."""
    code, out = hc("ls", "--json")
    try:
        rows = json.loads(out) if code == 0 else []
        rows = rows if isinstance(rows, list) else rows.get("terminals", [])
        return any(t.get("name") == NAME and t.get("state") == "live" for t in rows)
    except (ValueError, AttributeError):
        return False


def logged_in():
    env = {k: v for k, v in os.environ.items() if k not in ("GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN")}
    try:
        r = subprocess.run(["glab", "api", "user"], capture_output=True, text=True, timeout=20, env=env)
        return json.loads(r.stdout).get("username") if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def done(**out):
    hc("kill", NAME)
    forget_url()
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.exit(0)


def forget_url():
    try:
        os.remove(URL_FILE)
    except OSError:
        pass


def keep_url(url):
    os.makedirs(os.path.dirname(URL_FILE), mode=0o700, exist_ok=True)
    fd = os.open(URL_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(url)
    try:
        subprocess.run(["open", url], timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        sys.exit(1)  # glab says it couldn't open a browser; the dialog can still copy the URL


def main():
    if sys.argv[1:2] == ["--open"] and len(sys.argv) == 3:
        return keep_url(sys.argv[2])
    if sys.argv[1:] == ["--cancel"]:
        hc("kill", NAME)
        return forget_url()
    if not shutil.which("glab"):
        done(ok=False, error="未安裝 glab")
    hc("kill", NAME)  # an earlier attempt still waiting
    forget_url()
    # The terminal gets herdr-core's environment, not this one: what must match is passed on.
    # HERDR_APP_HOME: --open keeps the URL where the dialog looks; GLAB_CONFIG_DIR: glab
    # saves the login where logged_in() reads it.
    same = [f"HERDR_APP_HOME={APP}"]
    if os.environ.get("GLAB_CONFIG_DIR"):
        same.append(f"GLAB_CONFIG_DIR={os.environ['GLAB_CONFIG_DIR']}")
    browser = f"{shlex.quote(sys.executable)} {shlex.quote(os.path.abspath(__file__))} --open"  # glab splits it like sh
    code, _ = hc("run", "--bg", "--no-notify", "--rm", "--name", NAME,
                 "env", "-u", "GITLAB_TOKEN", "-u", "GITLAB_ACCESS_TOKEN", "-u", "OAUTH_TOKEN", *same,
                 f"BROWSER={browser}",
                 "glab", "auth", "login", "--hostname", "gitlab.com")  # any other flag makes it non-interactive: no Web
    if code != 0:
        done(ok=False, error="無法啟動背景終端機（hc run）")
    answered, last = set(), ""
    end = time.time() + WAIT
    while time.time() < end:
        time.sleep(0.5)
        code, screen = hc("read", NAME)
        if code != 0 or not alive():  # glab finished, or was cancelled
            break
        last = screen
        # A menu: "┃ <question>" then its choices, "┃ > " before the selected one.
        rows = [l.strip().lstrip("┃").rstrip() for l in screen.splitlines() if l.strip().startswith("┃")]
        if not rows or rows[0] in answered:
            continue
        question, choices = rows[0].strip(), [r[3:].strip() for r in rows[1:]]
        cursor = next((i for i, r in enumerate(rows[1:]) if r.lstrip().startswith(">")), 0)
        want = next((i for i, c in enumerate(choices) if c in PICK.get(next((k for k in PICK if k in question.lower()), ""), ())), cursor)
        answered.add(rows[0])
        step = "down" if want > cursor else "up"
        hc("keys", NAME, *([step] * abs(want - cursor)), "enter")
    user = logged_in()
    if user:
        done(ok=True, user=user)
    tail = [l.strip() for l in last.splitlines() if l.strip()][-1:] or ["未完成"]
    done(ok=False, error="逾時：未在瀏覽器完成授權" if time.time() >= end else tail[0][:200])


if __name__ == "__main__":
    main()

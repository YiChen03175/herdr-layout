#!/usr/bin/env python3
"""Prints {"name": ...}: a tab name suggested from what its terminal is doing.

  suggest.py <terminal> [current name]

For Claude Code: the session's title, how it started (the person's first
messages), its latest compact summary, and its latest messages both ways; for anything else, the end of the terminal's screen. They go
to Claude Haiku 5.5 (reasoning effort medium) on OpenRouter, with common secret
shapes masked first. The key is in <app home>/secrets/openrouter-rename.key,
outside anything that gets exported. Every request is a line in
<app home>/data/my-rename/suggest.log: the terminal, the answer, time, provider,
whether it went on the account's own Anthropic key (BYOK) and the cost.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
APP = os.environ.get("HERDR_APP_HOME") or os.path.join(HOME, ".config/herdr-app")
KEY_FILE = os.path.join(APP, "secrets/openrouter-rename.key")
LOG_FILE = os.path.join(APP, "data/my-rename/suggest.log")
URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "anthropic/claude-haiku-5.5"
HEAD = 3              # the person's first this many messages of a Claude Code session
HEAD_MAX = 600        # characters kept of each (its start)
TAIL = 8              # the latest this many messages, both ways
MESSAGE_MAX = 700     # characters kept of each (its end)
SUMMARY_MAX = 3500    # characters of the latest compact summary (its start and end)
SCREEN_MAX = 3000     # characters kept of a screen
NAME_MAX = 40
SECRETS = [
    (re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}"), "***"),
    (re.compile(r"\b(ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA|AIza|glpat)[A-Za-z0-9_-]{10,}"), "***"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*"), "***"),
    (re.compile(r"(?i)\b(authorization|x-api-key|cookie)\s*:\s*[^'\"\n]+"), r"\1: ***"),
    (re.compile(r"(?i)\bbearer\s+\S+"), "Bearer ***"),
    (re.compile(r"(?i)([A-Z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key)[A-Z0-9_.-]*)(\s*[=:]\s*)(['\"]?)[^\s'\"]+\3"), r"\1\2***"),
    (re.compile(r"://[^/\s:@]+:[^/\s@]+@"), "://***@"),
]
INSTRUCTIONS = (
    "You name terminal tabs. The session below gives how it started, a summary of the earlier work (if it was long) "
    "and its latest messages. Name what the session as a whole is about: its main project or goal, "
    "with the current focus only if it fits. Suggest one short tab name: "
    "2 to 6 words, at most 30 characters, specific to this work (not generic like 'Coding session'). "
    "Write it in the language the person writes in. Reply with the name only: no quotes, no punctuation at the end."
)


def redact(text):
    for pattern, mask in SECRETS:
        text = pattern.sub(mask, text)
    return text


def hc(*args):
    exe = shutil.which("hc") or os.path.join(HOME, ".local/bin/hc")
    return subprocess.run([exe, *args], capture_output=True, text=True, timeout=10).stdout


def claude_session(pid):
    for p in glob.glob(os.path.join(HOME, ".claude/sessions/*.json")):
        try:
            d = json.load(open(p))
            if int(d["pid"]) == pid:
                return d["sessionId"]
        except Exception:
            pass
    return None


TAG = re.compile(r"<(system-reminder|local-command-[a-z]+|command-[a-z]+|bash-[a-z]+|task-notification)>.*?</\1>", re.S)


def clean(text):
    """Without the reminders and command wrappers Claude Code puts into messages."""
    return TAG.sub("", text).strip()


def text_of(entry):
    """What the person typed or what the agent replied, or None (tool use, results, notes)."""
    if entry.get("isSidechain") or entry.get("isMeta") or entry.get("isCompactSummary"):
        return None
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return (clean(content) or None) if entry.get("type") == "user" else None
    if not isinstance(content, list):
        return None
    if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return None
    text = clean("\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"))
    return text or None


def entries(lines):
    for line in lines:
        if b'"user"' not in line and b'"assistant"' not in line and b'"ai-title"' not in line:
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue


def lines_backward(path, limit=60_000_000):
    """Complete lines from the end of a file, last first (at most `limit` bytes back)."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        pos, rest, read = f.tell(), b"", 0
        while pos > 0 and read < limit:
            n = min(1 << 20, pos)
            pos -= n; read += n
            f.seek(pos)
            parts = (f.read(n) + rest).split(b"\n")
            rest = parts[0]
            yield from reversed(parts[1:])
        if pos == 0:
            yield rest


def claude_messages(session):
    """The session's start (the person's first messages), its latest compact summary,
    and its end (the latest messages both ways): the task, the story so far, now."""
    files = glob.glob(os.path.join(HOME, ".claude/projects/*", session + ".jsonl"))
    if not files:
        return None
    path = max(files, key=os.path.getmtime)
    head = []
    with open(path, "rb") as f:
        for e in entries(f):
            if e.get("type") == "user" and (t := text_of(e)):
                head.append(t[:HEAD_MAX])
                if len(head) >= HEAD:
                    break
    tail, summary, title = [], None, None
    def wanted(lines):
        # Once the tail is full, only the summary and title lines are worth parsing.
        for line in lines:
            if len(tail) < TAIL or b'"isCompactSummary":true' in line or b'"ai-title"' in line:
                yield line
    for e in entries(wanted(lines_backward(path))):
        if e.get("type") == "ai-title" and not title:
            title = e.get("aiTitle")
        elif e.get("isCompactSummary") and not summary:
            c = (e.get("message") or {}).get("content")
            c = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict))
            c = clean(c)
            c = c.split("Summary:", 1)[-1].strip()
            c = re.sub(r"^## What this work is for:.*?(?=^## )", "", c, flags=re.S | re.M).strip()  # boilerplate
            summary = c if len(c) <= SUMMARY_MAX else c[:SUMMARY_MAX * 2 // 3] + "\n…\n" + c[-SUMMARY_MAX // 3:]
        elif len(tail) < TAIL and e.get("type") in ("user", "assistant") and (t := text_of(e)):
            tail.append(("Person" if e["type"] == "user" else "Agent") + ": " + t[-MESSAGE_MAX:])
        if len(tail) >= TAIL and summary and title:
            break
    tail.reverse()
    parts = []
    if title:
        parts.append(f"Claude Code's own title for it: {title}")
    if head:
        parts.append("How it started (the person's first messages):\n" + "\n\n".join(f"Person: {h}" for h in head))
    if summary:
        parts.append("Summary of the earlier work (written when the conversation was compacted):\n" + summary)
    if tail:
        parts.append("Latest messages:\n" + "\n\n".join(tail))
    return "\n\n---\n\n".join(parts) or None


def context(terminal):
    info = json.loads(hc("get", terminal, "--json") or "{}")
    app = (info.get("status") or {}).get("app")
    if app == "claude-code":
        session = claude_session((info.get("foreground") or {}).get("pid"))
        text = session and claude_messages(session)
        if text:
            return "claude-code", text
    screen = hc("read", terminal, "--lines", "60")
    screen = "\n".join(l.rstrip() for l in screen.splitlines() if l.strip())
    return app or "terminal", screen[-SCREEN_MAX:]


def log(entry):
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with os.fdopen(os.open(LOG_FILE, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600), "a") as f:
            f.write(json.dumps({"time": time.strftime("%Y-%m-%d %H:%M:%S"), **entry}, ensure_ascii=False) + "\n")
    except OSError:
        pass


def main():
    terminal = sys.argv[1]
    current = sys.argv[2] if len(sys.argv) > 2 else ""
    kind, text = context(terminal)
    if not text:
        sys.exit("suggest.py: nothing to go on")
    with open(KEY_FILE) as f:
        key = f.read().strip()
    prompt = f"{INSTRUCTIONS}\n\nCurrent tab name: {current or '(none)'}\nProgram: {kind}\n\n<session>\n{redact(text)}\n</session>"
    body = json.dumps({"model": MODEL, "reasoning": {"effort": "medium"}, "max_tokens": 4000, "usage": {"include": True},
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "herdr-rename/1.0"})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            reply = json.load(r)
    except (OSError, urllib.error.URLError) as e:
        error = f"{type(e).__name__} {getattr(e, 'code', '')}".strip()
        log({"terminal": terminal, "error": error})
        sys.exit(f"suggest.py: {error}")
    name = ((reply.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    name = name.strip().splitlines()[0].strip().strip("\"'「」“”`").strip()[:NAME_MAX] if name.strip() else ""
    # BYOK: OpenRouter sends it on the account's own Anthropic key (cost 0 here; Anthropic bills upstream).
    usage = reply.get("usage") or {}
    log({"terminal": terminal, "kind": kind, "name": name, "seconds": round(time.time() - started, 2),
         "provider": reply.get("provider"), "byok": usage.get("is_byok"), "cost": usage.get("cost"),
         "upstream_cost": (usage.get("cost_details") or {}).get("upstream_inference_cost"),
         "tokens": [usage.get("prompt_tokens"), usage.get("completion_tokens"),
                    (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")]})
    if not name:
        sys.exit("suggest.py: empty answer")
    json.dump({"name": name}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

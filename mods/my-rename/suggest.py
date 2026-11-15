#!/usr/bin/env python3
"""Prints {"name": ...}: a tab name suggested from what its terminal is doing.

  suggest.py <terminal> [current name]

For Claude Code: the session's title, how it started (the person's first
messages), its latest compact summary, and its latest messages both ways; for
anything else, the end of the terminal's screen. They go to Claude Haiku 5.5
(reasoning effort medium) on OpenRouter, with common secret shapes masked first.
The key is in <app home>/secrets/ (its own openrouter-rename.key if there is one,
else openrouter.key from my-setup), outside anything that gets exported. Every
request is a line in <app home>/data/my-rename/suggest.log: the terminal, the
answer, time, provider, whether it went on the account's own Anthropic key
(BYOK) and the cost.
"""
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

# Shared with my-agents (installed alongside): secret masking, the log, the key.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "my-agents"))
from common import APP, log as common_log, openrouter_key, redact  # noqa: E402
from recap import claude_sessions, claude_transcript, lines_backward  # noqa: E402

HOME = os.path.expanduser("~")
NO_KEY = 3            # exit code without an OpenRouter key: the dialog offers to set one
LOG_FILE = os.path.join(APP, "data/my-rename/suggest.log")
URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "anthropic/claude-haiku-5.5"
HEAD = 3              # the person's first this many messages of a Claude Code session
HEAD_MAX = 600        # characters kept of each (its start)
TAIL = 8              # the latest this many messages, both ways
MESSAGE_MAX = 700     # characters kept of each (its end)
SUMMARY_MAX = 3500    # characters of the latest compact summary (its start and end)
SCREEN_MAX = 3000     # characters kept of a screen
BACK_MAX = 8_000_000  # bytes of a transcript read back from its end, at most
NAME_MAX = 40
INSTRUCTIONS = (
    "You name terminal tabs. The session below gives how it started, a summary of the earlier work (if it was long) "
    "and its latest messages. Name what the session as a whole is about: its main project or goal, "
    "with the current focus only if it fits. Suggest one short tab name: "
    "2 to 6 words, at most 30 characters, specific to this work (not generic like 'Coding session'). "
    "Write it in the language the person writes in. Reply with the name only: no quotes, no punctuation at the end."
)


def hc(*args):
    exe = shutil.which("hc") or os.path.join(HOME, ".local/bin/hc")
    return subprocess.run([exe, *args], capture_output=True, text=True, timeout=10).stdout


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


def claude_messages(session):
    """The session's start (the person's first messages), its latest compact summary,
    and its end (the latest messages both ways): the task, the story so far, now."""
    path = claude_transcript(session)
    if not path:
        return None
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
    for e in entries(wanted(lines_backward(path, BACK_MAX))):
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
        session = claude_sessions().get((info.get("foreground") or {}).get("pid"))
        text = session and claude_messages(session)
        if text:
            return "claude-code", text
    screen = hc("read", terminal, "--lines", "60")
    screen = "\n".join(l.rstrip() for l in screen.splitlines() if l.strip())
    return app or "terminal", screen[-SCREEN_MAX:]


def log(entry):
    common_log(LOG_FILE, entry)


def main():
    terminal = sys.argv[1]
    current = sys.argv[2] if len(sys.argv) > 2 else ""
    key = openrouter_key("openrouter-rename.key")
    if not key:
        print("suggest.py: no OpenRouter key (set one in my-setup)", file=sys.stderr)
        sys.exit(NO_KEY)
    kind, text = context(terminal)
    if not text:
        sys.exit("suggest.py: nothing to go on")
    prompt = f"{INSTRUCTIONS}\n\nCurrent tab name: {redact(current) or '(none)'}\nProgram: {kind}\n\n<session>\n{redact(text)}\n</session>"
    body = json.dumps({"model": MODEL, "reasoning": {"effort": "medium"}, "max_tokens": 4000, "usage": {"include": True},
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "herdr-rename/1.0"})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            reply = json.load(r)
    except (OSError, ValueError, http.client.HTTPException) as e:  # urllib's errors are OSErrors
        # Only the error's kind: some (a malformed header) quote the key.
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
                    (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")],
         # An answer can be an error with HTTP 200 (the provider failed): keep what it said.
         **({"error": redact(json.dumps(reply["error"], ensure_ascii=False))[:300]} if reply.get("error") else {})})
    if not name:
        sys.exit("suggest.py: empty answer")
    json.dump({"name": name}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

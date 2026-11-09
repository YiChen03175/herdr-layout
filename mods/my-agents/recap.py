#!/usr/bin/env python3
"""Prints {terminal: {text, at, agent}} for agents whose latest event is a recap.

An agent finds its terminal through its own environment (HC_TERMINAL_ID, which
herdr-core sets on every terminal it runs). A recap counts until the person
sends the next message; after that the agent has none.

- Claude Code: ~/.claude/sessions/<pid>.json -> session id -> the transcript's
  last `away_summary` (system) entry, unless a real user message came after it.
- Grok: ~/.grok/active_sessions.json -> session id -> updates.jsonl's last
  `session_recap`, unless a `user_message_chunk` came after it.
- opencode has no recap of its own, so it never shows one.
"""
import glob
import json
import os
import re
import subprocess
import sys
import urllib.parse

HOME = os.path.expanduser("~")
CHUNK = 256 * 1024
MAX_BACK = 16 * 1024 * 1024  # never read more than this far back in a file


def lines_backward(path):
    """Yields complete lines from the end of a file, last first."""
    try:
        f = open(path, "rb")
    except OSError:
        return
    with f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        rest = b""
        read = 0
        while pos > 0 and read < MAX_BACK:
            n = min(CHUNK, pos)
            pos -= n
            read += n
            f.seek(pos)
            buf = f.read(n) + rest
            parts = buf.split(b"\n")
            rest = parts[0]  # maybe partial; joined with the next chunk
            for line in reversed(parts[1:]):
                if line.strip():
                    yield line
        if pos == 0 and rest.strip():
            yield rest


def env_terminals(pids):
    """pid -> (HC_TERMINAL_ID, argv[0]) for the live ones among `pids`.

    Exits non-zero when `ps` can't answer: an empty answer would read as
    "no agent has a recap" and make the mod forget which ones were read.
    """
    if not pids:
        return {}
    try:
        out = subprocess.run(["ps", "-E", "-ww", "-o", "pid=,command=", "-p", ",".join(map(str, pids))],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        sys.exit(1)
    found = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\S+)\s", line)
        t = re.search(r"(?:^|\s)HC_TERMINAL_ID=(\S+)", line)
        if m and t:
            found[int(m.group(1))] = (t.group(1), m.group(2))
    return found


def claude_sessions():
    """pid -> session id, from Claude Code's per-process files."""
    out = {}
    for p in glob.glob(os.path.join(HOME, ".claude/sessions/*.json")):
        try:
            d = json.load(open(p))
            out[int(d["pid"])] = d["sessionId"]
        except Exception:
            pass
    return out


def human(entry):
    """A message the person sent (not a tool result, a meta note or a summary)."""
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isCompactSummary") or entry.get("isVirtual"):
        return False
    c = (entry.get("message") or {}).get("content")
    if isinstance(c, str):
        return True
    if isinstance(c, list):
        return any(isinstance(b, dict) and b.get("type") == "text" for b in c) and \
            not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
    return False


def claude_recap(session):
    files = glob.glob(os.path.join(HOME, ".claude/projects/*", session + ".jsonl"))
    if not files:
        return None
    for line in lines_backward(max(files, key=os.path.getmtime)):
        if b'"away_summary"' not in line and b'"user"' not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") == "system" and e.get("subtype") == "away_summary":
            text = re.sub(r"\s*\(disable recaps in /config\)\s*$", "", e.get("content") or "").strip()
            return {"text": text, "at": e.get("timestamp"), "agent": "claude"} if text else None
        if human(e):
            return None
    return None


def grok_sessions():
    """pid -> (session id, cwd), from Grok's list of open sessions."""
    out = {}
    try:
        for d in json.load(open(os.path.join(HOME, ".grok/active_sessions.json"))):
            out[int(d["pid"])] = (d["session_id"], d.get("cwd") or "")
    except Exception:
        pass
    return out


def grok_recap(session, cwd):
    base = os.path.join(HOME, ".grok/sessions")
    path = os.path.join(base, urllib.parse.quote(cwd, safe=""), session, "updates.jsonl")
    if not os.path.exists(path):
        found = glob.glob(os.path.join(base, "*", session, "updates.jsonl"))
        if not found:
            return None
        path = found[0]
    for line in lines_backward(path):
        if b'"session_recap"' not in line and b'"user_message_chunk"' not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        u = (e.get("params") or {}).get("update") or {}
        kind = u.get("sessionUpdate")
        if kind == "session_recap":
            text = (u.get("summary") or "").strip()
            at = e.get("timestamp")
            return {"text": text, "at": at * 1000 if isinstance(at, (int, float)) else at, "agent": "grok"} if text else None
        if kind == "user_message_chunk":
            return None
    return None


def main():
    claude = claude_sessions()
    grok = grok_sessions()
    terms = env_terminals(sorted(set(claude) | set(grok)))
    out = {}
    for pid, (term, name) in terms.items():
        # A session file whose Claude Code is gone can name a pid some other
        # program reuses now: only a live claude (or the node running it) counts.
        if pid in claude and not re.search(r"claude|node", name, re.I):
            continue
        try:
            r = claude_recap(claude[pid]) if pid in claude else grok_recap(*grok[pid])
        except Exception:
            r = None
        if r:
            out[term] = r
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

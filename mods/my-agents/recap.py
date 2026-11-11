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

Every agent also gets `last`: the start of its latest reply, cut to about five
lines of the card, for when there is no recap to show.

- Claude Code: the transcript's last assistant text.
- Grok: the last run of `agent_message_chunk`s in updates.jsonl.
- opencode: the running server (`opencode api`), for the session in the terminal's
  folder whose title the terminal shows ("OC | <title>").
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse

HOME = os.path.expanduser("~")
CHUNK = 256 * 1024
MAX_BACK = 16 * 1024 * 1024  # never read more than this far back in a file
CARD_LINES = 5
CARD_LINE = 36  # what one line of the card holds, counting a wide (CJK) character as 2


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
    """pid -> HC_TERMINAL_ID for the live ones among `pids`."""
    if not pids:
        return {}
    try:
        out = subprocess.run(["ps", "-E", "-ww", "-o", "pid=,command=", "-p", ",".join(map(str, pids))],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return {}
    found = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s", line)
        t = re.search(r"(?:^|\s)HC_TERMINAL_ID=(\S+)", line)
        if m and t:
            found[int(m.group(1))] = t.group(1)
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


def claude_last(session):
    """The text of the session's latest assistant message, with its time."""
    files = glob.glob(os.path.join(HOME, ".claude/projects/*", session + ".jsonl"))
    if not files:
        return None, None
    for line in lines_backward(max(files, key=os.path.getmtime)):
        if b'"assistant"' not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "assistant" or e.get("isSidechain"):
            continue
        content = (e.get("message") or {}).get("content") or []
        text = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text").strip()
        if text:
            return text, e.get("timestamp")
    return None, None


def card_text(text):
    """Markdown marks dropped and cut to the card's lines, with an ellipsis if anything was left out."""
    lines = []
    for line in text.splitlines():
        line = re.sub(r"\*\*|__|`", "", re.sub(r"^\s*#+\s*", "", line)).strip()
        if line and not re.fullmatch(r"\|?[\s:|-]+\|?|-{3,}", line):
            lines.append(line)
    out, room = [], CARD_LINES * CARD_LINE
    for i, line in enumerate(lines):
        width = 0
        for j, ch in enumerate(line):
            width += 2 if ord(ch) > 0x2E80 else 1
            if width > room:
                out.append(line[:max(j - 1, 0)].rstrip() + "…")
                return "\n".join(out)
        out.append(line)
        # A line takes whole card lines, even when it ends early.
        room -= -(-width // CARD_LINE) * CARD_LINE
        if room <= 0 and i < len(lines) - 1:
            out[-1] = out[-1] + "…"
            break
    return "\n".join(out)


def grok_sessions():
    """pid -> (session id, cwd), from Grok's list of open sessions."""
    out = {}
    try:
        for d in json.load(open(os.path.join(HOME, ".grok/active_sessions.json"))):
            out[int(d["pid"])] = (d["session_id"], d.get("cwd") or "")
    except Exception:
        pass
    return out


def grok_updates(session, cwd):
    base = os.path.join(HOME, ".grok/sessions")
    path = os.path.join(base, urllib.parse.quote(cwd, safe=""), session, "updates.jsonl")
    if os.path.exists(path):
        return path
    found = glob.glob(os.path.join(base, "*", session, "updates.jsonl"))
    return found[0] if found else None


def grok_recap(session, cwd):
    path = grok_updates(session, cwd)
    if not path:
        return None
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


def grok_last(session, cwd):
    """The latest reply: the chunks after the last tool call or message from the person."""
    path = grok_updates(session, cwd)
    parts, at = [], None
    for line in lines_backward(path) if path else ():
        if b"sessionUpdate" not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        u = (e.get("params") or {}).get("update") or {}
        kind = u.get("sessionUpdate")
        if kind == "agent_message_chunk":
            c = u.get("content") or {}
            if c.get("type") == "text":
                parts.append(c.get("text") or "")
                at = at or e.get("timestamp")
        elif kind in ("user_message_chunk", "tool_call", "tool_call_update") and "".join(parts).strip():
            break
    text = "".join(reversed(parts)).strip()
    return (text, at * 1000 if isinstance(at, (int, float)) else at) if text else (None, None)


def run_json(exe, fallback, *args):
    exe = shutil.which(exe) or os.path.join(HOME, fallback)
    return json.loads(subprocess.run([exe, *args], capture_output=True, text=True, timeout=10).stdout)


def opencode_last():
    """terminal -> (text, at) for opencode terminals, from the server they share."""
    hc = lambda *a: run_json("hc", ".local/bin/hc", *a, "--json")
    api = lambda *a: run_json("opencode", ".opencode/bin/opencode", "api", *a)
    listed = hc("ls")
    listed = listed if isinstance(listed, list) else listed.get("terminals", [])
    out, folders = {}, {}
    for t in listed:
        if t.get("agent") != "opencode" or t.get("state") != "live":
            continue
        try:
            g = hc("get", t["address"])
            shown = re.sub(r"^OC \| ", "", g.get("title") or "", count=1).strip()
            cwd = (g.get("foreground") or {}).get("cwd") or t.get("cwd")
            if not shown or shown == g.get("title") or not cwd:
                continue
            if cwd not in folders:
                folders[cwd] = api("session.list", "--param", f"directory={cwd}")
            sessions = folders[cwd] if isinstance(folders[cwd], list) else folders[cwd].get("data", [])
            # The title may be cut short in the terminal's.
            match = [s for s in sessions if s.get("title") == shown] or \
                    [s for s in sessions if (s.get("title") or "").startswith(shown.rstrip("…. "))]
            if not match:
                continue
            session = max(match, key=lambda s: (s.get("time") or {}).get("updated") or 0)
            for m in api("session.message.list", "--param", f"sessionID={session['id']}", "--param", "limit=20").get("data", []):
                text = "\n".join(c.get("text", "") for c in m.get("content") or [] if c.get("type") == "text").strip()
                if m.get("type") == "assistant" and text:
                    tm = m.get("time") or {}
                    out[t["address"]] = (text, tm.get("completed") or tm.get("created"))
                    break
        except Exception:
            continue
    return out


def main():
    claude = claude_sessions()
    grok = grok_sessions()
    terms = env_terminals(sorted(set(claude) | set(grok)))
    out = {}
    for pid, term in terms.items():
        try:
            r = claude_recap(claude[pid]) if pid in claude else grok_recap(*grok[pid])
        except Exception:
            r = None
        try:
            text, at = claude_last(claude[pid]) if pid in claude else grok_last(*grok[pid])
        except Exception:
            text = None
        last = {"text": card_text(text), "at": at} if text else None
        if r or last:
            out[term] = {**(r or {}), **({"last": last} if last else {})}
    try:
        for term, (text, at) in opencode_last().items():
            out.setdefault(term, {})["last"] = {"text": card_text(text), "at": at}
    except Exception:
        pass
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

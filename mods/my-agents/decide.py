#!/usr/bin/env python3
"""Prints {terminal: {status, state, confidence}} for agents that stopped with shells still open.

A Claude Code turn can end while its background commands run: either it's
waiting to be woken by them, or it's finished and they're servers left on
purpose. Herdr says "done" for both. This asks a decision model, given the
agent's last message and the open commands, and maps the answer to a status:
waiting -> working, need_user -> blocked, done and unclear -> none (the status
stands). `blocked` and `working` agents are never asked about.

The key is in <app home>/secrets/ (its own openrouter-decider.key if there is
one, else openrouter.key from my-setup), outside anything that gets exported.
The message and commands leave this computer, with common secret shapes masked
first. Answers are cached, so a stopped agent is asked about once.

Every request is a line in <app home>/data/my-agents/decisions.log: what was sent,
what came back and the status it became. A stopped agent that wasn't asked about
gets one line saying why.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

sys.dont_write_bytecode = True  # no __pycache__ in the mod folder
from recap import claude_last, claude_sessions, hc, hc_terminals
from common import APP, log as common_log, openrouter_key, redact, write_json

CACHE_FILE = os.path.join(APP, "data/my-agents/decisions.json")
LOG_FILE = os.path.join(APP, "data/my-agents/decisions.log")
SEEN_FILE = os.path.join(APP, "data/my-agents/decisions-skipped.json")
URL = "https://openrouter.ai/api/alpha/decisions"
MODEL = "perplexity/pplx-decider-flash-v1.2"
MIN_MESSAGE = 8        # shorter than this says nothing: unclear, without asking
RETRY_AFTER = 60       # seconds before asking again after a failed request
CACHE_MAX = 300
LOG_MAX = 2 * 1024 * 1024  # bytes; one older file is kept as decisions.log.1
COMMAND_MAX = 1500     # cut shorter, the model can't see what a long command goes on to do
EPHEMERAL = 32768      # ports from here up are random (a test's browser), not a server left running
STATUS = {"waiting": "working", "need_user": "blocked"}
QUESTION = {"agent_state": {
    "type": "choice",
    "instructions": "A coding agent ended its turn while shell commands are still open in the background. "
                    "Using its last message and the open commands, what is the agent's state?",
    "criteria": {
        "waiting": "The agent expects to continue when a background command finishes; its message says work is still running or describes next steps after it.",
        "done": "The agent's work is finished; the open commands are dev servers, watchers or other long-running processes left on purpose.",
        "need_user": "The agent asked the person a question or is waiting for the person's decision.",
        "unclear": "The message and commands do not settle which of the other states applies.",
    },
}}


def processes():
    out = subprocess.run(["ps", "-axww", "-o", "pid=,ppid=,command="], capture_output=True, text=True, timeout=10).stdout
    kids = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(.*)", line)
        if m:
            kids.setdefault(int(m[2]), []).append((int(m[1]), m[3]))
    return kids


def walk(kids, pid):
    for child in kids.get(pid, []):
        yield child
        yield from walk(kids, child[0])


def listening():
    out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"], capture_output=True, text=True, timeout=10).stdout
    ports, pid = {}, None
    for line in out.splitlines():
        if line[:1] == "p":
            pid = int(line[1:])
        elif line[:1] == "n":
            port = line[1:].rsplit(":", 1)[-1]
            if port.isdigit() and int(port) < EPHEMERAL:
                ports.setdefault(pid, set()).add(port)
    return ports


def command_of(shell):
    """What the agent asked to run, out of the wrapper Claude Code runs it in."""
    i = shell.find("eval '")
    if i < 0:
        return None
    text = shell[i + 6:]
    end = re.search(r"'\s*\\?<\s*/dev/null", text)
    return (text[:end.start()] if end else text).replace("'\\''", "'").strip()[:COMMAND_MAX]


def last_message(session):
    text, _ = claude_last(session)
    return text[-2000:] if text else None


def ask(state, api_key):
    import urllib.request  # only here: most runs never ask
    body = json.dumps({"model": MODEL, "state": state, "questions": QUESTION}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": "Bearer " + api_key, "Content-Type": "application/json", "User-Agent": "herdr-agent-state/1.0"})
    started = time.time()
    with urllib.request.urlopen(req, timeout=15) as r:
        reply = json.load(r)
    answer = reply["answers"]["agent_state"]
    # Whichever of the four scored highest is the state.
    probabilities = answer.get("probabilities") or {}
    state = max(probabilities, key=probabilities.get) if probabilities else answer.get("choice")
    if answer.get("type") != "choice" or state not in QUESTION["agent_state"]["criteria"]:
        raise ValueError("unexpected answer")
    verdict = {"state": state, "confidence": round(answer.get("confidence") or 0, 3)}
    return verdict, {"probabilities": probabilities,
                     "seconds": round(time.time() - started, 2), "cost": (reply.get("usage") or {}).get("cost")}


def load_json(path):
    """The dict in a file of ours, or {} (none yet, or unreadable: it's only a cache)."""
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def log(entry):
    common_log(LOG_FILE, entry, LOG_MAX)


def skip(seen, context, reason):
    """Logs why an agent wasn't asked about, once until the reason changes."""
    if seen.get(context["terminal"]) != reason:
        seen[context["terminal"]] = reason
        log({**context, "skipped": reason})


def judge(message, shells, ports_of, cache, context, api_key):
    """The cached or new answer, or None while the model can't be reached.
    shells: [(pid, command)]; ports_of(pid) is only called when the model is asked."""
    message = redact(message)
    commands = [redact(c) for _, c in shells]
    # Without the ports: they come and go during a run, and one stop is asked about once.
    identity = {"last_message": message, "commands": sorted(commands)}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    hit = cache.get(key)
    if hit and (hit.get("state") or time.time() - hit.get("at", 0) < RETRY_AFTER):
        return hit if hit.get("state") else None
    state = {"last_message": message,
             "open_commands": [{"command": c, "listening_ports": ports_of(pid)} for (pid, _), c in zip(shells, commands)]}
    try:
        verdict, detail = ask(state, api_key)
    except Exception as e:  # unreachable, refused, or an answer not in the shape asked for: retried after RETRY_AFTER
        error = f"{type(e).__name__} {getattr(e, 'code', '')}".strip()
        print(f"decide.py: {error}", file=sys.stderr)
        log({**context, "sent": state, "error": error})
        cache[key] = {"at": time.time()}
        return None
    cache[key] = {**verdict, "at": time.time()}
    log({**context, "sent": state, **detail, **verdict, "status": STATUS.get(verdict["state"])})
    return cache[key]


def main():
    # Only Claude Code agents on this computer: the rest is never asked about.
    stopped = [t["address"] for t in hc_terminals() if t.get("agent") == "claude-code"
               and t.get("status") in ("done", "idle") and "/" not in t["address"]]
    out, seen = {}, load_json(SEEN_FILE)
    seen_before = dict(seen)
    if stopped:
        kids, sessions, cache = processes(), claude_sessions(), load_json(CACHE_FILE)
        before = json.dumps(cache, sort_keys=True)
        api_key = openrouter_key("openrouter-decider.key")
        lsof = None

        def ports_of(pid):
            """The ports a shell and its children listen on (one lsof per run, when asked)."""
            nonlocal lsof
            lsof = listening() if lsof is None else lsof
            return sorted(set(lsof.get(pid, ())).union(*[lsof.get(c[0], ()) for c in walk(kids, pid)]))

        try:
            for address in stopped:
                t = hc("get", address)
                if (t.get("status") or {}).get("app") != "claude-code":
                    continue
                shells = [p for p in walk(kids, t.get("pid")) if "/.claude/shell-snapshots/" in p[1]]
                session = sessions.get((t.get("foreground") or {}).get("pid"))
                context = {"terminal": address, "native": t["status"].get("state"), "session": session}
                if not session:
                    skip(seen, context, "no_session")
                    continue
                if not shells:
                    skip(seen, context, "no_open_shell")
                    continue
                message = last_message(session)
                if not message or len(message) < MIN_MESSAGE:
                    skip(seen, context, "no_message" if not message else "short_message")
                    continue
                # Without a key nothing can be asked: say so once, rather than an error a minute.
                if not api_key:
                    skip(seen, context, "no_key")
                    continue
                seen.pop(address, None)
                commands = [(pid, command_of(line) or " ".join(c[1] for c in kids.get(pid, []))[:COMMAND_MAX]) for pid, line in shells]
                answer = judge(message, commands, ports_of, cache, context, api_key)
                if answer:
                    out[address] = {"status": STATUS.get(answer["state"]), "state": answer["state"], "confidence": answer["confidence"]}
        finally:  # what was asked stays asked, even when a later agent fails this run
            if json.dumps(cache, sort_keys=True) != before:
                write_json(CACHE_FILE, dict(sorted(cache.items(), key=lambda kv: kv[1].get("at", 0))[-CACHE_MAX:]))
    seen = {k: v for k, v in seen.items() if k in stopped}  # a new stop logs again
    if seen != seen_before:
        write_json(SEEN_FILE, seen)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()

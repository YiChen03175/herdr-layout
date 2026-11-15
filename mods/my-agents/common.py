"""Helpers the my-agents and my-rename scripts share: masking secret-shaped text
before it leaves the computer, a size-capped JSON-lines log, and the OpenRouter key."""
import json
import os
import re
import sys
import time

APP = os.environ.get("HERDR_APP_HOME") or os.path.join(os.path.expanduser("~"), ".config/herdr-app")
# The first of these that exists is the key: the one the setup dialog (my-setup)
# writes, then the older per-feature files.
OPENROUTER_KEYS = ("openrouter.key", "openrouter-rename.key", "openrouter-decider.key")

SECRETS = [
    (re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}"), "***"),
    (re.compile(r"\b(ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA|AIza|glpat)[A-Za-z0-9_-]{10,}"), "***"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*"), "***"),
    (re.compile(r"(?i)\b(authorization|x-api-key|cookie)\s*:\s*[^'\"\n]+"), r"\1: ***"),
    (re.compile(r"(?i)\bbearer\s+\S+"), "Bearer ***"),
    (re.compile(r"(?i)([A-Z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key)[A-Z0-9_.-]*)(\s*[=:]\s*)(['\"]?)[^\s'\"]+\3"), r"\1\2***"),
    (re.compile(r"(?i)(--?[a-z0-9-]*(?:token|secret|passw(?:or)?d|api-?key)[a-z0-9-]*)\s+\S+"), r"\1 ***"),
    (re.compile(r"://[^/\s:@]+:[^/\s@]+@"), "://***@"),
]


def redact(text):
    for pattern, mask in SECRETS:
        text = pattern.sub(mask, text)
    return text


def openrouter_key(*prefer):
    """The OpenRouter key: from `prefer` (file names under secrets/) first, then the shared ones. None without one."""
    for name in (*prefer, *OPENROUTER_KEYS):
        try:
            with open(os.path.join(APP, "secrets", name)) as f:
                key = f.read().strip()
            if key:
                return key
        except OSError:
            pass
    return None


def log(path, entry, max_bytes=2 * 1024 * 1024):
    """Appends entry (with the time) as a JSON line, 0600; past max_bytes, one older file is kept as <path>.1."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path) and os.path.getsize(path) > max_bytes:
            os.replace(path, path + ".1")
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600), "a") as f:
            f.write(json.dumps({"time": time.strftime("%Y-%m-%d %H:%M:%S"), **entry}, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"{os.path.basename(sys.argv[0])}: log: {type(e).__name__}", file=sys.stderr)

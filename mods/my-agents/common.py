"""Helpers the my-agents, my-rename and my-setup scripts share: masking secret-shaped
text before it leaves the computer, reading the keys in secrets/, a size-capped
JSON-lines log, and a private JSON file written in one step."""
import json
import os
import re
import sys
import tempfile
import time

APP = os.environ.get("HERDR_APP_HOME") or os.path.join(os.path.expanduser("~"), ".config/herdr-app")
SECRETS_DIR = os.path.join(APP, "secrets")
# The first of these that exists is the key: the one the setup dialog (my-setup)
# writes, then the older per-feature files.
OPENROUTER_KEYS = ("openrouter.key", "openrouter-rename.key", "openrouter-decider.key")

# The value after a secret-sounding name: quoted (spaces and all), or up to the next space.
_VALUE = r"(?:(['\"])[^'\"\n]*\3|[^\s'\"]+)"
SECRETS = [
    (re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}"), "***"),
    (re.compile(r"\b(ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA|AIza|glpat)[A-Za-z0-9_-]{10,}"), "***"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*"), "***"),
    (re.compile(r"(?i)\b(authorization|x-api-key|cookie)\s*:\s*[^'\"\n]+"), r"\1: ***"),
    (re.compile(r"(?i)\bbearer\s+\S+"), "Bearer ***"),
    # NAME=value, NAME: value, and JSON's "name": "value". The name is matched from its
    # start only (the lookbehind): from every character of a long run it takes seconds.
    (re.compile(r"(?i)(?<![A-Z0-9_.-])([A-Z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key)[A-Z0-9_.-]*)(['\"]?\s*[=:]\s*)" + _VALUE),
     r"\1\2***"),
    (re.compile(r"(?i)(?<![a-z0-9-])(--?[a-z0-9-]*(?:token|secret|passw(?:or)?d|api-?key)[a-z0-9-]*)\s+\S+"), r"\1 ***"),
    (re.compile(r"://[^/\s:@]+:[^/\s@]+@"), "://***@"),
]


def redact(text):
    for pattern, mask in SECRETS:
        text = pattern.sub(mask, text)
    return text


def read_secret(*names):
    """(text, file name) of the first of `names` under secrets/ that isn't empty; (None, None) without one."""
    for name in names:
        try:
            with open(os.path.join(SECRETS_DIR, name), encoding="utf-8") as f:
                text = f.read().strip()
        except (OSError, ValueError):  # missing, unreadable, or not text
            continue
        if text:
            return text, name
    return None, None


def openrouter_key(*prefer):
    """The OpenRouter key: from `prefer` (file names under secrets/) first, then the shared ones. None without one."""
    return read_secret(*prefer, *OPENROUTER_KEYS)[0]


def write_json(path, obj):
    """Writes obj to path in one step (a reader sees the old file or the new one), 0600; a new folder is 0700."""
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=os.path.basename(path) + ".", suffix=".tmp")  # 0600
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def log(path, entry, max_bytes=2 * 1024 * 1024):
    """Appends entry (with the time) as a JSON line, 0600; past max_bytes, one older file is kept as <path>.1."""
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        if os.path.exists(path) and os.path.getsize(path) > max_bytes:
            os.replace(path, path + ".1")
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8", errors="replace") as f:
            f.write(json.dumps({"time": time.strftime("%Y-%m-%d %H:%M:%S"), **entry}, ensure_ascii=False) + "\n")
    except (OSError, ValueError) as e:
        print(f"{os.path.basename(sys.argv[0])}: log: {type(e).__name__}", file=sys.stderr)

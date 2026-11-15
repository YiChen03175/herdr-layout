#!/bin/bash
# Installs this layout into Herdr on this machine. Safe to run again: whatever
# it replaces is copied to ~/.config/herdr-app-backups/<time>/ first, and what
# is already the same is left alone.
#
#   ./install.sh               layout, mods, sounds and Claude Code's status line
#   ./install.sh --plan        only say what would be added or replaced; change nothing
#   ./install.sh --no-claude   leave Claude Code's settings alone
#
# Afterwards the Accounts & keys dialog (my-setup) opens: logins and API keys
# are set there, never in this repo.
set -euo pipefail

REPO="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# Herdr's own variable for another app folder (`herdr-app --help`).
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
LAYOUT="my-main"
SL="$HOME/.claude/statusline-command.sh"
SOUNDS='{"enabled": true, "done": "sounds/done.mp3", "blocked": "sounds/blocked.mp3"}'
CLAUDE=1
PLAN=0

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,/^set /s/^# \{0,1\}//p' "$0"; exit 0 ;;
    --plan|--dry-run) PLAN=1 ;;
    --no-claude|--no-agents) CLAUDE=0 ;;
    *) echo "不認得的參數：${arg}（見 --help）" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
note() { printf '\033[33m!\033[0m %s\n' "$*"; }

[ -d "$APP" ] || { echo "找不到 ${APP}：請先安裝 Herdr 並開啟一次。" >&2; exit 1; }
python3 -c 'import json' >/dev/null 2>&1 || { echo "需要 python3。" >&2; exit 1; }
command -v jq >/dev/null || note "沒有 jq：Claude Code 的 status line 需要它（brew install jq）。"
command -v terminal-notifier >/dev/null || note "沒有 terminal-notifier：點通知跳回 agent 需要它（brew install terminal-notifier）。"
command -v glab >/dev/null || note "沒有 glab：GitLab 面板需要它（brew install glab && glab auth login）。"

# Every my-* mod in the repo. Mods of other names on the machine are left alone.
MODS=()
for d in "$REPO"/mods/my-*/; do
  if [ -d "$d" ]; then d="${d%/}"; MODS+=("${d##*/}"); fi
done
[ "${#MODS[@]}" -gt 0 ] || { echo "${REPO}/mods 裡沒有 my-* mod。" >&2; exit 1; }

# Same files, leaving out what Herdr (gpui-kit.d.ts, jsconfig.json) or the system writes.
EXCLUDE=(-x .DS_Store -x __pycache__ -x gpui-kit.d.ts -x jsconfig.json)
same() { diff -rq "${EXCLUDE[@]}" "$1" "$2" >/dev/null 2>&1; }

# Claude Code's settings change unless --no-claude, and only where it's installed.
claude_here() { [ "$CLAUDE" = 1 ] && { [ -d "$HOME/.claude" ] || command -v claude >/dev/null; }; }
# What statusLine is set to: the script, its path quoted for a shell.
SL_JSON="$(python3 -c 'import json, shlex, sys; print(json.dumps({"type": "command", "command": "bash " + shlex.quote(sys.argv[1])}))' "$SL")"

# json_set <file> <key> <JSON object> [<backup>]: merges the object into that
# top-level key of a JSON settings file; every other key stays as it is. It writes
# only on a change: the old file copied to <backup> first, then a temp file with
# the old one's mode renamed over it (over a symlink's target, so the link stays).
# Without <backup> it changes nothing and prints what it would do. A file it
# can't read as a JSON object is left alone (exit 2).
json_set() {
  python3 - "$@" <<'PY'
import json, os, shutil, sys, tempfile
path, key, value = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
backup = sys.argv[4] if len(sys.argv) > 4 else None
real = os.path.realpath(path)
try:
    with open(real, encoding="utf-8") as f:
        text = f.read()
    data, exists = (json.loads(text) if text.strip() else {}), True
except FileNotFoundError:
    data, exists = {}, False
except (OSError, ValueError) as e:
    data, exists = e, True
if not isinstance(data, dict):
    print(f"{path}: {data if isinstance(data, Exception) else 'not a JSON object'}", file=sys.stderr)
    sys.exit(2)
old = data.get(key)
new = {**(old if isinstance(old, dict) else {}), **value}
if backup is None:
    print("相同，不變" if new == old else "新增" if old is None else "取代：" + json.dumps(old, ensure_ascii=False))
    sys.exit(0)
if new == old:
    sys.exit(0)
if exists:
    os.makedirs(os.path.dirname(backup), exist_ok=True)
    shutil.copy2(real, backup)
    mode = os.stat(real).st_mode & 0o7777
else:
    umask = os.umask(0)
    os.umask(umask)
    mode = 0o666 & ~umask
data[key] = new
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(real), prefix="." + os.path.basename(real) + ".")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.chmod(tmp, mode)
    os.replace(tmp, real)
except BaseException:
    os.unlink(tmp)
    raise
PY
}

# --plan: what each piece would do here, nothing changed.
if [ "$PLAN" = 1 ]; then
  state() { if [ ! -e "$2" ]; then echo "新增"; elif same "$1" "$2"; then echo "相同，不變"; else echo "取代（舊的先備份）"; fi; }
  echo "會安裝到 ${APP}："
  for m in "${MODS[@]}"; do
    s="$(state "$REPO/mods/$m" "$APP/mods/$m")"
    if [ "$s" = "取代（舊的先備份）" ]; then
      s="${s}：$( { diff -rq "${EXCLUDE[@]}" "$REPO/mods/$m" "$APP/mods/$m" 2>/dev/null || true; } | wc -l | tr -d ' ') 個檔案不同"
    fi
    echo "  mod ${m}：${s}"
  done
  echo "  layout ${LAYOUT}：$(state "$REPO/layouts/${LAYOUT}.json" "$APP/layouts/${LAYOUT}.json")"
  for s in done blocked; do echo "  sound $s.mp3：$(state "$REPO/sounds/$s.mp3" "$APP/sounds/$s.mp3")"; done
  echo "  settings.json 的 sounds（只改這一項）：$(json_set "$APP/settings.json" sounds "$SOUNDS" || echo "讀不懂這個檔，不會改")"
  if claude_here; then
    echo "  ~/.claude/statusline-command.sh：$(state "$REPO/claude/statusline-command.sh" "$SL")"
    echo "  ~/.claude/settings.json 的 statusLine（只改這一項）：$(json_set "$HOME/.claude/settings.json" statusLine "$SL_JSON" || echo "讀不懂這個檔，不會改")"
  fi
  others=""
  for d in "$APP"/mods/my-*/; do
    d="${d%/}"
    if [ -d "$d" ] && [ ! -d "$REPO/mods/${d##*/}" ]; then others="$others ${d##*/}"; fi
  done
  if [ -n "$others" ]; then echo "  不動：這台自己的 mod${others}"; fi
  echo "不會動：keys.json、主題、其他 layout、secrets/（key 和 token）。"
  exit 0
fi

BACKUP="$HOME/.config/herdr-app-backups/$(date +%Y%m%d-%H%M%S)"
backup() { # backup <path> <name in the backup>: what's there (a symlink's target, not the link)
  [ -e "$1" ] || return 0
  mkdir -p "$BACKUP/$(dirname "$2")"
  cp -RH "$1" "$BACKUP/$2"
}
put() { # put <file in the repo> <where> <name in the backup>: copied when it differs
  if [ -e "$2" ] && same "$1" "$2"; then return 0; fi
  backup "$2" "$3"
  cp "$1" "$2"
}

# Mods: each is copied beside mods/ first, then moved in whole. Herdr loads a
# folder the moment it appears, and one whose mod.json isn't there yet gets
# docked into the layout on screen.
mkdir -p "$APP/mods" "$APP/layouts" "$APP/sounds"
STAGE="$(mktemp -d "$APP/.herdr-layout-install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
changed=""
for m in "${MODS[@]}"; do
  dst="$APP/mods/$m"
  if [ -e "$dst" ] && same "$REPO/mods/$m" "$dst"; then continue; fi
  backup "$dst" "mods/$m"
  cp -R "$REPO/mods/$m" "$STAGE/$m"
  rm -rf "${dst:?}"
  mv "$STAGE/$m" "$dst"
  changed="$changed $m"
done
if [ -n "$changed" ]; then say "mods：${changed# }"; else say "mods：都已是這個版本，沒動"; fi

put "$REPO/layouts/${LAYOUT}.json" "$APP/layouts/${LAYOUT}.json" "layouts/${LAYOUT}.json"
say "layout：$LAYOUT"

for s in done blocked; do put "$REPO/sounds/$s.mp3" "$APP/sounds/$s.mp3" "sounds/$s.mp3"; done
if json_set "$APP/settings.json" sounds "$SOUNDS" "$BACKUP/settings.json"; then
  say "提示音：sounds/done.mp3、sounds/blocked.mp3"
else
  note "settings.json 沒改（原因見上一行）：提示音要自己在它的 sounds 指定 sounds/done.mp3、sounds/blocked.mp3。"
fi

# Claude Code's status line: model@effort and context left at the right edge
# (the branch and worktree are on Herdr's bottom bar). Only statusLine changes.
if claude_here; then
  mkdir -p "$HOME/.claude"
  put "$REPO/claude/statusline-command.sh" "$SL" "claude/statusline-command.sh"
  chmod +x "$SL"
  if json_set "$HOME/.claude/settings.json" statusLine "$SL_JSON" "$BACKUP/claude/settings.json"; then
    say "Claude Code：status line（~/.claude/statusline-command.sh）"
  else
    note "~/.claude/settings.json 沒改（原因見上一行）：要用這個 status line，把 statusLine 指向 ${SL}。"
  fi
fi

# Switch to the layout when Herdr is running.
HA="$(command -v herdr-app || echo "$HOME/.local/bin/herdr-app")"
if [ -x "$HA" ] && "$HA" do layout.switch --name "$LAYOUT" >/dev/null 2>&1; then
  say "已切換到 $LAYOUT"
else
  note "沒能切換 layout（Herdr 沒在執行？）：開啟後用 ⌘⇧L（layout.switch）切到 ${LAYOUT}。"
fi

if [ -d "$BACKUP" ]; then echo "被取代的檔案備份在 $BACKUP"; fi

# Logins and keys: the Accounts & keys dialog shows what's missing, one button each.
if [ -x "$HA" ] && "$HA" do mod.open '{"name":"my-setup"}' >/dev/null 2>&1; then
  say "已打開 Accounts & keys：照上面缺的項目登入或貼上 key（左下角的鑰匙也能再打開）"
else
  note "登入和 API key：開啟 Herdr 後點左下角的鑰匙（Accounts & keys）。"
fi

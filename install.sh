#!/bin/bash
# Installs this layout into Herdr on this machine. Safe to run again: whatever
# it replaces is copied to ~/.config/herdr-app-backups/<time>/ first.
#
#   ./install.sh               layout, mods, sounds and Claude Code's status line
#   ./install.sh --no-claude   leave Claude Code's settings alone
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_HOME:-$HOME/.config/herdr-app}"
MODS="my-agents my-chrome my-confirm my-files my-gitlab my-menu my-pane my-rename my-spaces my-status my-tabs"
LAYOUT="my-main"
CLAUDE=1

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --no-claude|--no-agents) CLAUDE=0 ;;
    *) echo "不認得的參數：${arg}" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
note() { printf '\033[33m!\033[0m %s\n' "$*"; }

[ -d "$APP" ] || { echo "找不到 ${APP}：請先安裝 Herdr 並開啟一次。" >&2; exit 1; }
command -v python3 >/dev/null || { echo "需要 python3。" >&2; exit 1; }
command -v jq >/dev/null || note "沒有 jq：Claude Code 的 status line 需要它（brew install jq）。"
command -v terminal-notifier >/dev/null || note "沒有 terminal-notifier：點通知跳回 agent 需要它（brew install terminal-notifier）。"
command -v glab >/dev/null || note "沒有 glab：GitLab 面板需要它（brew install glab && glab auth login）。"

BACKUP="$HOME/.config/herdr-app-backups/$(date +%Y%m%d-%H%M%S)"
backup() { # backup <absolute path> <name in the backup>
  [ -e "$1" ] || return 0
  mkdir -p "$BACKUP/$(dirname "$2")"
  cp -R "$1" "$BACKUP/$2"
}

# Mods, layout, sounds
for m in $MODS; do
  backup "$APP/mods/$m" "mods/$m"
  rm -rf "$APP/mods/$m"
  cp -R "$REPO/mods/$m" "$APP/mods/$m"
done
say "mods：$MODS"

mkdir -p "$APP/layouts" "$APP/sounds"
backup "$APP/layouts/${LAYOUT}.json" "layouts/${LAYOUT}.json"
cp "$REPO/layouts/${LAYOUT}.json" "$APP/layouts/"
say "layout：$LAYOUT"

for s in done blocked; do backup "$APP/sounds/$s.mp3" "sounds/$s.mp3"; done
cp "$REPO/sounds/done.mp3" "$REPO/sounds/blocked.mp3" "$APP/sounds/"
backup "$APP/settings.json" "settings.json"
python3 - "$APP/settings.json" <<'PY'
import json, os, sys
path = sys.argv[1]
s = json.load(open(path)) if os.path.exists(path) else {}
s["sounds"] = {**s.get("sounds", {}), "enabled": True, "done": "sounds/done.mp3", "blocked": "sounds/blocked.mp3"}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
PY
say "提示音：sounds/done.mp3、sounds/blocked.mp3"

# Claude Code's status line: model@effort and context left at the right edge
# (the branch and worktree are on Herdr's bottom bar). Only statusLine changes.
if [ "$CLAUDE" = 1 ] && { [ -d "$HOME/.claude" ] || command -v claude >/dev/null; }; then
  mkdir -p "$HOME/.claude"
  SL="$HOME/.claude/statusline-command.sh"
  if ! cmp -s "$REPO/claude/statusline-command.sh" "$SL"; then
    backup "$SL" "claude/statusline-command.sh"
    cp "$REPO/claude/statusline-command.sh" "$SL"
    chmod +x "$SL"
  fi
  backup "$HOME/.claude/settings.json" "claude/settings.json"
  python3 - "$HOME/.claude/settings.json" "$SL" <<'PY'
import json, os, shlex, sys
path, sl = sys.argv[1], sys.argv[2]
s = json.load(open(path)) if os.path.exists(path) else {}
want = {"type": "command", "command": "bash " + shlex.quote(sl)}
if (s.get("statusLine") or {}).get("command") != want["command"]:
    s["statusLine"] = {**(s.get("statusLine") or {}), **want}
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
PY
  say "Claude Code：status line（~/.claude/statusline-command.sh）"
fi

# Switch to the layout when Herdr is running.
HA="$(command -v herdr-app || echo "$HOME/.local/bin/herdr-app")"
if [ -x "$HA" ] && "$HA" do layout.switch --name "$LAYOUT" >/dev/null 2>&1; then
  say "已切換到 $LAYOUT"
else
  note "Herdr 沒在執行：開啟後用 ⌘⇧L（layout.switch）切到 ${LAYOUT}。"
fi

[ -d "$BACKUP" ] && echo "被取代的檔案備份在 $BACKUP"

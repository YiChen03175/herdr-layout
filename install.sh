#!/bin/bash
# Installs this layout into Herdr on this machine. Safe to run again: whatever
# it replaces is copied to ~/.config/herdr-app-backups/<time>/ first.
#
#   ./install.sh               layout, mods, sounds, and the Claude Code / Grok status lines
#   ./install.sh --no-agents   leave Claude Code's and Grok's settings alone
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_HOME:-$HOME/.config/herdr-app}"
MODS="my-agents my-chrome my-pane my-spaces my-status my-tabs"
LAYOUT="my-main"
AGENTS=1

for arg in "$@"; do
  case "$arg" in
    --no-agents) AGENTS=0 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不認得的參數：${arg}（可用 --no-agents）" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
note() { printf '\033[33m!\033[0m %s\n' "$*"; }

[ -d "$APP" ] || { echo "找不到 ${APP}：請先安裝 Herdr 並開啟一次。" >&2; exit 1; }
command -v python3 >/dev/null || { echo "需要 python3。" >&2; exit 1; }
command -v jq >/dev/null || note "沒有 jq：狀態列交接需要它（brew install jq）。"

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
chmod +x "$APP/mods/my-status/statusline.sh"
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

# Claude Code and Grok: hand model, effort and context to the bottom bar inside Herdr.
SL="$APP/mods/my-status/statusline.sh"
if [ "$AGENTS" = 1 ]; then
  if [ -d "$HOME/.claude" ] || command -v claude >/dev/null; then
    mkdir -p "$HOME/.claude"
    backup "$HOME/.claude/settings.json" "claude/settings.json"
    python3 - "$HOME/.claude/settings.json" "$SL" <<'PY'
import json, os, shlex, sys
path, sl = sys.argv[1], sys.argv[2]
s = json.load(open(path)) if os.path.exists(path) else {}
cur = s.get("statusLine") or {}
old = cur.get("command") if cur.get("type") == "command" else None
if old and "my-status/statusline.sh" in old:
    print("  Claude Code 的 statusLine 已經設定過")
    sys.exit(0)
# An existing status line keeps showing outside Herdr.
cmd = shlex.quote(sl) + (" sh -c " + shlex.quote(old) if old else "")
s["statusLine"] = {**cur, "type": "command", "command": cmd}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
print("  原本的 status line：" + (old or "（無）") + " → 在 Herdr 外照常顯示")
PY
    say "Claude Code：~/.claude/settings.json 的 statusLine"
  fi

  if [ -d "$HOME/.grok" ] || command -v grok >/dev/null; then
    CFG="$HOME/.grok/config.toml"
    mkdir -p "$HOME/.grok"
    if [ -f "$CFG" ] && grep -q 'my-status/statusline.sh' "$CFG"; then
      say "Grok：已經設定過"
    elif [ -f "$CFG" ] && grep -q '^\[ui\.status_line\]' "$CFG"; then
      note "Grok：$CFG 已經有自己的 [ui.status_line]，沒有動它。要在 Herdr 底部顯示，把它的 command 改成："
      echo "      \"$SL sh -c '<原本的指令>'\""
    else
      backup "$CFG" "grok/config.toml"
      printf '\n[ui.status_line]\ntype = "command"\ncommand = "%s"\n' "$SL" >> "$CFG"
      say "Grok：~/.grok/config.toml 加上 [ui.status_line]"
    fi
  fi
fi

# Switch to the layout when Herdr is running.
HA="$(command -v herdr-app || echo "$HOME/.local/bin/herdr-app")"
if [ -x "$HA" ] && "$HA" do layout.switch --name "$LAYOUT" >/dev/null 2>&1; then
  say "已切換到 $LAYOUT"
else
  note "Herdr 沒在執行：開啟後用 ⌘⇧L（layout.switch）切到 ${LAYOUT}。"
fi

[ -d "$BACKUP" ] && echo "被取代的檔案備份在 $BACKUP"
echo "已經開著的 Claude Code / Grok 要重開，底部的模型與 ctx 才會出現。"

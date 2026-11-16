#!/bin/bash
# Copies this machine's layout, mods, sounds and Claude Code status line back
# into the repo, after changing them. Review with `git diff`, then commit.
set -euo pipefail

REPO="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# Herdr's own variable for another app folder (`herdr-app --help`).
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

# Every my-* mod folder on this machine (a new one comes along by itself).
found=0
for d in "$APP"/mods/my-*/; do
  [ -d "$d" ] || continue
  m="${d%/}"; m="${m##*/}"
  mkdir -p "$REPO/mods/$m"
  rsync -a --delete --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude .DS_Store --exclude __pycache__ \
    "$APP/mods/$m/" "$REPO/mods/$m/"
  found=1
done
[ "$found" = 1 ] || { echo "${APP}/mods 裡沒有 my-* mod。" >&2; exit 1; }
# The look picked in Customize (frosted glass) is this machine's: left out of the repo.
python3 "$APP/mods/my-setup/style.py" undo "$APP/layouts/my-main.json" "$APP/data/my-setup/style.json" "$REPO/layouts/my-main.json"
cp "$APP/sounds/done.mp3" "$APP/sounds/blocked.mp3" "$REPO/sounds/"
mkdir -p "$REPO/claude"
cp "$HOME/.claude/statusline-command.sh" "$REPO/claude/"
git -C "$REPO" status --short

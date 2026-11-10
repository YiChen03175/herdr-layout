#!/bin/bash
# Copies this machine's layout, mods and sounds back into the repo, after
# changing them in Herdr. Review with `git diff`, then commit.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_HOME:-$HOME/.config/herdr-app}"
MODS="my-agents my-chrome my-gitlab my-pane my-spaces my-status my-tabs"

for m in $MODS; do
  mkdir -p "$REPO/mods/$m"
  rsync -a --delete --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude .DS_Store \
    "$APP/mods/$m/" "$REPO/mods/$m/"
done
cp "$APP/layouts/my-main.json" "$REPO/layouts/"
cp "$APP/sounds/done.mp3" "$APP/sounds/blocked.mp3" "$REPO/sounds/"
git -C "$REPO" status --short

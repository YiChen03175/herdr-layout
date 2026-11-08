#!/bin/bash
# Status line for Claude Code and Grok (both send the same JSON on stdin).
#
# Inside Herdr (its terminals set HC_TERMINAL_ID) it prints nothing, which
# hides the agent's own status line, and hands model, effort and context left
# to the my-status bar in a file per terminal.
# Elsewhere it runs the command given as arguments (your old status line),
# or prints "folder │ model@effort │ ctx N%".
#
#   statusline.sh                          # Herdr hand-off, else the default line
#   statusline.sh sh -c 'my-statusline'    # Herdr hand-off, else your own line
input=$(cat)

if [ -n "$HC_TERMINAL_ID" ]; then
    dir="$HOME/.config/herdr-app/data/my-status/agents"
    mkdir -p "$dir"
    tmp="$dir/.$HC_TERMINAL_ID.$$"
    printf '%s' "$input" | jq -c --argjson at "$(date +%s)" \
        '{model: .model.display_name, effort: .effort.level, remaining: .context_window.remaining_percentage, at: $at}' > "$tmp" \
        && mv -f "$tmp" "$dir/$HC_TERMINAL_ID.json"
    rm -f "$tmp"
    exit 0
fi

if [ $# -gt 0 ]; then
    printf '%s' "$input" | "$@"
    exit
fi

dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""')
model=$(printf '%s' "$input" | jq -r '.model.display_name // "?"')
effort=$(printf '%s' "$input" | jq -r '.effort.level // empty')
left=$(printf '%s' "$input" | jq -r '.context_window.remaining_percentage // empty')
line="${dir##*/} │ ${model}${effort:+@$effort}"
[ -n "$left" ] && line="$line │ ctx ${left}%"
printf '%s\n' "$line"

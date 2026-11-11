#!/bin/bash
# Status line for Claude Code and Grok (both send the same JSON on stdin).
# Runs the command given as arguments (your old status line), or prints
# "folder │ model@effort │ ctx N%". Herdr's bottom bar shows plan usage instead.
#
#   statusline.sh                          # the default line
#   statusline.sh sh -c 'my-statusline'    # your own line
input=$(cat)

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

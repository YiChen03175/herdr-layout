#!/bin/bash

# Claude Code status line (installed to ~/.claude/statusline-command.sh by
# herdr-layout's install.sh). Reads Claude Code's JSON on stdin:
#
#   ~/dir  owner/repo                                  Opus 5.5@high ctx:63%
#
# The model and context sit at the right edge and always show; when the row is
# too narrow, the left side (folder, repo) is cut short with "…". The git branch
# and worktree are on Herdr's bottom bar (mods/my-status), not here.

command -v jq >/dev/null || { echo "status line: needs jq (brew install jq)"; exit 0; }

# Everything from the JSON on stdin in one jq call, one field per line. Each
# field is read on its own (`try`): one that's missing or of an unexpected type
# comes out empty instead of ending the rest. The context left is rounded here,
# so the shell never parses a decimal (printf's %f follows the locale).
{
    IFS= read -r model_name
    IFS= read -r current_dir
    IFS= read -r effort
    IFS= read -r repo
    IFS= read -r remaining
} < <(jq -r '
    ((try .model.display_name catch null) // "Claude" | tostring),
    ((try (.workspace.current_dir // .cwd) catch null) // "" | tostring),
    ((try .effort.level catch null) // "" | tostring),
    ([try (.workspace.repo | .owner, .name)] | map(strings | select(. != "")) | join("/")),
    ((try (.context_window.remaining_percentage | tonumber | . + 0.5 | floor | tostring) catch null) // "")
' 2>/dev/null)

model_label="${model_name:-Claude}${effort:+@$effort}"

# Shorten the home directory to a literal ~ (a whole component only: /Users/me2
# stays as it is).
# shellcheck disable=SC2088
case "$current_dir" in
    "$HOME") short_dir="~" ;;
    "$HOME"/*) short_dir="~${current_dir#"$HOME"}" ;;
    *) short_dir="$current_dir" ;;
esac

# Collapse long paths: keep first two and last two components -> a/b/…/y/z
IFS='/' read -ra _parts <<< "$short_dir"
_n=${#_parts[@]}
if (( _n > 5 )); then
    short_dir="${_parts[0]}/${_parts[1]}/…/${_parts[_n-2]}/${_parts[_n-1]}"
fi

# Color codes with real ESC chars
C_RESET=$'\033[0m'
C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[0;33m'
C_RED=$'\033[0;31m'
C_MAGENTA=$'\033[0;35m'
C_CYAN=$'\033[0;36m'
C_BLUE=$'\033[0;34m'

# Context window remaining percentage, colored by how much is left
ctx_plain="" ctx_color=""
if [[ -n "$remaining" ]]; then
    if (( remaining <= 10 )); then ctx_color="$C_RED"
    elif (( remaining <= 25 )); then ctx_color="$C_YELLOW"
    else ctx_color="$C_GREEN"
    fi
    ctx_plain="ctx:${remaining}%"
fi

# Right side: always whole.
right_plain="$model_label${ctx_plain:+ $ctx_plain}"
right="${C_CYAN}${model_label}${C_RESET}${ctx_plain:+ ${ctx_color}${ctx_plain}${C_RESET}}"

# Room for the row: the terminal's width less Claude Code's indent on the left
# and a little air on the right.
width=$(( ${COLUMNS:-80} - 4 ))
room=$(( width - ${#right_plain} - 2 ))   # at least two spaces before the right side

# Left side, segment by segment; the one that doesn't fit is cut with "…" and
# the rest are left out.
left="" used=0
add() { # add <text> <color>
    local text="$1" color="$2" sep=""
    (( used > 0 )) && sep="  "
    local need=$(( ${#sep} + ${#text} ))
    if (( used + need <= room )); then
        left+="$sep$color$text$C_RESET"; used=$(( used + need ))
        return 0
    fi
    local fit=$(( room - used - ${#sep} - 1 ))
    (( fit > 0 )) && { left+="$sep$color${text:0:fit}…$C_RESET"; used=$(( used + ${#sep} + fit + 1 )); }
    return 1
}
add "$short_dir" "$C_BLUE" \
    && { [[ -z "$repo" ]] || add "$repo" "$C_MAGENTA"; }

gap=$(( width - used - ${#right_plain} ))
(( gap < 1 )) && gap=1
printf '%s%*s%s\n' "$left" "$gap" "" "$right"

# For agents: installing or updating this layout on someone's machine

This repo is a Herdr desktop app setup (the `my-main` layout, `mods/my-*`, two
sounds, a Claude Code status line). `install.sh` copies it into
`~/.config/herdr-app/`. You are usually running inside Herdr for the person whose
machine this is; they may already have their own Herdr changes. Your job is to
get this setup working **without losing theirs**, and to leave logins and keys to
them.

## Install or update

1. **Check Herdr is there.** `~/.config/herdr-app/` (or `$HERDR_APP_HOME`) must
   exist (Herdr opened once) and `herdr-app --version` must run. If not, ask them
   to install Herdr first.
2. **Look before changing anything:** `./install.sh --plan`. For each mod, the
   layout, the sounds and the status line script it prints `新增` (new),
   `相同，不變` (same: left alone) or `取代（舊的先備份）` (replaced, backed up
   first); for `sounds` in Herdr's `settings.json` and `statusLine` in
   `~/.claude/settings.json`, `取代：<current value>` when it would change them.
   It also lists their own `my-*` mods, which stay as they are. Show the person
   the summary.
3. **For every mod that would be replaced, find out whether it holds their own
   work**: `diff -r -x gpui-kit.d.ts -x jsconfig.json -x .DS_Store -x __pycache__
   ~/.config/herdr-app/mods/<mod> mods/<mod>` (what `--plan` compares).
   - Only this repo's older version (they installed it before and changed
     nothing): replacing is fine.
   - Their own changes: tell them what they changed, in a sentence or two, and
     ask whether to keep theirs, take the repo's, or carry their change over.
     `install.sh` has no per-mod switch, so either way install first; the
     backup it prints holds their copy
     (`~/.config/herdr-app-backups/<time>/mods/<mod>`). To keep theirs, put
     that folder back in place of the new one; to carry their change over,
     re-apply it to the new copy by hand. Then run the checks in step 6.
     The mods lean on each other (`my-rename` and `my-setup` import Python
     from `my-agents`; `my-chrome`'s footer runs `my-setup/status.py`), so an
     older copy of one can break another: say so when they keep theirs.
4. **Claude Code's status line.** `install.sh` replaces
   `~/.claude/statusline-command.sh` and points `statusLine` in
   `~/.claude/settings.json` at it (nothing else there changes). If `--plan`
   shows their `statusLine` pointing somewhere else, ask before replacing it; to
   leave it alone, run `./install.sh --no-claude`.
5. **Install:** `./install.sh`. Everything it replaces is copied to the backup
   folder it prints first; what's already the same isn't touched. It never
   touches `keys.json`, themes, other layouts, their other mods or `secrets/`.
   A settings file it can't parse as JSON is left as it is, with a `!` line
   saying what to set by hand.
6. **Verify:** for each mod, `herdr-app check ~/.config/herdr-app/mods/<mod>`
   must print `check passed`; `herdr-app status` must show `"errors": []`; take
   `herdr-app shot` and look at it (the window must be in front to redraw).
7. **Logins and keys:** `install.sh` opens the **Accounts & keys** dialog
   (`my-setup`; also the key icon at the sidebar's bottom left). Tell the person
   which items are missing and that they set them there. Read the state with
   `python3 ~/.config/herdr-app/mods/my-setup/status.py` (it never prints a key).

Updating later is the same: `git pull`, then steps 2–6.

## Keys and logins: never through you

- **Never ask the person to paste a key or token into the chat, and never write
  one to a file yourself.** The dialog saves them to
  `~/.config/herdr-app/secrets/` (folder 0700, files 0600), outside this repo.
- What needs what (the dialog covers each):

  | Item | Needed for | Without it |
  |---|---|---|
  | GitLab: "用瀏覽器登入" runs glab's web login (`my-setup/gitlab_login.py` answers its menu in a hidden `hc` terminal); the person clicks Authorize in the browser. Without glab the button is "安裝 glab" (`brew install glab` in a new tab) | the GitLab panel | the panel shows a login button |
  | OpenRouter key (`secrets/openrouter.key`). An older `openrouter-rename.key` or `openrouter-decider.key` still wins for its own feature; the dialog's OpenRouter row then names the file each one uses | rename suggestions, the agent-state check | rename works, no suggestion; the check is skipped |
  | Slack user token (`secrets/slack.token`, `xoxp-`, `search:read`), optional | Slack mentions in GitLab's To review | GitLab's own review requests only |
  | `terminal-notifier` (brew), plus allowing it in System Settings → Notifications | clicking a notification jumps to the agent | notifications still show; a click does nothing useful |
  | Claude Code logged in with a claude.ai account | the plan usage bars at the bottom right | no bars |

## Changing the mods (for whoever maintains this repo)

- Herdr's own rules are in `~/.config/herdr-app/AGENTS.md`: clone a shipped mod
  before editing it (`herdr-app do mod.clone '{"name":"menu","as":"my-menu"}'`),
  don't edit Herdr's `AGENTS.md` or the `.d.ts` files, and run `herdr-app check`
  after every change.
- Write `mod.json` (with `"place": "none"` for dialogs and popups) **before**
  `main.js` when making a new mod: a mod whose `mod.json` is missing gets placed
  into the current layout the moment it appears.
- Edit the live copies in `~/.config/herdr-app/`, then `./export.sh` copies
  them (every `my-*` mod, the layout, sounds, status line) back here for review
  and commit. `install.sh` installs every `mods/my-*` folder in this repo.
- The Python helpers in `mods/my-agents/common.py` (secret masking, the log
  writer, the OpenRouter key lookup) are shared by `decide.py`, `my-rename` and
  `my-setup`; `my-rename` also imports `my-agents/recap.py`. JS mods can't
  import from each other.

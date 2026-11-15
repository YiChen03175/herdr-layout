# For agents: installing or updating this layout on someone's machine

This repo is a Herdr desktop app setup (the `my-main` layout, `mods/my-*`, two
sounds, a Claude Code status line). `install.sh` copies it into
`~/.config/herdr-app/`. You are usually running inside Herdr for the person whose
machine this is; they may already have their own Herdr changes. Your job is to
get this setup working **without losing theirs**, and to leave logins and keys to
them.

## Install or update

1. **Check Herdr is there.** `~/.config/herdr-app/` must exist (Herdr opened once)
   and `herdr-app --version` must run. If not, ask them to install Herdr first.
2. **Look before changing anything:** `./install.sh --plan`. It prints, per mod,
   `新增` (new), `相同，不變` (same) or `取代（舊的先備份）` (replaced, backed up), and
   lists their own `my-*` mods that are left alone. Show the person the summary.
3. **For every mod that would be replaced, find out whether it holds their own
   work** — run `diff -r ~/.config/herdr-app/mods/<mod> mods/<mod>` (ignore
   `gpui-kit.d.ts`, `jsconfig.json`, `__pycache__`).
   - Only this repo's older version (they installed it before and changed
     nothing): replacing is fine.
   - Their own changes: tell them what they changed, in a sentence or two, and
     ask whether to keep theirs (skip installing that mod), take the repo's, or
     carry their change over. To carry it over: install, then re-apply their
     change to the new copy by hand from the backup that `install.sh` prints
     (`~/.config/herdr-app-backups/<time>/mods/<mod>`), then run the checks in
     step 6.
4. **Claude Code's status line.** `install.sh` replaces
   `~/.claude/statusline-command.sh` and points `statusLine` in
   `~/.claude/settings.json` at it (nothing else there changes). If their
   `statusLine` already points somewhere else, ask before replacing it; to leave
   it alone, run `./install.sh --no-claude`.
5. **Install:** `./install.sh`. Everything it replaces is copied to the backup
   folder it prints first. It never touches `keys.json`, themes, other layouts,
   their other mods or `secrets/`.
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
  | GitLab: "用瀏覽器登入" runs glab's web login (`my-setup/gitlab_login.py` answers its menu in a hidden `hc` terminal); the person clicks Authorize in the browser | the GitLab panel | the panel shows a login button |
  | OpenRouter key (`secrets/openrouter.key`) | rename suggestions, the agent-state check | rename works, no suggestion; the check is skipped |
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
  `my-setup`; JS mods can't import from each other.

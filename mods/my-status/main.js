import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, focused, window, theme, exec } from "herdr";

// The bottom bar: which machine; where the focused terminal is in git (its
// branch, * with uncommitted changes, and the worktree when it's a linked one);
// how many agents (how many need you). The agents' own details (model, context)
// stay in their status lines (~/.claude/statusline-command.sh).

// Uncommitted changes come and go without Herdr hearing of it: looked at again
// this often, only while the window is in front.
const DIRTY_EVERY = 5000;
// A folder's last part.
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.git = null;   // { cwd, worktree: name | null, dirty } for the focused local folder
    this.asking = null;
    cx.timer.every(500, (cx) => { if (this.cwd() !== this.git?.cwd) this.look(cx); });
    cx.timer.every(DIRTY_EVERY, (cx) => { if (window()?.active) this.look(cx); });
  }

  // The focused pane's folder, when it's on this computer (git can't be asked
  // about another machine's folders from here).
  cwd() {
    const f = focused();
    if (!f) return null;
    const p = panes().find((p) => p.pane === f.pane);
    const space = spaces().find((s) => s.id === f.space);
    return space?.machine ? null : p?.cwd ?? f.cwd ?? null;
  }

  // One git round for the folder: its checkout's top, the repo's own .git
  // (they differ in a linked worktree), and whether tracked files changed.
  look(cx) {
    const cwd = this.cwd();
    if (!cwd) { if (this.git) { this.git = null; cx.notify(); } return; }
    if (this.asking === cwd) return;
    this.asking = cwd;
    cx.spawn(async (cx) => {
      let next = { cwd, worktree: null, dirty: false };
      try {
        const r = await exec("sh", ["-c",
          'cd "$1" && git rev-parse --path-format=absolute --show-toplevel --git-common-dir && { git --no-optional-locks diff-index --quiet HEAD -- && echo clean || echo dirty; }',
          "sh", cwd], { timeout: 5000 });
        const [top, common, state] = r.stdout.trim().split("\n");
        if (r.code === 0 && top && common) {
          next = { cwd, worktree: common === `${top}/.git` ? null : base(top), dirty: state === "dirty" };
        }
      } catch {}
      this.asking = null;
      if (JSON.stringify(next) !== JSON.stringify(this.git)) { this.git = next; cx.notify(); }
    });
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const f = focused();
    const pane = f && panes().find((p) => p.pane === f.pane);
    // The focused terminal's branch; before one is focused, the space's.
    const branch = pane?.branch ?? space?.branch ?? null;
    const g = this.git && this.git.cwd === (pane?.cwd ?? f?.cwd) ? this.git : null;
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().min_w(0).child(svg(`mods/workspace-chrome/${icon}.svg`).size(13).flex_none()).child(div().truncate().child(text));
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(branch), el => el.child(label("branch", `${branch}${g?.dirty ? "*" : ""}`)))
      .when(Boolean(g?.worktree), el => el.child(label("git-compare", `worktree ${g.worktree}`)))
      .child(h_flex().flex_none().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))));
  }
}

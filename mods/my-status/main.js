import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, focused, window, theme, readTextFile, appHome, exec, shared } from "herdr";

// The bottom bar: which machine; where the focused terminal is in git (its
// branch, * with uncommitted changes, and the worktree when it's a linked one);
// how many agents (how many need you); on the right, the Claude plan's usage.
// The agents' own details (model, context) stay in their status lines
// (~/.claude/statusline-command.sh).

// Uncommitted changes come and go without Herdr hearing of it: looked at again
// this often, only while the window is in front.
const DIRTY_EVERY = 5000;
// A folder's last part.
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// The Claude plan's usage, from usage.py (a clean, model-free Claude Code that
// answers what /usage shows). Its last answer is kept in usage.json, so the
// bar has numbers as soon as the app starts.
const USAGE_FILE = () => `${appHome()}/data/my-status/usage.json`;
const USAGE_EVERY = 5 * 60 * 1000;
const METERS = [["fable", "Fable", "Fable 本週用量"], ["week", "週", "本週用量（全部模型）"], ["five_hour", "5h", "5 小時用量"]];
const BAR_W = 64;
const BAR_H = 14;
const TRACK = 0.5;   // the empty part
const SOFT = 0.6;    // the week's fill
const BRIGHT = 1;    // Fable, alone and as its part of the week
const HOT = 90; // percent from which a bar turns the "needs you" colour

const pad = (n) => String(n).padStart(2, "0");
const when = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.git = null;   // { cwd, worktree: name | null, dirty } for the focused local folder
    this.asking = null;
    cx.timer.every(500, (cx) => { if (this.cwd() !== this.git?.cwd) this.look(cx); });
    cx.timer.every(DIRTY_EVERY, (cx) => { if (window()?.active) this.look(cx); });

    this.usage = null; // {five_hour, week, fable, at}; each window {pct, resets} or null
    cx.spawn(async (cx) => { this.take(await readTextFile(USAGE_FILE()), cx); });
    this.fetch(cx);
    cx.timer.every(USAGE_EVERY, (cx) => this.fetch(cx));
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

  take(text, cx) {
    try {
      const d = text ? JSON.parse(text) : null;
      if (d && JSON.stringify(d) !== JSON.stringify(this.usage)) { this.usage = d; cx.notify(); }
    } catch {}
  }

  // A failed run keeps the last numbers.
  fetch(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/my-status/usage.py`], { timeout: 60000 });
        if (r.code === 0) this.take(r.stdout, cx);
      } catch {}
    });
  }

  // A pill with the percent inside; a window without data isn't shown. As on
  // claude.ai, the week's fill starts with Fable's part of it, in Fable's colour.
  meter(t, [key, label, name]) {
    const w = this.usage?.[key];
    const width = (p) => Math.max(BAR_H, BAR_W * Math.max(0, Math.min(100, p)) / 100);
    const hot = w.pct >= HOT;
    const part = key === "week" && w.fable > 0 ? w.fable : null;
    const tip = `${name} ${Math.round(w.pct)}%`
      + (part != null ? `（Fable 佔 ${Math.round(part)}%）` : "")
      + (w.cap != null ? `，最多可用每週上限的 ${w.cap}%` : "")
      + (w.resets ? `，${when(w.resets)} 重置` : "");
    const fill = (p, color, alpha) => div().absolute().top(0).left(0).h_full().w(width(p)).rounded_full().bg(color).opacity(alpha);
    return h_flex().gap(6).items_center().flex_none().tooltip(tip)
      .child(div().child(label))
      .child(div().relative().w(BAR_W).h(BAR_H).rounded_full().overflow_hidden()
        .child(div().absolute().inset_0().rounded_full().bg(t.dim).opacity(TRACK))
        .when(w.pct > 0, el => el.child(fill(w.pct, hot ? t.blocked : t.accent, key === "fable" ? BRIGHT : SOFT)))
        .when(part != null, el => el.child(fill(part, t.accent, BRIGHT)))
        .child(h_flex().absolute().inset_0().items_center().justify_end().pr(6)
          .text_size(9.5).font_weight(600).text_color(t.foreground).child(`${Math.round(w.pct)}`)));
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
    // my-agents' decision model can say a stopped agent is really waiting on you.
    const over = shared("agents.effective") ?? {};
    const needs = list.filter(a => a.status === "blocked" || ((a.status === "done" || a.status === "idle") && over[a.address] === "blocked")).length;
    const label = (icon, text) => h_flex().gap(6).items_center().min_w(0).child(svg(`mods/workspace-chrome/${icon}.svg`).size(13).flex_none()).child(div().truncate().child(text));
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(branch), el => el.child(label("branch", `${branch}${g?.dirty ? "*" : ""}`)))
      .when(Boolean(g?.worktree), el => el.child(label("git-compare", `worktree ${g.worktree}`)))
      .child(h_flex().flex_none().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(Boolean(this.usage), el => el.child(h_flex().flex_none().gap(14).items_center()
        .children(METERS.filter(([key]) => this.usage[key]).map((m) => this.meter(t, m)))));
  }
}

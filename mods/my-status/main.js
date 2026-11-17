import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, focused, window, theme, readTextFile, appHome, exec, shared, layout } from "herdr";

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
// How often to see whether it's due (no process unless it is).
const USAGE_CHECK = 30000;
const METERS = [["fable", "Fable", "Fable 本週用量"], ["week", "週", "本週用量（全部模型）"], ["five_hour", "5h", "5 小時用量"]];
const BAR_W = 64;
const BAR_H = 14;
const TRACK = 0.5;   // the empty part
// Under frosted glass the empty part is a veil over the glass, light on a dark theme and
// dark on a light one: the dim grey above reads as a heavy block there.
const GLASS_TRACK = { dark: "#ffffff33", light: "#0000001f" }; // the glass hover colours
// and a hairline round it, so it still shows on a pale wallpaper.
const GLASS_EDGE = { dark: "#ffffff1f", light: "#0000001a" };
const darkUi = (t) => parseInt(t.foreground.slice(1, 3), 16) > 128;
const PART = 0.35;   // Fable's part of the week: the fill under a veil of the background this thick
const HOT = 90; // percent from which a bar turns the "needs you" colour
// The percent sits at the end of its fill, in the background colour, so it reads
// the same everywhere. A fill is never shorter than a circle, nor than its number.
const NUM_SIZE = 9.5;
const DIGIT_W = 5.6; // one digit at NUM_SIZE, semibold (layout px)
const NUM_PAD = 4;   // from the number to its fill's end
const NUM_GAP = 3;   // the least room between the week's two numbers
// The background colour without its alpha (frosted glass makes it see-through).
const solid = (c) => c.slice(0, 7);

const pad = (n) => String(n).padStart(2, "0");
const when = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.git = null;   // { cwd, worktree: name | null, dirty } for the focused local folder
    this.asking = null;
    // (?? null: a remote space's cwd is null, and an unset this.git mustn't count as a change.)
    cx.timer.every(500, (cx) => { if (this.cwd() !== (this.git?.cwd ?? null)) this.look(cx); });
    cx.timer.every(DIRTY_EVERY, (cx) => { if (window()?.active) this.look(cx); });

    this.usage = null; // {five_hour, week, fable, at}; each window {pct, resets} or null
    this.usageTried = 0;
    cx.spawn(async (cx) => { this.take(await readTextFile(USAGE_FILE()).catch(() => null), cx); this.fetch(cx); });
    cx.timer.every(USAGE_CHECK, (cx) => this.fetch(cx));
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
      // Focus may have moved on meanwhile: then a newer look is under way (or due), and
      // this answer is about a folder no longer shown.
      if (this.asking === cwd) this.asking = null;
      if (cwd !== this.cwd()) return;
      if (JSON.stringify(next) !== JSON.stringify(this.git)) { this.git = next; cx.notify(); }
    });
  }

  take(text, cx) {
    try {
      const d = text ? JSON.parse(text) : null;
      if (d && JSON.stringify(d) !== JSON.stringify(this.usage)) { this.usage = d; cx.notify(); }
    } catch {}
  }

  // Asks again once the last answer (or try) is USAGE_EVERY old, only while the
  // window is in front: each run starts a Claude Code. A failed run keeps the last numbers.
  fetch(cx) {
    const last = Math.max((this.usage?.at ?? 0) * 1000, this.usageTried);
    if (this.usageBusy || !window()?.active || Date.now() - last < USAGE_EVERY) return;
    this.usageBusy = true;
    this.usageTried = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/my-status/usage.py`], { timeout: 60000 });
        if (r.code === 0) this.take(r.stdout, cx);
      } catch {} finally {
        this.usageBusy = false;
      }
    });
  }

  // A pill whose fill carries its percent at its end; a window without data isn't
  // shown. As on claude.ai, the week's fill starts with Fable's part of it, a little
  // paler, with Fable's percent too once the two numbers can't touch.
  meter(t, [key, label, name]) {
    const w = this.usage?.[key];
    const text = (p) => String(Math.round(p));
    const textW = (p) => text(p).length * DIGIT_W;
    const reach = (p) => Math.min(BAR_W, Math.max(BAR_H, textW(p) + 2 * NUM_PAD, BAR_W * Math.max(0, Math.min(100, p)) / 100));
    const hot = w.pct >= HOT;
    const part = key === "week" && w.fable > 0 ? w.fable : null;
    const tip = `${name} ${Math.round(w.pct)}%`
      + (part != null ? `（Fable 佔 ${Math.round(part)}%）` : "")
      + (w.cap != null ? `，最多可用每週上限的 ${w.cap}%` : "")
      + (w.resets ? `，${when(w.resets)} 重置` : "");
    const fill = (p, color, alpha = 1) => div().absolute().top(0).left(0).h_full().w(reach(p)).rounded_full().bg(color).opacity(alpha);
    const number = (p) => h_flex().absolute().top(0).left(0).h_full().w(reach(p)).items_center().justify_end().pr(NUM_PAD)
      .text_size(NUM_SIZE).font_weight(600).text_color(solid(t.background)).child(text(p));
    // Fable's number ends left of the week's, with room between them.
    const both = part != null && reach(part) + NUM_GAP <= reach(w.pct) - textW(w.pct);
    return h_flex().gap(6).items_center().flex_none().tooltip(tip)
      .child(div().child(label))
      .child(div().relative().w(BAR_W).h(BAR_H).rounded_full().overflow_hidden()
        .child(layout()?.window_blur
          ? div().absolute().inset_0().rounded_full().bg(GLASS_TRACK[darkUi(t) ? "dark" : "light"]).border_1().border_color(GLASS_EDGE[darkUi(t) ? "dark" : "light"])
          : div().absolute().inset_0().rounded_full().bg(t.dim).opacity(TRACK))
        .child(fill(w.pct, hot ? t.blocked : t.accent))
        .when(part != null, el => el.child(fill(part, solid(t.background), PART)))
        .child(number(w.pct))
        .when(both, el => el.child(number(part))));
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
    const label = (icon, text) => h_flex().gap(6).items_center().min_w(0).child(svg(`mods/my-status/${icon}.svg`).size(13).flex_none()).child(div().truncate().child(text));
    // Under frosted glass (Customize) the work card's edge parts it from the bar: no line.
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).when(!layout()?.window_blur, el => el.border_t(1).border_color(t.border)).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "remote" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(branch), el => el.child(label("branch", `${branch}${g?.dirty ? "*" : ""}`)))
      .when(Boolean(g?.worktree), el => el.child(label("git-compare", `worktree ${g.worktree}`)))
      .child(h_flex().flex_none().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(Boolean(this.usage), el => el.child(h_flex().flex_none().gap(14).items_center()
        .children(METERS.filter(([key]) => this.usage[key]).map((m) => this.meter(t, m)))));
  }
}

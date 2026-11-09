import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, focused, theme, readTextFile, appHome, watchFolder, exec } from "herdr";

// Claude Code's and Grok's status lines (statusline.sh in this folder, or one
// that does the same), inside Herdr, print nothing and write
// {model, effort, remaining, at} here per terminal.
const AGENT_DIR = () => `${appHome()}/data/my-status/agents`;
const REPORTS = (a) => a.app === "claude-code" || a.program?.key === "claude" || /^grok/.test(a.app ?? "") || a.program?.key === "grok";
// The file is read when it changes (watched) or focus moves to another terminal
// (a light check, no file read); FALLBACK reads it anyway, should a watch miss.
const FOCUS_EVERY = 500;
const FALLBACK = 10000;
// Files of terminals long gone: cleared out on start.
const STALE_DAYS = 7;

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.claude = null; // {term, model, effort, remaining}
    this.term = undefined; // the terminal last read for
    this.reading = false;
    this.read(cx);
    cx.timer.every(FOCUS_EVERY, (cx) => { if (focused()?.terminal !== this.term) this.read(cx); });
    cx.timer.every(FALLBACK, (cx) => this.read(cx));
    cx.spawn(async (cx) => {
      const dir = AGENT_DIR();
      try {
        await exec("mkdir", ["-p", dir]);
        await exec("find", [dir, "-name", "*.json", "-mtime", `+${STALE_DAYS}`, "-delete"]);
      } catch {}
      for (;;) {
        try { await watchFolder(dir); } catch { return; } // the fallback timer carries on
        this.read(cx);
      }
    });
  }

  // The focused terminal's agent line, when it's an agent that writes one.
  read(cx) {
    if (this.reading) { this.again = true; return; }
    const term = focused()?.terminal;
    this.term = term;
    const a = term && agents().find((x) => x.address === term);
    if (!a || !REPORTS(a)) {
      if (this.claude) { this.claude = null; cx.notify(); }
      return;
    }
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${AGENT_DIR()}/${term}.json`);
        let d = null;
        try { d = text ? JSON.parse(text) : null; } catch {}
        const next = d ? { term, model: d.model, effort: d.effort, remaining: d.remaining } : null;
        if (JSON.stringify(next) !== JSON.stringify(this.claude)) { this.claude = next; cx.notify(); }
      } catch {}
      this.reading = false;
      // Something changed while this read was out: read again, now.
      if (this.again) { this.again = false; this.read(cx); }
    });
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const c = this.claude && this.claude.term === focused()?.terminal ? this.claude : null;
    const left = c?.remaining;
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(Boolean(c?.model), el => el.child(h_flex().gap(10).items_center()
        .child(div().child(c.effort ? `${c.model}@${c.effort}` : c.model))
        .when(left != null, el => el.child(div().child(`ctx ${Math.round(left)}%`)))));
  }
}

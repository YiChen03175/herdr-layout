// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "my-pane" } } } }
// Kept quiet: the session's name, the folder (dim) and the agent's status only (no
// program icon), a rule under it; on hover, buttons split, zoom and close this pane.
// Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, openOverlay, theme, home, shared, spaces } from "herdr";

// #rrggbb plus an alpha byte; other forms pass through.
const alpha = (color, a) => /^#[0-9a-f]{6}$/i.test(color ?? "") ? color + a : color;

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// A title without the marks in front of it (Claude Code's "✳ ").
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// What the program calls its session (Claude Code's session title): not a path,
// a user@host or the program's own name, which a shell's title is.
function ownTitle(p) {
  const live = clean(p.title);
  const telling = live && live !== p.program?.name && !/^[~/]|^[A-Za-z]:\\/.test(live)
    && !live.includes("@") && live.toLowerCase() !== p.program?.key;
  return telling ? live : "";
}

// The session's name as my-agents' list shows it: a tab someone named (not a
// number, not just the program), unless it's this title cut short
// ("herdr-layout 版面與…"); else the title. The tab's name is its agent's (else
// its only pane's): a shell split beside an agent has only its own title.
function sessionName(p, all) {
  const live = ownTitle(p);
  const mates = all.filter((q) => q.tab === p.tab && q.terminal);
  const lead = mates.find((q) => q.program?.agent) ?? (mates.length === 1 ? mates[0] : null);
  if (lead?.pane !== p.pane) return live;
  const tab = spaces().flatMap((s) => s.tabs).find((x) => x.id === p.tab);
  const named = tab?.named && tab.name !== p.program?.name && !/^\d+$/.test(tab.name) ? tab.name : "";
  const cut = named.endsWith("…") && live.startsWith(named.slice(0, -1).trimEnd());
  return named && !cut ? named : live;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me(all) {
    return all.find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        // Close asks first, in the same red dialog as the tab and agent menus (my-confirm).
        if (command === "pane.close") openOverlay({ mod: "my-confirm", kind: "dialog", width: 380, height: 170,
          props: { danger: true, title: "Close pane?", detail: "The terminal in this pane will end.", command: { name: command, args } } });
        else run(command, args);
      })
      .child(svg(`mods/my-pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const all = panes();
    const p = this.me(all);
    if (!p) return div();
    const name = sessionName(p, all);
    // my-agents' verdict: an agent that stopped but is waiting on its shells still works.
    const verdict = p.status === "done" || p.status === "idle" ? shared("agents.effective")?.[p.terminal] : null;
    const st = verdict ?? p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      // The name keeps its room; the folder after it gets what's left and is cut first.
      .when(Boolean(name), el => el.child(div().min_w(0).truncate().font_medium().text_color(t.foreground).child(name)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(alpha(t.blocked, "26")).text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}

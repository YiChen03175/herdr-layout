import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, settings, keys } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's width as drawn: measured live, since the layout's own number only
// changes when a drag of the edge ends. Before the first measure, the layout's.
let liveW = null;
const sidebarPx = () => liveW ?? (find(layout(), "sidebar")?.size?.px ?? Infinity);
const track = (el) => el.on_size_change((size, cx) => {
  const w = size.width / (settings().zoom || 1);
  if (liveW === null || Math.abs(w - liveW) > 0.25) { liveW = w; cx.notify(); }
});

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => sidebarPx() < 160;

// The rail, like Chrome's collapsed tabs: just icons, as narrow as an icon row.
// The macOS window buttons live in the tab bar, across the top of the window
// (layouts/my-main.json), never over the sidebar: nothing here makes room for them.
const RAIL_W = 40; // keep equal to the sidebar's "min" in layouts/my-main.json
// The rail's one button size: every icon in the sidebar sits on a square this
// big, EDGE from the sidebar's sides and its section edges, GAP from the next.
const TOGGLE = 30;
const EDGE = 5;
const RAIL_GAP = 2;
const RAIL_ICON = 16;

// Smoothly to the rail, or back to the width it had: the width eases over a
// quarter second (a short burst of resizes on a click, nothing while idle).
const SLIDE_MS = 240;
function toggleSidebar(view, cx) {
  const from = sidebarPx();
  if (!narrow()) setShared("sidebar.width", from);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  const to = narrow() ? (shared("sidebar.width") ?? 268) : RAIL_W;
  const start = Date.now(), run_id = (view.slide = (view.slide ?? 0) + 1);
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
  const step = (cx) => {
    if (view.slide !== run_id) return; // a newer click took over
    const k = Math.min(1, (Date.now() - start) / SLIDE_MS);
    run("layout.resize", { id: "sidebar", px: Math.round((from + (to - from) * ease(k)) * 10) / 10 });
    if (k < 1) cx.timer.after(16, step);
  };
  step(cx);
}

// The command palette's key as actually bound (none: no hint), e.g. "⌘⇧P".
function paletteKey() {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
  const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
  return parts ? parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : null;
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(TOGGLE).flex_none().flex().items_center().justify_center().rounded(8).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      // On the rail the rows are just their icons, centered.
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(TOGGLE).flex_none().px(8).gap(9).items_center().rounded(8).when(collapsed, el => el.px(0).w(TOGGLE).self_center().justify_center())
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(action).child(svg(`mods/my-chrome/${icon}.svg`).size(collapsed ? RAIL_ICON : 14))
        .when(!collapsed, el => el.child(label));
      const key = paletteKey();
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(collapsed ? EDGE : 8).py(EDGE).gap(RAIL_GAP).text_size(13)
        .child(row("commands", "command", "Commands", false, () => run("app.palette"))
          .when(!collapsed && Boolean(key), el => el.child(div().flex_1()).child(div().text_size(11.5).text_color(t.dim).child(key))))
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }

    const W = sidebarPx(), rail = RAIL_W;
    // The other sidebar mods read the rail width from here.
    if (shared("sidebar.rail") !== rail) setShared("sidebar.rail", rail);
    // Never narrower than the rail: a zoom change that needs a wider one widens it.
    if (Number.isFinite(W) && W < rail - 0.5 && !this.widening) {
      this.widening = true;
      run("layout.resize", { id: "sidebar", px: rail });
    } else if (W >= rail - 0.5) this.widening = false;
    // The search and the toggle move together with the width: side by side at the
    // right of the top row while there's room, stacked on the rail (toggle, then
    // search), sliding in between as it narrows. The row
    // grows with them, only as tall as they need: 46 when they're side by side.
    const BASE_H = 46, GAP = RAIL_GAP;
    const rowNeed = 8 + TOGGLE + GAP + TOGGLE + 10;
    // Where the buttons start to slide down is where the sidebar's titles go (my-spaces, my-agents).
    if (shared("sidebar.slide") !== Math.ceil(rowNeed)) setShared("sidebar.slide", Math.ceil(rowNeed));
    const p = Number.isFinite(W)
      // Fully stacked a few px before the rail, so a not-quite-minimal width
      // still leaves them their whole gap under the buttons.
      ? Math.max(0, Math.min(1, (rowNeed - W) / Math.max(1, rowNeed - rail - 6)))
      : 0;
    const colLeft = rail / 2 - TOGGLE / 2;
    const colTop = EDGE;
    const fullH = Math.max(BASE_H, Math.ceil(colTop + TOGGLE + GAP + TOGGLE + EDGE));
    const wantH = Math.round(BASE_H + (fullH - BASE_H) * p);
    const H = find(layout(), "brand")?.size?.px ?? BASE_H;
    // Ask again if a resize didn't land (one can be lost while the width animates).
    if (Math.abs(H - wantH) > 0.5 && (this.askedH !== wantH || Date.now() - this.askedAt > 300)) {
      this.askedH = wantH; this.askedAt = Date.now();
      run("layout.resize", { id: "brand", px: wantH });
    }
    const top0 = (BASE_H - TOGGLE) / 2;
    const mix = (a, b) => ({ left: a.left + (b.left - a.left) * p, top: a.top + (b.top - a.top) * p });
    const toggleAt = mix({ left: W - 10 - TOGGLE, top: top0 }, { left: colLeft, top: colTop });
    const searchAt = mix({ left: W - 10 - TOGGLE - GAP - TOGGLE, top: top0 }, { left: colLeft, top: colTop + TOGGLE + GAP });

    // Both buttons are placed absolutely; the row's padding only keeps the name
    // clear of them (none when narrow, where it would hold the row, and the
    // measured width, wider than the sidebar).
    return track(h_flex().id("brand-root")).relative().size_full().min_w(0).bg(t.chrome)
      .pl(collapsed ? 0 : 14).pr(collapsed ? 0 : 10 + TOGGLE + GAP + TOGGLE + 6).gap(4).items_center().text_size(13.5)
      .when(!collapsed, el => el.child(h_flex().flex_1().min_w(0).gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5).flex_none()).child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child("Herdr"))))
      .child(this.button("search", svg("mods/my-chrome/search.svg").size(RAIL_ICON), () => run("mod.open", { name: "picker" }))
        .absolute().left(searchAt.left).top(searchAt.top))
      .child(this.button("sidebar-toggle", svg("mods/my-chrome/sidebar.svg").size(RAIL_ICON), (_e, cx) => toggleSidebar(this, cx))
        .absolute().left(toggleAt.left).top(toggleAt.top));
  }
}

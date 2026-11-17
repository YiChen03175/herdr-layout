import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, closeOverlay, props, theme, window, shared, setShared, layout, settings, nextCommand } from "herdr";

// Status after my-agents' verdicts (shared "agents.effective"): an agent that stopped
// but is waiting on its shells still counts as working.
const URGENCY = { blocked: 4, done: 3, working: 2, idle: 1 };
const mostUrgent = (list) => list.reduce((m, s) => ((URGENCY[s] ?? 0) > (URGENCY[m] ?? 0) ? s : m), null);
function liveSpaces() {
  const all = spaces();
  const over = shared("agents.effective");
  if (!over || !Object.keys(over).length) return all;
  const byTab = {};
  for (const a of agents()) (byTab[a.tab] ??= []).push((a.status === "done" || a.status === "idle") && over[a.address] ? over[a.address] : a.status);
  return all.map((w) => {
    const tabs = w.tabs.map((c) => (byTab[c.id] ? { ...c, status: mostUrgent(byTab[c.id]) } : c));
    return { ...w, tabs, status: mostUrgent(tabs.map((c) => c.status).filter(Boolean)) ?? w.status };
  });
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The side panel (GitLab / Files / Changes) slides in and out: its width eases frame by
// frame and the terminal's card ("main-card") takes up the rest, so the two edges move
// together. The terminal inside the card keeps the width it had through the slide (a px
// size; the card cuts what's past its edge) and takes its new one once the slide is over:
// it reflows once, not every frame (which flickered). The panels' mods keep their
// content at the full width meanwhile (shared "panel.slide"), so it slides rather than
// squeezes.
// want: "gitlab" | "files" | "changes" | null (closed).
const PANEL_W = 368;
// The narrowest the panel stays at rest, and the narrowest width remembered.
const PANEL_MIN = 280;
const SLIDE_MS = 500;
let slide = null; // the one under way: { want, land() }
// What the panel shows: null when hidden, undefined when the layout has none.
function panelNow() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return panel ? (panel.hidden ? null : body?.active ?? null) : undefined;
}
// What it's headed for: a slide under way counts as there.
const panelGoal = () => (slide ? slide.want : panelNow());

function setPanel(want, cx) {
  want = want ?? null;
  const now = panelGoal();
  if (now === undefined || want === now) return;
  slide?.land(); // one at a time: the last one lands at once
  if (want) run("layout.select", { stack: "panel-body", child: want });
  if (want && now) return; // open to open: just the switch
  const root = layout();
  const w = want ? Math.max(PANEL_MIN, shared("panel.width") ?? PANEL_W) : find(root, "panel")?.size?.px ?? PANEL_W;
  if (!want && w >= PANEL_MIN) setShared("panel.width", w);
  const term = termWidth(root);
  if (!term) { // a layout without the terminal's card: no slide
    if (!want) return run("layout.hide", { id: "panel" });
    run("layout.resize", { id: "panel", px: w });
    return run("layout.show", { id: "panel" });
  }
  const place = (px) => run("layout.resize", { id: "panel", px: Math.max(1, px) });
  run("layout.resize", { id: "main", px: term });
  setShared("panel.slide", { w });
  if (want) { place(0); run("layout.show", { id: "panel" }); }
  const start = Date.now();
  const me = {
    want,
    land() {
      if (slide !== me) return;
      slide = null;
      if (!want) run("layout.hide", { id: "panel" });
      place(w);
      run("layout.resize", { id: "main", weight: 1 });
      setShared("panel.slide", null);
    },
  };
  slide = me;
  const frame = (cx) => {
    if (slide !== me) return;
    const k = Math.min(1, (Date.now() - start) / SLIDE_MS), eased = 1 - (1 - k) ** 3;
    if (k >= 1) return me.land();
    place(w * (want ? eased : 1 - eased));
    cx.timer.after(16, frame);
  };
  cx.timer.after(16, frame);
}

// The terminal's width now, in the layout's px; null without the terminal's card.
function termWidth(root) {
  if (!find(root, "main-card")) return null;
  const v = globalThis.window.viewport_size(), z = Number(settings()?.zoom) || 1;
  const r = placeOf(root, "main", { x: 0, y: 0, w: v.width, h: v.height }, z);
  return r ? r.w / z : null;
}
// Where node `id` sits in the window, in window px (the layout's px are zoomed): rows and
// columns as Herdr lays them out, padding first, then the shown children with gap and
// divider between, px sizes first and weights sharing the rest.
function placeOf(node, id, r, z) {
  if (node.id === id) return r;
  const kids = (node.children ?? []).filter((c) => !c.hidden);
  if (!kids.length) return null;
  const p = node.padding ?? 0, [pv, ph] = (Array.isArray(p) ? p : [p, p]).map((v) => v * z);
  const box = { x: r.x + ph, y: r.y + pv, w: r.w - 2 * ph, h: r.h - 2 * pv };
  if (node.type !== "row" && node.type !== "column") {
    for (const c of kids) { const hit = placeOf(c, id, box, z); if (hit) return hit; }
    return null;
  }
  const row = node.type === "row", step = ((node.gap ?? 0) + (node.divider?.width ?? 0)) * z;
  const fixed = kids.reduce((n, c) => n + (c.size?.px ?? 0) * z, 0);
  const weights = kids.reduce((n, c) => n + (c.size?.px == null ? c.size?.weight ?? 1 : 0), 0);
  const free = Math.max(0, (row ? box.w : box.h) - fixed - step * (kids.length - 1));
  let at = row ? box.x : box.y;
  for (const c of kids) {
    const len = c.size?.px != null ? c.size.px * z : (free * (c.size?.weight ?? 1)) / weights;
    const hit = placeOf(c, id, row ? { x: at, y: box.y, w: len, h: box.h } : { x: box.x, y: at, w: box.w, h: len }, z);
    if (hit) return hit;
    at += len + step;
  }
  return null;
}
// #rrggbb plus an alpha byte; other forms pass through.
const alpha = (color, a) => /^#[0-9a-f]{6}$/i.test(color ?? "") ? color + a : color;
// A localStorage value, or `fallback` when it's missing or unreadable.
function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
// blocked: the icon hops in place, asking for you (native loop, no timer), as in the sidebar.
const BOUNCE = { from: 0, to: -3.5, period: 700, easing: "ease-in-out" };

// A terminal title without the status glyph or spinner frame a program puts ahead of it.
const bareTitle = (title) => (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// What the tab's program calls it now (Claude Code titles its terminal with the session
// name, behind a status glyph like ✳ or a spinner). A shell prompt or a bare program
// name ("claude") isn't a name.
// own: the tab's panes (read once per render by the caller: each panes() copies them all).
function liveTitle(own) {
  own = own.filter(p => p.terminal && !p.program?.shell);
  const p = own.find(p => p.focused) ?? own[0];
  const title = bareTitle(p?.title);
  if (!title) return null;
  const lower = title.toLowerCase();
  if (lower === p.program?.key?.toLowerCase() || lower === p.program?.name?.toLowerCase()) return null;
  return title;
}

// Working tabs: the icon fades in and out slowly, like a working agent's
// icon in the sidebar (my-agents' PULSE).
const PULSE = { from: 0.35, to: 1, period: 2000, easing: "ease-in-out" };
// GitLab's news (a review asked of me, one of my MRs approved, not yet seen): its
// button lights up and its icon turns into the count, easing over this long.
const NEWS = { duration: 280, easing: "ease-out" };
// Below this tab bar width (layout px), GitLab, Files and Changes show only their icons.
const PANEL_LABELS_MIN = 760;
// The longest a tab's title gets (layout px), on a wide bar and below PANEL_LABELS_MIN.
// When they don't all fit at that, the long ones share what the short ones leave, all
// cut at one width (whatever the script: a limit in px, not characters).
const TITLE_MAX = { wide: 170, narrow: 100 };
// At least this many tabs show before any go in + N, their titles as short as that takes;
// past it, another one only while titles keep TITLE_MIN.
const MIN_TABS = 6;
const TITLE_MIN = 72;
const ELLIPSIS = "…";
const measuring = (ch) => `|${ch.repeat(8)}|`;
const SPARE = 0.5; // layout px a tab, for what's drawn coming out a hair wider than measured
// A tab around its title: padding, border, icon and the gap after it (layout px), until
// it's measured.
const TAB_CHROME = 48;
// The window's top edge crowds what's under it: the tabs sit this much lower in the
// bar (layout px), so the gaps above and below them look the same.
const BAR_TOP = 2;
// How long the pointer rests on + N before its menu opens.
const MORE_OPEN_MS = 120;
// A little air left after the +N, before Files and Changes (layout px).
const TAIL_ROOM = 16;
// Dragging a tab: the others spring aside under it; it follows the pointer on a very
// short spring (smooth, no lag you'd notice) and, let go, springs into its place. The
// new order is drawn once that spring has settled (SETTLE_MS).
const SHIFT = { response: 260, damping: 0.86 };
const FOLLOW = { response: 50, damping: 1 };
const SETTLE = { response: 260, damping: 0.86 };
const SETTLE_MS = 420;
// A held tab keeps following the pointer anywhere in the window: once the drag starts, a
// see-through overlay of this mod over the whole window (the shield) takes the pointer's
// moves and its release, which the bar alone stops hearing as soon as the pointer leaves
// it. Copies of a mod share its module, so the shield hands them over here; the bar
// looks every frame while the drag lasts. The shield closes itself (its own overlay id):
// on the release, once the drag is over, and on any press, so a shield left behind never
// keeps a click from the window.
const SHIELD = { on: false, x: null, up: false };
// A tab's icon, as its agent's in the sidebar (my-agents): Claude Code is Clawd acting
// out the status (my-agents' GIFs); other icons pulse while working and hop when blocked.
const CLAWD = new Set(["working", "blocked", "done"]);
function tabIcon(c, program, color) {
  if (!program?.icon) return null;
  if (program.key === "claude" && CLAWD.has(c.status)) {
    // In a box the icon's size: Clawd is drawn bigger, over its edges, and the
    // GIF's own size never reaches the tab's layout (it squeezed the title).
    return div().relative().size(14).flex_none()
      .child(image(`mods/my-agents/clawd-${c.status}.gif`).absolute().top(-2).left(-2).size(18));
  }
  return (program.tint ? svg(program.icon).size(14).text_color(color) : image(program.icon).size(14))
    .when(c.status === "working", el => el.loop("opacity", PULSE))
    .when(c.status === "blocked", el => el.relative().loop("top", BOUNCE));
}
// Read: an agent tab you've seen since it finished (idle, not the shown tab) is a
// little faded; one that finished unseen (done) stays at full strength.
const READ = { dim: "a6", icon: 0.6 };
// Under frosted glass the colours are already lighter on a see-through bar: fade less.
const READ_GLASS = { dim: "e0", icon: 0.85 };
const readLook = () => (glassy() ? READ_GLASS : READ);

// The shown tab is the terminal's card grown up into the bar, as a browser's tab is its
// page's: the card's color, rounded on top only, down to the bar's bottom edge, where the
// card starts. Under frosted glass the cards have no outline and curved feet carry the
// tab's sides out into the card's top edge; without glass an outline on three sides
// meets the bar's bottom line, which stops under the tab.
const JOIN_R = 8; // its top corners (layout px)
const FOOT = 6; // its feet (layout px)
const TAB_H = 29; // the other tabs, centered in the bar: the shown one's top is level with theirs
const JOIN_H = 33; // from that top to the bar's bottom
// The card under the tabs: its node, and its color (the theme's background, solid).
const cardNode = (root) => find(root, "main-card") ?? find(root, "work");
const cardColor = (root, t) => {
  const c = cardNode(root)?.background;
  return typeof c === "string" && c.startsWith("#") ? c : (t[c] ?? t.background).slice(0, 7);
};
function joinTab(el, t, fill, glass) {
  const foot = (side) => svg(`mods/my-tabs/foot-${side}.svg`).absolute().bottom(0).size(FOOT).text_color(fill);
  // Its text sits where the other tabs' does: 1 border on top, 5 below (theirs: 1 and 1, 4 lower).
  return el.self_end().h(JOIN_H).pb(5).relative().rounded_t(JOIN_R).bg(fill)
    .border_t(1).border_l(1).border_r(1).border_color(glass ? "#00000000" : t.border)
    // Outside the side borders (insets count from inside them).
    .when(glass, (el) => el.child(foot("left").left(-FOOT - 1)).child(foot("right").right(-FOOT - 1)));
}
// How far from the window's right edge the tabs stay (layout px): short of the card's
// right edge and round corner, where the side panel is, or is headed while it slides
// (its full width from the start: the tabs fit once, not every frame).
function tabsRight(root) {
  const node = cardNode(root);
  if (!node) return 0;
  const side = (n) => { const p = n?.padding ?? 0; return Array.isArray(p) ? p[1] : p; };
  const work = find(root, "work"), body = find(root, "work-body"), panel = find(root, "panel");
  const pw = panelGoal() ? (shared("panel.slide")?.w ?? panel?.size?.px ?? PANEL_W) : 0;
  const between = (body?.gap ?? 0) + (body?.divider?.width ?? 0);
  return side(work) + side(body) + (pw ? pw + between : 0) + (node.radius ?? 0) + 2;
}
// Where the tabs start (layout px): over the card, past its round corner and a foot, so the
// shown tab always meets the card and never the sidebar.
function tabsLeft(root) {
  const node = cardNode(root);
  if (!node) return 0;
  const v = globalThis.window.viewport_size(), z = Number(settings()?.zoom) || 1;
  const r = placeOf(root, node.id, { x: 0, y: 0, w: v.width, h: v.height }, z);
  return r ? r.x / z + (node.radius ?? 0) + FOOT + 2 : 0;
}

// Frosted glass (Customize): a selection is pressed into the glass, as iOS's segmented
// controls draw it: a darker, still see-through well with a narrow shadow inside all
// its edges. gpui has no inset shadow, so it's four faint rings 0.4 px apart: the edge
// is under all four, each step in under one fewer, so it fades out over 1.6 px. On the
// see-through window their opacities add up (gpui sums alpha there): each ring is
// barely there, the edge under 2% darker than the well.
// Hover is a faint lift. Off, rows look as before.
let glassAt = 0, glassNow = false;
const glassy = () => {
  if (Date.now() - glassAt > 300) { glassAt = Date.now(); glassNow = Boolean(layout()?.window_blur); }
  return glassNow;
};
const darkUi = (t) => parseInt(t.foreground.slice(1, 3), 16) > 128;
const GLASS_PICK = {
  dark: { fill: "#0000001f", ring: "#00000001", hoverFill: "#00000010" },
  light: { fill: "#00000014", ring: "#00000001", hoverFill: "#0000000a" },
};
const GLASS_RINGS = [0.4, 0.8, 1.2, 1.6];
const glassPick = (t) => GLASS_PICK[darkUi(t) ? "dark" : "light"];
// el: the selected box (positioned: relative or absolute); r: its corner radius; b: its
// own border's width (the rings go over it, so the shadow starts at the very edge).
const glassSelected = (el, t, r, b = 0) => {
  const p = glassPick(t);
  const edge = (w, c) => div().absolute().top(-b).left(-b).right(-b).bottom(-b).rounded(r).border(w).border_color(c);
  return el.bg(p.fill).children(GLASS_RINGS.map((w) => edge(w, p.ring)));
};
// Hover under frosted glass: the selected well, lighter: a fainter fill, and only the
// two outer rings (its shadow half as deep and as wide). now: hovered as drawn (the
// caller tracks it); else each part takes its color only while the pointer is over it.
const HOVER_RINGS = [0.4, 0.8];
const glassHovered = (el, t, r, b = 0, now = false) => {
  const p = glassPick(t);
  const edge = (w) => div().absolute().top(-b).left(-b).right(-b).bottom(-b).rounded(r).border(w)
    .border_color(now ? p.ring : "#00000000").when(!now, (e) => e.hover((s) => s.border_color(p.ring)));
  return (now ? el.bg(p.hoverFill) : el.hover((s) => s.bg(p.hoverFill))).children(HOVER_RINGS.map(edge));
};
// A blocked tab under frosted glass: its red as a fill (alpha bytes), a little more on hover.
const BLOCKED_GLASS = { fill: "40", hover: "59" };

export default class Tabs extends View {
  init(_props, cx) {
    // The drag's shield (SHIELD): no bar of its own; gone as soon as the drag is.
    if (props()?.shield) {
      const check = (cx) => { if (!SHIELD.on) closeOverlay(props().overlay); else cx.timer.after(100, check); };
      cx.timer.after(100, check);
      return;
    }
    this.flip = null;     // { ids, offsets, applied, until }: a reorder sliding into place
    this.flipAt = 0;      // when the last reorder slid, for its longer transition
    this.looking = false; // a redraw is already asked for (lookAgain)
    // A title change alone doesn't redraw mods: look once a second at the titles liveTitle
    // reads (the shown space's programs), redraw only when one changes past its spinner.
    this.titles = "";
    cx.timer.every(1000, (cx) => {
      const tabs = new Set(this.barSpaces(spaces()).flatMap(s => s.tabs.map(c => c.id)));
      const now = panes().filter(p => tabs.has(p.tab) && p.terminal && !p.program?.shell).map(p => bareTitle(p.title)).join("\n");
      if (now !== this.titles) { this.titles = now; cx.notify(); }
    });
    this.drag = null;     // { id, from, to, x0, dx, active }: the tab being held
    this.pending = null;  // a dropped move, shown in place until the new order arrives
    this.gen = 0;         // bumped when a reorder lands, so tabs don't slide back
    this.widths = {};     // tab id -> width, window px
    this.machineSpace = stored("machineSpace", {}); // machine ("" here) -> the space last shown there
    // The bar's own order (tab ids) and the sidebar order it last followed (see ordered).
    ({ order: this.barOrder = [], side: this.sideKey = null } = stored("barOrder", {}));
    this.cut = {};        // tab id -> whether its title is cut short (fit)
    this.titleW = {};     // tab id -> its title's width, window px
    this.textW = {};      // a measuring string -> its width, layout px (see measure)
    this.numbers = stored("numbers", {}); // unnamed tab id -> its number
    this.panels = stored("tabPanels", {}); // tab id -> "gitlab" | "files" | "changes" | null
    this.panelPending = null; // see syncPanel
    // `herdr-app do my-tabs.<gitlab|files|changes>` toggles that panel, `my-tabs.close` shuts it.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "close") setPanel(null, cx);
        else if (["gitlab", "files", "changes"].includes(c)) setPanel(panelGoal() === c ? null : c, cx);
      }
    });
  }

  // The side panel is remembered per tab (each tab is one session): switching tabs
  // switches to that tab's choice (closed if it never had one), and opening or closing
  // it records it. Width is shared by all tabs.
  syncPanel(space, panel, body, enabled, cx) {
    const tab = space?.tabs?.find(c => c.active);
    if (!tab || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    // At rest, dragged narrower than PANEL_MIN: back to it; else it's the width to keep.
    // Not while it slides: its width is the slide's then.
    const px = panel.size?.px ?? 0;
    if (!slide) {
      if (find(layout(), "main")?.size?.px) run("layout.resize", { id: "main", weight: 1 }); // a slide cut short (a reload)
      else if (!panel.hidden && px < PANEL_MIN) run("layout.resize", { id: "panel", px: PANEL_MIN });
      else if (!panel.hidden && px !== shared("panel.width")) setShared("panel.width", px);
    }
    if (tab.id !== this.tab) {
      const first = this.tab === undefined;
      this.tab = tab.id; this.panelPending = null;
      if (!(first && !(tab.id in this.panels))) {
        const stored = this.panels[tab.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.panelPending = { want, until: Date.now() + 1000 };
          setPanel(want, cx);
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.panelPending) {
      if (this.panelPending.want !== now && Date.now() < this.panelPending.until) return;
      this.panelPending = null;
    }
    if (this.panels[tab.id] === now) return;
    this.panels[tab.id] = now;
    localStorage.setItem("tabPanels", JSON.stringify(this.panels));
  }

  // The spaces whose tabs the bar shows: the shown one, and on every other machine the
  // one last shown there (else its first). This computer's first, then the others by
  // name: switching between them doesn't move the tabs.
  barSpaces(sp) {
    const on = sp.find(s => s.active);
    if (on && this.machineSpace[on.machine ?? ""] !== on.id) {
      this.machineSpace[on.machine ?? ""] = on.id;
      localStorage.setItem("machineSpace", JSON.stringify(this.machineSpace));
    }
    const names = [...new Set(sp.map(s => s.machine ?? ""))].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    return names.map(k => {
      const mine = sp.filter(s => (s.machine ?? "") === k);
      return mine.find(s => s.active) ?? mine.find(s => s.id === this.machineSpace[k]) ?? mine[0];
    }).filter(Boolean);
  }

  // Their tabs, in that order. Each space has a tab it shows; the bar's shown one
  // (active) is the shown space's only. space / machine: where the tab is.
  barTabs(list) {
    return list.flatMap(s => s.tabs.map(c => ({ ...c, active: c.active && s.active, space: s.id, machine: s.machine ?? null })));
  }

  // An unnamed tab keeps the number it first showed (its place then, or the next free one),
  // so moving tabs doesn't renumber them.
  // tabs: the shown space's; sp: every space (closed tabs' entries go).
  labels(tabs, sp) {
    const live = new Set(sp.flatMap(p => p.tabs.map(c => c.id)));
    let changed = false;
    if (live.size) for (const id of Object.keys(this.numbers)) if (!live.has(id)) { delete this.numbers[id]; changed = true; }
    // Closed tabs' measures and panels go too.
    if (live.size) for (const m of [this.widths, this.cut, this.titleW]) for (const id of Object.keys(m)) if (!live.has(id)) delete m[id];
    if (live.size && Object.keys(this.panels).some(id => !live.has(id))) {
      for (const id of Object.keys(this.panels)) if (!live.has(id)) delete this.panels[id];
      localStorage.setItem("tabPanels", JSON.stringify(this.panels));
    }
    const taken = new Set(tabs.filter(c => !c.named && this.numbers[c.id]).map(c => this.numbers[c.id]));
    for (const c of tabs) {
      if (c.named || this.numbers[c.id]) continue;
      let n = c.index;
      while (taken.has(n)) n++;
      taken.add(n); this.numbers[c.id] = n; changed = true;
    }
    if (changed) localStorage.setItem("numbers", JSON.stringify(this.numbers));
    return Object.fromEntries(tabs.map(c => [c.id, String(this.numbers[c.id] ?? c.index)]));
  }

  // Window px, from the measured widths; gap is the tab strip's 3.
  geometry(shown) {
    const z = settings().zoom || 1, gap = 3 * z;
    const W = shown.map(c => this.widths[c.id] ?? 80 * z), L = [];
    W.forEach((w, j) => L.push(j ? L[j - 1] + W[j - 1] + gap : 0));
    return { z, gap, W, L };
  }

  // The shield's own view: the whole window, see-through, the closed hand over it.
  shield() {
    const close = () => closeOverlay(props().overlay);
    return div().id("tab-shield").size_full().cursor_grabbing()
      // Not a drag of the overlay; a press here means the drag is long over.
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); SHIELD.on = false; close(); })
      .on_mouse_move((e) => { SHIELD.x = e.position.x; })
      .on_mouse_up("left", () => { SHIELD.up = true; close(); });
  }

  // The drag has started: the shield goes up, and the bar follows what it hears each
  // frame until the release (or the drag ends some other way).
  raiseShield(cx) {
    if (SHIELD.on) return;
    SHIELD.on = true; SHIELD.x = null; SHIELD.up = false;
    openOverlay({ mod: "my-tabs", kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 }, props: { shield: true } });
    let last = null;
    const tick = (cx) => {
      if (!this.drag?.active) return this.lowerShield();
      if (SHIELD.up) return this.dragEnd(this.shownNow ?? [], cx);
      if (SHIELD.x !== null && SHIELD.x !== last) { last = SHIELD.x; this.dragMove({ position: { x: SHIELD.x } }, this.shownNow ?? [], cx); }
      cx.timer.after(16, tick);
    };
    cx.timer.after(16, tick);
  }

  lowerShield() {
    SHIELD.on = false; // the shield sees it and closes itself
  }

  dragMove(e, shown, cx) {
    const d = this.drag;
    if (!d || !shown[d.from] || shown[d.from].id !== d.id) return;
    const dx = (e.position.x - d.x0) * d.k;
    // Starts once the pointer has gone a few px any way (down out of the bar too).
    if (!d.active && Math.abs(dx) < 4 * d.k && Math.abs((e.position.y ?? d.y0) - d.y0) < 4 * d.k) return;
    if (!d.active) this.raiseShield(cx);
    d.active = true;
    const { W, L } = this.geometry(shown), n = W.length;
    d.dx = Math.max(-L[d.from], Math.min(L[n - 1] + W[n - 1] - L[d.from] - W[d.from], dx));
    // Swap once the leading edge (right when moving right, left when moving left)
    // passes the other tab's midline.
    const left = L[d.from] + d.dx, right = left + W[d.from];
    let to = d.from;
    if (d.dx > 0) for (let j = d.from + 1; j < n; j++) if (right > L[j] + W[j] / 2) to = j;
    if (d.dx < 0) for (let j = d.from - 1; j >= 0; j--) if (left < L[j] + W[j] / 2) to = j;
    d.to = to;
    cx.notify();
  }

  dragEnd(shown, cx) {
    const d = this.drag;
    this.drag = null;
    this.lowerShield();
    if (!d) return;
    if (!d.active) { cx.notify(); return; } // a click: shown on the press already
    // Let go: it springs into its slot (where it is, if it never left its own). The new
    // order is drawn once that's over (render).
    const old = (this.all ?? shown).map(c => c.id), ids = [...old];
    if (d.to !== d.from) {
      // Indexes are among the tabs shown; the move is in the bar's own order (tabs of
      // different machines mix there, which no space's order could hold).
      ids.splice(ids.indexOf(shown[d.to].id), 0, ...ids.splice(ids.indexOf(d.id), 1));
      this.saveOrder(ids);
    }
    const pending = this.pending = { ...d, ids, old, until: Date.now() + SETTLE_MS };
    cx.timer.after(SETTLE_MS + 16, (cx) => cx.notify());
    // If the move never shows up, the tabs slide back.
    cx.timer.after(1000, (cx) => { if (this.pending === pending) { this.pending = null; cx.notify(); } });
    cx.notify();
  }

  // Each tab's left offset in layout px while dragging or settling.
  offsets(shown) {
    const d = this.drag?.active ? this.drag : this.pending;
    if (!d || shown[d.from]?.id !== d.id) return [];
    const { z, gap, W } = this.geometry(shown), off = [], shift = (W[d.from] + gap) / z;
    for (let j = d.from + 1; j <= d.to; j++) off[j] = -shift;
    for (let j = d.to; j < d.from; j++) off[j] = shift;
    let slot = 0;
    for (let j = d.from + 1; j <= d.to; j++) slot += W[j] + gap;
    for (let j = d.to; j < d.from; j++) slot -= W[j] + gap;
    off[d.from] = (d === this.drag ? d.dx : slot) / z;
    return off;
  }

  // The bar's order: its own (a drag changes it), following the sidebar's
  // ("agents.tabOrder", machines mixed as there) whenever that changes, each tab then
  // easing from where it was. A tab neither lists goes after the one before it in
  // barTabs' order (its machine's run).
  ordered(list, cx) {
    const side = shared("agents.tabOrder"), key = JSON.stringify(side ?? null);
    const cur = this.place(list, this.barOrder);
    if (!Array.isArray(side) || key === this.sideKey || this.drag?.active || this.pending || this.flip) return cur;
    this.sideKey = key;
    const at = new Map(side.map((id, i) => [id, i]));
    const next = cur.map((c, i) => ({ c, k: at.get(c.id) ?? side.length + i })).sort((a, b) => a.k - b.k).map(x => x.c);
    this.saveOrder(next.map(c => c.id));
    if (next.some((c, i) => c !== cur[i])) this.startFlip(cur.map(c => c.id), next.map(c => c.id), cx);
    return next;
  }

  // `list` in `order`; what it doesn't hold, after the tab before it in `list`.
  place(list, order) {
    const pos = new Map(order.map((id, i) => [id, i]));
    const out = list.filter(c => pos.has(c.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    list.forEach((c, i) => {
      if (pos.has(c.id)) return;
      const before = list.slice(0, i).reverse().find(p => out.includes(p));
      out.splice(before ? out.indexOf(before) + 1 : 0, 0, c);
    });
    return out;
  }

  saveOrder(ids) {
    this.barOrder = ids;
    localStorage.setItem("barOrder", JSON.stringify({ order: ids, side: this.sideKey }));
  }

  // From the order `from` to `to` (ids): each tab drawn where it was, then eased over.
  startFlip(from, to, cx) {
    const before = this.geometry(from.map(id => ({ id }))), after = this.geometry(to.map(id => ({ id })));
    const offsets = {};
    to.forEach((id, k) => { offsets[id] = (before.L[from.indexOf(id)] - after.L[k]) / after.z; });
    this.flip = { ids: to, offsets, applied: false, until: Date.now() + 1000 };
    const settle = (cx) => {
      if (!this.flip) return;
      if (this.flip.applied || Date.now() > this.flip.until) { this.flip = null; this.flipAt = Date.now(); cx.notify(); }
      else cx.timer.after(16, settle);
    };
    cx.timer.after(16, settle);
  }

  // Each space's tabs follow the sidebar in core too (Herdr's own next / previous tab):
  // my-agents shares the order its rows show the tabs in ("agents.tabOrder"); a tab it
  // doesn't list keeps its place after those it does. One move at a time. The bar draws
  // its own order (ordered). Runs on every render (a new order redraws every mod).
  reorder(sp, cx) {
    if (this.drag?.active || this.pending || this.flip) return;
    const order = shared("agents.tabOrder");
    if (!Array.isArray(order)) return;
    const sig = JSON.stringify(order) + sp.map(w => w.tabs.map(c => c.id).join()).join("|");
    if (sig === this.orderSig) return;
    const at = new Map(order.map((id, i) => [id, i]));
    for (const space of sp) {
      const ids = space.tabs.map(c => c.id);
      const want = ids.map((id, i) => ({ id, k: at.get(id) ?? order.length + i })).sort((a, b) => a.k - b.k).map(x => x.id);
      const j = want.findIndex((id, k) => id !== ids[k]);
      if (j < 0) continue;
      const id = want[j];
      run("tab.move", { id, index: j + 1 });
      // One move at a time: the next look (the new order redraws; else this) sees it.
      this.lookAgain(200, cx);
      return;
    }
    this.orderSig = sig;
  }

  // Draw (and so reorder) again in `ms`; once, however often it's asked meanwhile.
  lookAgain(ms, cx) {
    if (this.looking) return;
    this.looking = true;
    cx.timer.after(ms, (cx) => { this.looking = false; cx.notify(); });
  }

  // The tab's title; read is a little faded (working pulses only the icon).
  title(c, text, read, t) {
    const base = c.active ? t.foreground : t.muted;
    // Every title is cut at the same width (fit's cap), by the characters' measured widths:
    // the tab is then as wide as what it shows (gpui's own cut keeps the whole width, a
    // character's worth of it empty). Until they're measured, gpui cuts; whether this one
    // is cut then says whether its tab's measured width is its whole width (fit).
    const cap = this.caps?.get(c.id) ?? this.cap ?? this.titleMax(), own = this.cutTo(text, cap);
    return div().id(`title-${c.id}`)
      .when(Boolean(own), el => el.whitespace_nowrap())
      .when(!own, el => el.max_w(cap).truncate())
      .on_size_change((size, cx) => {
        const z = settings().zoom || 1, cut = size.width >= (this.cap ?? this.titleMax()) * z - 0.5;
        if (this.cut[c.id] === cut && Math.abs((this.titleW[c.id] ?? 0) - size.width) <= 0.5) return;
        this.cut[c.id] = cut; this.titleW[c.id] = size.width;
        cx.notify();
      })
      .text_color(read ? alpha(base, readLook().dim) : base)
      .child(own ? own.text : text);
  }

  // One character's width (layout px): eight of it between two bars, less the two bars
  // alone, over eight (no kerning against a neighbor, rounding spread thin); null until
  // it's measured.
  charW(ch) {
    const a = this.textW[measuring(ch)], b = this.textW["||"];
    return a == null || b == null ? null : (a - b) / 8;
  }

  // A text cut to fit `cap` (layout px), an ellipsis after what's kept: {text, w}; null
  // while one of its characters isn't measured.
  cutTo(s, cap) {
    const chars = [...s], ws = chars.map(ch => this.charW(ch)), dots = this.charW(ELLIPSIS);
    if (dots == null || ws.some(w => w == null)) return null;
    const whole = ws.reduce((a, b) => a + b, 0);
    if (whole <= cap) return { text: s, w: whole };
    let w = 0, k = 0;
    while (k < chars.length && w + ws[k] + dots <= cap) w += ws[k++];
    while (k > 0 && chars[k - 1] === " ") w -= ws[--k];
    return { text: chars.slice(0, k).join("") + ELLIPSIS, w: w + dots };
  }

  // Hidden copies of what's not measured yet (charW), at the titles' size. Each once.
  measure(labels) {
    const want = new Set(["||", measuring(ELLIPSIS)]);
    for (const label of labels) for (const ch of label) want.add(measuring(ch));
    const z = settings().zoom || 1;
    return [...want].filter(m => this.textW[m] == null).map(m => div().id(`measure-${[...m].map(ch => ch.codePointAt(0)).join("-")}`)
      .absolute().top(0).left(0).opacity(0).whitespace_nowrap().text_size(12.8).child(m)
      .on_size_change((size, cx) => { if (size.width > 0 && this.textW[m] == null) { this.textW[m] = size.width / z; cx.notify(); } }));
  }

  // The longest a title gets now (layout px).
  titleMax() {
    return (this.barW ?? Infinity) < PANEL_LABELS_MIN ? TITLE_MAX.narrow : TITLE_MAX.wide;
  }

  // A tab's room round its title (padding, border, icon; layout px): as measured, else TAB_CHROME.
  chrome(c) {
    const w = this.widths[c.id], tw = this.titleW[c.id];
    return w && tw != null ? (w - tw) / (settings().zoom || 1) : TAB_CHROME;
  }

  // The widest every title can be for `list` to fill `room` (layout px), as water fills:
  // a tab whose whole title fits keeps its width, the long ones share what's left alike.
  // Each tab's room round its title (padding, icon) as measured. labels: tab id -> title.
  // Until the characters are measured: the long ones are those gpui cut (or never
  // measured), sharing alike. At most titleMax().
  capFor(list, room, labels) {
    const z = settings().zoom || 1, chrome = (c) => this.chrome(c);
    // Every character measured: the widest cap whose cut titles fill no more than `room`.
    if (list.every(c => this.cutTo(labels.get(c.id), 0))) {
      // Half a pixel a tab to spare: what's drawn can come out a hair wider than the sum.
      const span = (cap) => list.reduce((s, c) => s + chrome(c) + this.cutTo(labels.get(c.id), cap).w + SPARE, 0);
      if (span(this.titleMax()) <= room) return this.titleMax();
      let lo = 0, hi = this.titleMax();
      for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (span(mid) <= room) lo = mid; else hi = mid; }
      return lo;
    }
    const tabs = list.map(c => {
      const tw = this.titleW[c.id];
      return { chrome: chrome(c), title: tw != null && this.cut[c.id] === false ? tw / z : Infinity };
    }).sort((a, b) => a.title - b.title);
    let left = room, chromes = tabs.reduce((s, x) => s + x.chrome, 0), n = tabs.length;
    for (const x of tabs) {
      const cap = (left - chromes) / n;
      if (x.title > cap) return Math.min(this.titleMax(), cap);
      left -= x.chrome + x.title; chromes -= x.chrome; n--;
    }
    return this.titleMax();
  }

  // What the shared cap leaves of `room` goes a character at a time to the shortest cut
  // title, while the next character fits: each tab's own cap (tab id -> layout px); null
  // until the characters are measured.
  share(list, cap, room, labels) {
    if (!list.every(c => this.cutTo(labels.get(c.id), 0))) return null;
    const max = this.titleMax();
    const now = new Map(list.map(c => [c.id, this.cutTo(labels.get(c.id), cap)]));
    let left = room - list.reduce((s, c) => s + this.chrome(c) + now.get(c.id).w + SPARE, 0);
    const caps = new Map(list.map(c => [c.id, cap]));
    for (let guard = 0; guard < 400; guard++) {
      // The shortest title still cut, whose next character fits.
      let best = null;
      for (const c of list) {
        const label = labels.get(c.id), cur = now.get(c.id);
        if (cur.text === label) continue;
        const next = this.grow(label, cur.w, max);
        if (next && next.w - cur.w <= left && (!best || cur.w < best.cur.w)) best = { c, cur, next };
      }
      if (!best) break;
      left -= best.next.w - best.cur.w;
      now.set(best.c.id, best.next);
      caps.set(best.c.id, best.next.w + 0.01); // a hair over: the same sum again fits
    }
    return caps;
  }

  // The next longer cut of `label` than width `w` (one more character, or the whole),
  // within `max`; null when there's none.
  grow(label, w, max) {
    const chars = [...label], dots = this.charW(ELLIPSIS);
    let sum = 0;
    for (let k = 0; k < chars.length; k++) {
      sum += this.charW(chars[k]);
      const cut = k + 1 === chars.length ? this.cutTo(label, sum) : this.cutTo(label, sum + dots);
      if (cut.w > w + 0.01) return cut.w <= max ? cut : null;
    }
    return null;
  }

  // Which tabs fit the strip, and how wide titles get (this.cap). All of them when titles
  // can keep TITLE_MIN; else room is kept for the + N button and the first ones go in, at
  // least MIN_TABS, more while titles keep TITLE_MIN. The shown tab always stays in, in
  // place of the last ones if it's further along.
  fit(all, labels) {
    const z = settings().zoom || 1, gap = 3;
    const W = this.stripW && this.stripW / z - 2 * FOOT; // layout px, inside its padding
    const room = (list, more) => W - gap * (list.length - 1) - (more ? gap + (this.moreW ?? 44 * z) / z + TAIL_ROOM : 0);
    this.caps = null;
    if (!W || !all.length) { this.cap = this.titleMax(); return { shown: all, more: [] }; }
    const capAll = this.capFor(all, room(all, false), labels);
    if (capAll >= TITLE_MIN || all.length <= MIN_TABS) {
      this.cap = Math.max(capAll, 24);
      this.caps = this.share(all, this.cap, room(all, false), labels);
      return { shown: all, more: [] };
    }
    const active = all.find(c => c.active);
    // The first k, the shown tab in place of the last if it's further along.
    const first = (k) => {
      const list = all.slice(0, k);
      return active && !list.includes(active) ? [...list.slice(0, -1), active] : list;
    };
    let k = MIN_TABS;
    while (k + 1 < all.length && this.capFor(first(k + 1), room(first(k + 1), true), labels) >= TITLE_MIN) k++;
    const pick = first(k);
    this.cap = Math.max(this.capFor(pick, room(pick, true), labels), 24);
    this.caps = this.share(pick, this.cap, room(pick, true), labels);
    const shown = all.filter(c => pick.includes(c)); // in the strip's order
    return { shown, more: all.filter(c => !shown.includes(c)) };
  }

  // + N: the tabs that don't fit, in a menu that opens under it on hover. Picking one shows it.
  moreMenu(t, more, programOf, nameOf, stop) {
    const trigger = div().id("tab-more").cursor_pointer().h(29).px(9).flex_none().flex().items_center().justify_center().rounded(7)
      .border(1).border_color(t.border).text_size(12.8).font_medium().text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_size_change((size, cx) => { if (Math.abs((this.moreW ?? 0) - size.width) > 0.5) { this.moreW = size.width; cx.notify(); } })
      .child(`+ ${more.length}`);
    const row = (c) => {
      const program = programOf(c);
      return h_flex().id(`more-${c.id}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .text_size(12.8).text_color(c.status === "idle" ? t.muted : t.foreground)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => { if (c.space && !spaces().find(w => w.id === c.space)?.active) run("space.select", { id: c.space }); run("tab.select", { id: c.id }); })
        .when(Boolean(program?.icon), el => el.child(tabIcon(c, program, t.foreground)))
        .when(Boolean(c.machine), el => el.child(svg("mods/my-spaces/remote.svg").size(12).flex_none().text_color(t.dim)))
        .child(div().flex_1().min_w(0).truncate().child(nameOf(c, program)));
    };
    return HoverCard.new("tab-more-menu").anchor("top_right").open_delay(MORE_OPEN_MS).close_delay(250)
      .trigger(trigger)
      .content(v_flex().w(240).mt(4).p(5).rounded(9).bg(t.popover).border(1).border_color(t.border).shadow_lg()
        .children(more.map(row)));
  }

  render(cx) {
    if (props()?.shield) return this.shield();
    const t = theme();
    const sp = liveSpaces();
    const space = sp.find(p => p.active);
    // Every machine's tabs together (barSpaces), each machine's in a run.
    let all = this.ordered(this.barTabs(this.barSpaces(sp)), cx);
    // Every pane, by tab: one panes() read for the whole render.
    const byTab = new Map();
    for (const p of panes()) {
      const own = byTab.get(p.tab);
      if (own) own.push(p); else byTab.set(p.tab, [p]);
    }
    // A dropped tab springs into its new place in the order it was dragged in: the new
    // order (once core has it) is drawn when the spring is over and every tab is already
    // where that order puts it, so nothing jumps.
    const p = this.pending;
    if (p && all.map(c => c.id).join() === p.ids.join()) {
      if (Date.now() >= p.until) { this.pending = null; this.gen++; }
      else { const byId = new Map(all.map(c => [c.id, c])); all = p.old.map(id => byId.get(id)); }
    }
    this.reorder(sp, cx);
    const number = this.labels(all, sp); // tab id -> the number an unnamed tab goes by
    const programOf = (c) => { const own = byTab.get(c.id) ?? []; return own.find(p => p.program?.agent)?.program ?? own[0]?.program; };
    // A tab the + menu opened is named after its program ("Claude Code"): that's not
    // a name anyone chose, so the program's own title (the session name) wins.
    // A name someone gave it (tab.rename) stays.
    const nameOf = (c, program) => {
      const chosen = c.named && c.name !== program?.name;
      return /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : chosen ? c.name : liveTitle(byTab.get(c.id) ?? []) ?? (c.named ? c.name : number[c.id]);
    };
    // What each tab's title reads.
    const labels = new Map(all.map(c => { const name = nameOf(c, programOf(c)); return [c.id, c.zoomed ? `${name} Z` : name]; }));
    // The tabs that fit; the rest go in the +N menu at the end of the strip.
    const { shown, more } = this.fit(all, labels);
    this.shownNow = shown;
    this.all = all;
    let off = this.offsets(shown);
    // A reorder just landed: draw each tab where it was (new ids, so no
    // transition from 0), then settle() clears it and they slide over.
    if (this.flip && !this.flip.applied && all.map(c => c.id).join() === this.flip.ids.join()) { this.flip.applied = true; this.gen++; }
    if (this.flip?.applied) off = shown.map(c => this.flip.offsets[c.id] ?? 0);
    const sliding = Date.now() - this.flipAt < 600;
    const drag = this.drag;
    const lifted = drag?.active ? drag.from : this.pending ? this.pending.from : null;
    // No hover looks while a tab is dragged or settling.
    const still = lifted === null;
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).cursor_pointer().size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // The terminal a rename suggests from: the tab's agent, else its first terminal.
    const termOf = (c) => { const own = byTab.get(c.id) ?? []; return (own.find(p => p.program?.agent) ?? own.find(p => p.terminal))?.terminal ?? null; };
    const root = layout(), w = window();
    const glass = glassy(), fill = cardColor(root, t);
    // The tab being dragged (or springing into its place) is drawn last, over the others,
    // at its own spot (window px from the strip's start); its slot keeps its room.
    const held = drag?.active ? drag : this.pending;
    const heldAt = held && shown[held.from]?.id === held.id ? held.from : -1;
    const geo = heldAt >= 0 ? this.geometry(shown) : null;
    const item = (c, i, floating = false) => {
      const program = programOf(c);
      const name = nameOf(c, program);
      // working looks calm too: no fill, the pulse says it's busy.
      const calm = c.status !== "blocked";
      const read = c.status === "idle" && !c.active;
      return h_flex().id(floating ? `tab-${c.id}-held${this.gen}` : `tab-${c.id}-${this.gen}`).px(10).gap(7).items_center().flex_none().text_size(12.8)
        .text_color(c.active ? t.foreground : t.muted)
        .when(c.active, el => joinTab(el, t, fill, glass))
        .when(!c.active, el => el.h(TAB_H).rounded(7).border(1)
          // idle / done / working (or no agent): outline only, filled on hover. Under
          // frosted glass, no outline: they sit on the glass beside the shown one.
          .when(calm, el => el.border_color(glass ? "#00000000" : t.border)
            .when(still, el => (glass ? glassHovered(el, t, 7, 1) : el.hover(s => s.bg(t.hover)))))
          // blocked: a translucent red border; under frosted glass a red fill instead,
          // no outline, as the glass's other fills.
          .when(!calm && !glass, el => el.border_color(alpha(t.blocked, "66")).bg(t.chrome).when(still, el => el.hover(s => s.bg(t.hover))))
          .when(!calm && glass, el => el.border_color("#00000000").bg(alpha(t.blocked, BLOCKED_GLASS.fill))
            .when(still, el => el.hover(s => s.bg(alpha(t.blocked, BLOCKED_GLASS.hover))))))
        // A new width changes what fits: fit again (only on a real change, so no loop).
        .on_size_change((size, cx) => {
          if (!(size.width > 0) || Math.abs((this.widths[c.id] ?? 0) - size.width) <= 0.5) return;
          this.widths[c.id] = size.width;
          cx.notify();
        })
        // Dragging: the held tab follows the pointer, still joined to the card (an
        // inactive one, for the moment before it's shown, lifts); the others spring aside.
        .when(floating, el => el.absolute().left(FOOT + geo.L[i] / geo.z + (off[i] ?? 0)).bottom(c.active ? 0 : JOIN_H - TAB_H)
          .spring("left", drag?.active ? FOLLOW : SETTLE)
          .when(!c.active, el => el.bg(t.raised).border_color(t.input).shadow_md()))
        .when(!floating, el => el.relative().left(off[i] ?? 0)
          .when(sliding, el => el.transition("left", { duration: 320, easing: "ease-in-out" }))
          .when(!sliding, el => el.spring("left", SHIFT)))
        // Hand over a tab; a closed hand while one is held and dragged.
        .cursor_pointer().when(floating && drag?.active, el => el.cursor_grabbing())
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          // Shown on the press, as a browser's tabs are: the one you drag is the shown one.
          if (!c.active) {
            if (c.space !== space?.id) run("space.select", { id: c.space });
            run("tab.select", { id: c.id });
          }
          if (this.pending) return; // still springing into place
          if (e.click_count === 2) {
            this.drag = null;
            openOverlay({ mod: "my-rename", kind: "dialog", width: 420, height: 210,
              props: { title: "Rename tab", value: name, terminal: termOf(c), command: { name: "tab.rename", args: { id: c.id } } } });
            return;
          }
          // Pointer units vs measured widths (they can differ under zoom): calibrate on the press.
          const width = this.widths[c.id], k = width && e.bounds?.width ? width / e.bounds.width : 1;
          this.drag = { id: c.id, from: i, to: i, x0: e.position.x, y0: e.position.y, k, dx: 0, active: false };
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "my-menu", kind: "popup", width: 200,
          // The name shown here and the terminal to suggest from, for Rename and Close.
          props: { tab: "tab", target: { id: c.id, space: c.space, name, terminal: termOf(c) } } }); })
        .when(Boolean(program?.icon), el => el.child(tabIcon(c, program, c.active ? t.foreground : t.muted)
          .when(read, el => el.opacity(readLook().icon))))
        // On another machine: a cloud, its name on hover.
        .when(Boolean(c.machine), el => el.child(div().id(`tab-machine-${c.id}`).flex_none().tooltip(c.machine)
          .text_color(c.active ? t.muted : t.dim).child(svg("mods/my-spaces/remote.svg").size(12))))
        .child(this.title(c, labels.get(c.id) ?? name, read, t));
    };
    // The bar spans the window's top, window buttons and all: start past them, and over the card.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? (root.traffic_lights[0] + 64) / (settings().zoom || 1) + 12
      : 10;
    const start = Math.max(lightsPadding, tabsLeft(root));
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // Herdr's own panels (Settings can turn them off), plus mods/my-gitlab, always.
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "gitlab"];
    this.syncPanel(space, panel, body, enabled, cx);
    // Narrower than PANEL_LABELS_MIN, the GitLab, Files and Changes buttons are just their icons.
    const iconOnly = (this.barW ?? Infinity) < PANEL_LABELS_MIN;
    // news: how many new things wait behind the button (GitLab). Lit, a brighter
    // label fades in (no fill), and the icon fades up and out while the count rises
    // into its place, its slot widening to fit; unlit, the same backwards (the count
    // fading out is the last one shown).
    const panelButton = (id, label, icon, news = 0) => {
      const on = panel && !panel.hidden && body?.active === id;
      const lit = news > 0 && !on;
      if (news > 0) (this.newsShown ??= {})[id] = news;
      const n = this.newsShown?.[id] ?? 0;
      const count = n > 99 ? "99+" : String(n);
      // The count is the icon's height (14): a circle for one digit, wider for more.
      const slotW = lit ? 14 + 5 * (count.length - 1) : 14;
      const fade = (key, shown) => div().id(`panel-${id}-${key}`).opacity(shown ? 1 : 0).transition("opacity", NEWS);
      return h_flex().id(`panel-${id}`).cursor_pointer().h(26).px(iconOnly ? 6 : 8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .when(glassy(), el => (on ? glassSelected(el.relative(), t, 6) : glassHovered(el.relative(), t, 6)))
        .when(!glassy(), el => el.hover(s => s.bg(t.hover))).on_mouse_down("left", stop)
        .on_click((_e, cx) => setPanel(on ? null : id, cx))
        .child(div().id(`panel-${id}-slot`).relative().h(14).flex_none().w(slotW).transition("width", NEWS)
          .child(fade("icon", !lit).absolute().left(0).top(lit ? -5 : 0).transition("top", NEWS).child(svg(icon).size(14)))
          .when(n > 0, el => el.child(fade("count", lit).absolute().left(0).w_full().h(14).top(lit ? 0 : 5).transition("top", NEWS)
            .flex().items_center().justify_center().rounded_full().bg(t.accent)
            .text_color(t.background.slice(0, 7)).text_size(9.5).font_bold().child(count)))) // solid under frosted glass
        .when(!iconOnly, el => el.child(div().relative().child(label)
          .child(fade("label", lit).absolute().top(0).left(0).text_color(t.foreground).child(label))))
        .when(iconOnly, el => el.tooltip(lit ? `${label} · ${n} new` : label));
    };
    // The strip keeps a foot's room at each end (the shown tab's feet would be cut there).
    return h_flex().size_full().min_w(0).px(10).pt(BAR_TOP).pl(start - FOOT).gap(3).items_center().bg(t.chrome)
      .id("tabs-root")
      // The bar's bottom line, drawn first so the shown tab covers it (a border would go over
      // the tab). Under frosted glass (Customize) the card's edge parts it from the bar: no line.
      .when(!glass, el => el.child(div().absolute().left(0).right(0).bottom(0).h(1).bg(t.border)))
      // Characters the titles use that aren't measured yet (cutTo), hidden.
      .children(this.measure([...labels.values()]))
      // The bar's width, in layout px, for the panel buttons' labels.
      .on_size_change((size, cx) => {
        const w = size.width / (settings().zoom || 1);
        if (this.barW === undefined || Math.abs(w - this.barW) > 0.5) { this.barW = w; cx.notify(); }
      })
      .on_mouse_move((e, cx) => this.dragMove(e, shown, cx))
      .on_mouse_up("left", (_e, cx) => this.dragEnd(shown, cx))
      // A press that left the bar before it became a drag drops nothing (a drag has the
      // shield, which covers the bar, so leaving is what it does first).
      .on_hover((over, cx) => { if (!over && this.drag && !this.drag.active) { this.drag = null; cx.notify(); } })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().px(FOOT).items_center().gap(3).overflow_x_scrollbar()
        .on_size_change((size, cx) => { if (Math.abs((this.stripW ?? 0) - size.width) > 0.5) { this.stripW = size.width; cx.notify(); } })
        // The held tab's slot keeps its room; the tab itself goes last, over the rest.
        .children(shown.map((c, i) => (i === heldAt
          ? div().id(`slot-${c.id}-${this.gen}`).flex_none().h(TAB_H).w(geo.W[i] / geo.z)
          : item(c, i))))
        .when(more.length > 0, el => el.child(this.moreMenu(t, more, programOf, nameOf, stop)))
        .when(heldAt >= 0, el => el.child(item(shown[heldAt], heldAt, true)))
        )
      // New tabs start from the + at the top of the agents list (my-agents).
      // GitLab first, then Herdr's own panels, at the right; they hold the bar's right
      // end at least as far as the terminal's card stops short of the window's (tabsRight),
      // so the tabs stay over the card and never hang over the side panel.
      .child(h_flex().flex_none().gap(3).items_center().justify_end().min_w(Math.max(0, tabsRight(root) - 10 - 3))
        .child(panelButton("gitlab", "GitLab", "mods/my-gitlab/gitlab.svg", shared("my-gitlab.new") ?? 0))
        .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
        .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/my-tabs/changes.svg")))
        .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/my-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
          .child(button("maximize", w.platform === "windows" ? svg(`mods/my-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
          .child(button("close-window", w.platform === "windows" ? svg("mods/my-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close")))));
  }
}

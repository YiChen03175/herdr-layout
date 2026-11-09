import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// #rrggbb plus an alpha byte; other forms pass through.
const alpha = (color, a) => /^#[0-9a-f]{6}$/i.test(color ?? "") ? color + a : color;
// A localStorage value, or `fallback` when it's missing or unreadable.
function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
// blocked or unread (done): the icon hops in place, asking for you (native loop, no timer).
const BOUNCE = { from: 0, to: -3.5, period: 700, easing: "ease-in-out" };

// What the tab's program calls it now (Claude Code titles its terminal with the session
// name, behind a status glyph like ✳ or a spinner). A shell prompt or a bare program
// name ("claude") isn't a name.
// own: the tab's panes (read once per render by the caller: each panes() copies them all).
function liveTitle(own) {
  own = own.filter(p => p.terminal && !p.program?.shell);
  const p = own.find(p => p.focused) ?? own[0];
  const title = (p?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (!title) return null;
  const lower = title.toLowerCase();
  if (lower === p.program?.key?.toLowerCase() || lower === p.program?.name?.toLowerCase()) return null;
  return title;
}

// Working tabs: dimmed title and icon, with a shine sweeping left to right
// that wraps around: as it leaves on the right it comes back in on the left.
// Native .loop() only swings there-and-back, so each sweep is a one-way linear
// native transition of one title width, restarted every SHINE.sweep ms with the
// bands one width back, which looks the same (two redraws per sweep, only while
// a tab in the shown space is working).
const SHINE = { dim: "b3", icon: 0.55, sweep: 2000, band: 30, fade: 350 };
// Below this tab bar width (layout px), Files and Changes show only their icons.
const PANEL_LABELS_MIN = 760;
// The longest a tab's title gets (layout px), on a wide bar and below PANEL_LABELS_MIN.
const TITLE_MAX = { wide: 170, narrow: 100 };
// A tab around its title: padding, border, icon and the gap after it (layout px).
const TAB_CHROME = 43;
// How long the pointer rests on + N before its menu opens.
const MORE_OPEN_MS = 120;
// A little air left after the +N, before Files and Changes (layout px).
const TAIL_ROOM = 16;
// The shortest title worth squeezing a tab in for, before the +N.
const SQUEEZE_MIN = 40;
const SHINE_KICK = 30; // ms between parking a sweep and starting it
// Tab order by urgency: higher goes left. idle, working and no agent are equal.
const RANK = { blocked: 3, done: 2 };
const anyWorking = (sp = spaces()) => sp.some(s => s.active && s.tabs.some(c => c.status === "working"));
// Read: an agent tab you've seen since it finished (idle, not the shown tab) is a
// little faded; one that finished unseen (done) stays at full strength.
const READ = { dim: "a6", icon: 0.6 };
// The shown tab's border: its title color, a little softer (alpha bytes).
const ACTIVE_BORDER = { normal: "bf", working: "8c" };

export default class Tabs extends View {
  init(_props, cx) {
    this.shine = 0;      // sweep number: a new one starts one width back
    this.shineGo = false; // false: parked; true: moving one width right
    this.labelWidths = {}; // tab id -> title width, layout px
    this.shineRunning = false; // a chain of sweeps is going
    this.shineFirst = {};  // working tab id -> the sweep it joins at (fading in)
    // Sweeps chain one after another while something works; a light check
    // (no redraw) starts the chain within 200 ms of a tab starting to work,
    // instead of waiting out a whole period with the shine parked.
    // One spaces() read per check, shared by both.
    cx.timer.every(200, (cx) => {
      const sp = spaces();
      if (!this.shineRunning && anyWorking(sp)) this.startSweep(cx);
      this.reorder(cx, sp);
    });
    this.ranks = {};      // tab id -> its last rank, to see what just got more urgent
    this.flip = null;     // { ids, offsets, applied, until }: a reorder sliding into place
    this.flipAt = 0;      // when the last reorder slid, for its longer transition
    // A title change alone doesn't redraw mods: look once a second, redraw only on a change.
    this.titles = "";
    cx.timer.every(1000, (cx) => {
      const now = panes().map(p => p.title).join("\n");
      if (now !== this.titles) { this.titles = now; cx.notify(); }
    });
    this.drag = null;     // { id, from, to, x0, dx, active }: the tab being held
    this.pending = null;  // a dropped move, shown in place until the new order arrives
    this.gen = 0;         // bumped when a reorder lands, so tabs don't slide back
    this.widths = {};     // tab id -> width, window px
    this.numbers = stored("numbers", {}); // unnamed tab id -> its number
    this.panels = stored("panels", {});
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // An unnamed tab keeps the number it first showed (its place then, or the next free one),
  // so moving tabs doesn't renumber them.
  labels(shown, sp) {
    const live = new Set(sp.flatMap(p => p.tabs.map(c => c.id)));
    let changed = false;
    if (live.size) for (const id of Object.keys(this.numbers)) if (!live.has(id)) { delete this.numbers[id]; changed = true; }
    // Closed tabs' measures and ranks go too.
    if (live.size) for (const m of [this.ranks, this.widths, this.labelWidths, this.shineFirst]) for (const id of Object.keys(m)) if (!live.has(id)) delete m[id];
    const taken = new Set(shown.filter(c => !c.named && this.numbers[c.id]).map(c => this.numbers[c.id]));
    for (const c of shown) {
      if (c.named || this.numbers[c.id]) continue;
      let n = c.index;
      while (taken.has(n)) n++;
      taken.add(n); this.numbers[c.id] = n; changed = true;
    }
    if (changed) localStorage.setItem("numbers", JSON.stringify(this.numbers));
    return Object.fromEntries(shown.map(c => [c.id, String(this.numbers[c.id] ?? c.index)]));
  }

  // Window px, from the measured widths; gap is the tab strip's 3.
  geometry(shown) {
    const z = settings().zoom || 1, gap = 3 * z;
    const W = shown.map(c => this.widths[c.id] ?? 80 * z), L = [];
    W.forEach((w, j) => L.push(j ? L[j - 1] + W[j - 1] + gap : 0));
    return { z, gap, W, L };
  }

  dragMove(e, shown, cx) {
    const d = this.drag;
    if (!d || !shown[d.from] || shown[d.from].id !== d.id) return;
    const dx = (e.position.x - d.x0) * d.k;
    if (!d.active && Math.abs(dx) < 4 * d.k) return;
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
    if (!d) return;
    if (!d.active) { run("tab.select", { id: d.id }); cx.notify(); return; }
    if (d.to !== d.from) {
      // Indexes are among the tabs shown; the move is in the whole list.
      const ids = (this.all ?? shown).map(c => c.id);
      const target = ids.indexOf(shown[d.to].id);
      ids.splice(target, 0, ...ids.splice(ids.indexOf(d.id), 1));
      this.pending = { ...d, ids };
      run("tab.move", { id: d.id, index: target + 1 });
      // If the move never shows up, let the tabs slide back.
      cx.timer.after(1000, (cx) => { if (this.pending?.ids === ids) { this.pending = null; cx.notify(); } });
    }
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

  // Order: blocked > unread (done) > idle = working. A tab that just got more
  // urgent moves left, to just after the nearest tab on its left that's at least
  // as urgent; one that got calmer stays put (looking at a tab doesn't shuffle
  // the others). The shown space's move slides: each tab starts drawn where it
  // was and eases to its new place.
  reorder(cx, sp = spaces()) {
    if (this.drag?.active || this.pending || this.flip) return;
    // Nothing moves unless some tab's status changed since the last look.
    const sig = sp.map(s => s.tabs.map(c => `${c.id}:${c.status}`).join()).join("|");
    if (sig === this.rankSig) return;
    this.rankSig = sig;
    const rank = (c) => RANK[c.status] ?? 1;
    for (const space of sp) {
      const ids = space.tabs.map(c => c.id);
      for (const [i, c] of space.tabs.entries()) {
        const was = this.ranks[c.id], now = rank(c);
        this.ranks[c.id] = now;
        if (was === undefined || now <= was) continue;
        let j = ids.indexOf(c.id);
        while (j > 0 && rank(space.tabs.find(t => t.id === ids[j - 1])) < now) j--;
        const from = ids.indexOf(c.id);
        if (j === from) continue;
        if (space.active) {
          const before = this.geometry(ids.map(id => ({ id })));
          const order = [...ids]; order.splice(j, 0, ...order.splice(from, 1));
          const after = this.geometry(order.map(id => ({ id })));
          const offsets = {};
          order.forEach((id, k) => { offsets[id] = (before.L[ids.indexOf(id)] - after.L[k]) / after.z; });
          this.flip = { ids: order, offsets, applied: false, until: Date.now() + 1000 };
          const settle = (cx) => {
            if (!this.flip) return;
            if (this.flip.applied || Date.now() > this.flip.until) { this.flip = null; this.flipAt = Date.now(); cx.notify(); }
            else cx.timer.after(16, settle);
          };
          cx.timer.after(16, settle);
        }
        run("tab.move", { id: c.id, index: j + 1 });
        return; // one move at a time: the next check sees the new order
      }
    }
  }

  // One sweep: park the bands one width back, start them a moment later, and
  // chain the next sweep while anything still works.
  startSweep(cx) {
    this.shineRunning = true;
    this.shine++; this.shineGo = false; cx.notify();
    cx.timer.after(SHINE_KICK, (cx) => { this.shineGo = true; cx.notify(); });
    cx.timer.after(SHINE.sweep, (cx) => {
      if (anyWorking()) this.startSweep(cx);
      else { this.shineRunning = false; this.shineGo = false; cx.notify(); }
    });
  }

  // The tab's title. Working: the text is dimmed, and a bright copy of it shows
  // through moving windows, each
  // counter-shifted so the copy stays on top of the dim text: only the glyphs shine.
  title(c, text, working, read, t) {
    const base = c.active ? t.foreground : t.muted;
    const z = settings().zoom || 1, lw = this.labelWidths[c.id];
    // A narrow bar (where Files and Changes go to icons) gives each title less room.
    // The last tab before +N can be squeezed to fill what's left of the strip.
    const label = div().id(`title-${c.id}`).max_w(this.squeeze?.id === c.id ? this.squeeze.title : this.titleMax()).truncate()
      .text_color(working ? alpha(base, SHINE.dim) : read ? alpha(base, READ.dim) : base)
      .on_size_change((size, cx) => {
        const w = size.width / z;
        if (Math.abs((this.labelWidths[c.id] ?? 0) - w) > 0.5) { this.labelWidths[c.id] = w; cx.notify(); }
      })
      .child(text);
    if (!working) delete this.shineFirst[c.id];
    if (!working || !lw) return div().relative().child(label);
    // A tab joins at a sweep it sees parked (so the move is animated, not
    // already at its end): this one if it's parked now, else the next.
    if (!(c.id in this.shineFirst)) this.shineFirst[c.id] = this.shineRunning && !this.shineGo ? this.shine : this.shine + 1;
    const first = this.shineFirst[c.id];
    if (this.shine < first) return div().relative().child(label);
    // Bands one width apart (-1, 0, +1), all moving one width right per sweep:
    // the set looks the same at the start and the end, so the restart is seamless.
    // On the tab's first sweep there's no +1 (nothing to leave on the right) and
    // the 0 band, starting on the left edge, fades in rather than popping up.
    const joining = this.shine === first;
    const shift = this.shineGo ? lw : 0;
    const motion = { duration: SHINE.sweep - SHINE_KICK, easing: "linear" };
    const band = (key, k, width, color) => {
      const x = k * lw + shift - width / 2;
      const id = `shine-${key}${k}-${c.id}-${this.shine}`;
      return div().id(id).absolute().top(0).h_full().w(width).overflow_hidden()
        .left(x).transition("left", motion)
        .when(joining && k === 0, el => el.opacity(this.shineGo ? 1 : 0).transition("opacity", { duration: SHINE.fade, easing: "ease-out" }))
        .child(div().id(`${id}-text`).absolute().top(0).w(lw).truncate().text_color(color)
          .left(-x).transition("left", motion).child(text));
    };
    // One layer, in the shown tab's title color: stacking copies thickens the
    // glyph edges and reads brighter than the real text.
    const bands = (joining ? [-1, 0] : [-1, 0, 1]).map(k => band("b", k, SHINE.band, t.foreground));
    return div().relative().child(label).children(bands);
  }

  // The longest a title gets now (layout px).
  titleMax() {
    return (this.barW ?? Infinity) < PANEL_LABELS_MIN ? TITLE_MAX.narrow : TITLE_MAX.wide;
  }

  // Which tabs fit the strip (window px, from the measured widths). When they
  // don't all fit, the first ones that do, with room left for the +N button; the
  // shown tab always stays in, in place of the last ones if it's further along.
  fit(all) {
    const W = this.stripW;
    const z = settings().zoom || 1, gap = 3 * z;
    // A hidden tab's width was measured when it last showed, maybe under a longer
    // title limit: count it as at most a tab with the longest title now.
    const longest = (this.titleMax() + TAB_CHROME) * z;
    const w = (c) => Math.min(this.widths[c.id] ?? longest, longest);
    const span = (list) => list.reduce((s, c, j) => s + w(c) + (j ? gap : 0), 0);
    this.squeeze = null;
    if (!W || span(all) <= W + 0.5) return { shown: all, more: [] };
    const room = W - gap - (this.moreW ?? 44 * z) - TAIL_ROOM * z;
    let k = 0;
    while (k < all.length && span(all.slice(0, k + 1)) <= room) k++;
    let shown = all.slice(0, Math.max(1, k));
    const active = all.find(c => c.active);
    if (active && !shown.includes(active)) {
      while (shown.length && span([...shown, active]) > room) shown.pop();
      shown = [...shown, active];
    }
    // Room left for most of the next tab: it goes in too, its title cut short.
    const next = all.find(c => !shown.includes(c));
    const left = room - span(shown) - gap;
    if (next && left >= (TAB_CHROME + SQUEEZE_MIN) * z) {
      this.squeeze = { id: next.id, title: Math.floor(left / z - TAB_CHROME) };
      const at = all.indexOf(next);
      shown = all.filter(c => shown.includes(c) || c === next).sort((a, b) => all.indexOf(a) - all.indexOf(b));
      if (at < 0) shown = [...shown, next];
    }
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
      const loud = c.status === "blocked" || c.status === "done";
      return h_flex().id(`more-${c.id}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .text_size(12.8).text_color(c.status === "idle" ? t.muted : t.foreground)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("tab.select", { id: c.id }))
        .when(Boolean(program?.icon), el => el.child((program.tint ? svg(program.icon).size(14) : image(program.icon).size(14))
          .when(loud, el => el.relative().loop("top", BOUNCE))))
        .child(div().flex_1().min_w(0).truncate().child(nameOf(c, program)));
    };
    return HoverCard.new("tab-more-menu").anchor("top_right").open_delay(MORE_OPEN_MS).close_delay(250)
      .trigger(trigger)
      .content(v_flex().w(240).mt(4).p(5).rounded(9).bg(t.popover).border(1).border_color(t.border).shadow_lg()
        .children(more.map(row)));
  }

  render() {
    const t = theme();
    const sp = spaces();
    const space = sp.find(p => p.active);
    const all = space?.tabs ?? [];
    // Every pane, by tab: one panes() read for the whole render.
    const byTab = new Map();
    for (const p of panes()) byTab.set(p.tab, [...(byTab.get(p.tab) ?? []), p]);
    if (this.pending && all.map(c => c.id).join() === this.pending.ids.join()) { this.pending = null; this.gen++; }
    // The tabs that fit; the rest go in the +N menu at the end of the strip.
    const { shown, more } = this.fit(all);
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
    const label = this.labels(all, sp);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).cursor_pointer().size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const programOf = (c) => { const own = byTab.get(c.id) ?? []; return own.find(p => p.program?.agent)?.program ?? own[0]?.program; };
    // A tab the + menu opened is named after its program ("Claude Code"): that's not
    // a name anyone chose, so the program's own title (the session name) wins.
    // A name someone gave it (tab.rename) stays.
    const nameOf = (c, program) => {
      const chosen = c.named && c.name !== program?.name;
      return /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : chosen ? c.name : liveTitle(byTab.get(c.id) ?? []) ?? (c.named ? c.name : label[c.id]);
    };
    const item = (c, i) => {
      const program = programOf(c);
      const name = nameOf(c, program);
      // working looks calm too: no fill, the shine says it's busy.
      const calm = c.status !== "blocked";
      const working = c.status === "working";
      const read = c.status === "idle" && !c.active;
      // The shown tab's border is its title's color (dimmed with it while working).
      const activeBorder = alpha(t.foreground, working ? ACTIVE_BORDER.working : ACTIVE_BORDER.normal);
      return h_flex().id(`tab-${c.id}-${this.gen}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).text_color(c.active ? t.foreground : t.muted)
        // idle / done / working (or no agent): outline only, filled on hover.
        .when(calm, el => el.border_color(c.active ? activeBorder : t.border).when(still, el => el.hover(s => s.bg(c.active ? t.raised : t.hover))))
        // blocked: as before, but a translucent red border.
        .when(!calm, el => el.border_color(c.active ? activeBorder : c.status === "blocked" ? alpha(t.blocked, "66") : t.chrome)
          .bg(c.active ? t.raised : t.chrome).when(still, el => el.hover(s => s.bg(t.hover))))
        // A squeezed tab's width isn't its own: keep the one it has unsqueezed.
        // A new width changes what fits: fit again (only on a real change, so no loop).
        .on_size_change((size, cx) => {
          if (!(size.width > 0) || this.squeeze?.id === c.id || Math.abs((this.widths[c.id] ?? 0) - size.width) <= 0.5) return;
          this.widths[c.id] = size.width;
          cx.notify();
        })
        // Dragging: the held tab follows the pointer, the others slide aside.
        .relative().left(off[i] ?? 0)
        .when(!(drag?.active && drag.from === i), el => el.transition("left", sliding ? { duration: 320, easing: "ease-in-out" } : { duration: 160, easing: "ease-out" }))
        // Hand over a tab; a closed hand while one is held and dragged.
        .cursor_pointer().when(drag?.active && drag.from === i, el => el.cursor_grabbing())
        .when(lifted === i, el => el.bg(t.raised).border_color(t.input).shadow_md())
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          if (e.click_count === 2) { this.drag = null; run("tab.rename", { id: c.id }); return; }
          // Pointer units vs measured widths (they can differ under zoom): calibrate on the press.
          const w = this.widths[c.id], k = w && e.bounds?.width ? w / e.bounds.width : 1;
          this.drag = { id: c.id, from: i, to: i, x0: e.position.x, k, dx: 0, active: false };
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child((program.tint ? svg(program.icon).size(14).text_color(c.active ? t.foreground : t.muted) : image(program.icon).size(14))
          // The shown tab's icon stays bright, working or not.
          .when(!c.active && (working || read), el => el.opacity(working ? SHINE.icon : READ.icon))
          .when(c.status === "blocked" || c.status === "done", el => el.relative().loop("top", BOUNCE))))
        .child(this.title(c, c.zoomed ? `${name} Z` : name, working, read, t));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    // The bar spans the window's top, window buttons and all: start past them.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? (root.traffic_lights[0] + 64) / settings().zoom + 12
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    // Narrower than PANEL_LABELS_MIN, the Files and Changes buttons are just their icons.
    const iconOnly = (this.barW ?? Infinity) < PANEL_LABELS_MIN;
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).cursor_pointer().h(26).px(iconOnly ? 6 : 8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14))
        .when(!iconOnly, el => el.child(label))
        .when(iconOnly, el => el.tooltip(label));
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .id("tabs-root")
      // The bar's width, in layout px, for the panel buttons' labels.
      .on_size_change((size, cx) => {
        const w = size.width / (settings().zoom || 1);
        if (this.barW === undefined || Math.abs(w - this.barW) > 0.5) { this.barW = w; cx.notify(); }
      })
      .on_mouse_move((e, cx) => this.dragMove(e, shown, cx))
      .on_mouse_up("left", (_e, cx) => this.dragEnd(shown, cx))
      // Leaving the bar mid-drag drops nothing: the tabs slide back.
      .on_hover((over, cx) => { if (!over && this.drag) { this.drag = null; cx.notify(); } })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar()
        .on_size_change((size, cx) => { if (Math.abs((this.stripW ?? 0) - size.width) > 0.5) { this.stripW = size.width; cx.notify(); } })
        .children(shown.map(item))
        .when(more.length > 0, el => el.child(this.moreMenu(t, more, programOf, nameOf, stop)))
        )
      // New tabs start from the + at the top of the agents list (my-agents).
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/my-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/my-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/my-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}

// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, settings, exec, hc, appHome, home, notify } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
// The sidebar's width as drawn: measured live, since the layout's own number only
// changes when a drag of the edge ends. Before the first measure, the layout's.
let liveW = null;
const sidebarW = () => liveW ?? (find(layout(), "sidebar")?.size?.px ?? Infinity);
const track = (el) => el.on_size_change((size, cx) => {
  const w = size.width / (settings().zoom || 1);
  if (liveW === null || Math.abs(w - liveW) > 0.25) { liveW = w; cx.notify(); }
});
const narrow = () => sidebarW() < 160;
// The rail shows names once there's room for a few letters; only near its narrowest do they go.
const named = () => sidebarW() >= 110;
// Once the search and toggle start sliding under the window buttons (my-chrome
// shares where): Chrome-like, icons only, no titles. my-chrome
// shares the rail width.
const mini = () => sidebarW() < (shared("sidebar.slide") ?? 114);
// How an icon shows a status there: blocked hops (as in the tab bar), working
// pulses slowly, idle is a little faded, unread (done) is full.
const BOUNCE = { from: 0, to: -3.5, period: 700, easing: "ease-in-out" };
// working: a slow fade in and out (2 s), like the tab bar's working tabs.
const PULSE = { from: 0.35, to: 1, period: 2000, easing: "ease-in-out" };
const IDLE_OPACITY = 0.55;
// Folding to the mini rail and back: titles collapse, icons glide, the rest fades.
const SLIDE = { duration: 200, easing: "ease-out" };
const FADE = { duration: 160, easing: "ease-out" };
// A re-sort: each row that moved slides from where it was to its new place.
const MOVE = { duration: 300, easing: "ease-in-out" };
// Space between rail rows (and above the first, once the titles fold away).
const ROW_GAP = 2;
// Mini rail: icon squares sit this far from the sidebar's sides and section edges.
const RAIL_EDGE = 5;
// On the mini rail: a square as tall as the row, centered on its 18 px icon,
// in the row's selected or hover color (nothing otherwise).
const railSquare = (t, rowH, selected, hovered) => {
  const inset = (rowH - 18) / 2;
  return div().absolute().top(-inset).left(-inset).size(rowH).rounded(8)
    .when(selected || hovered, (el) => el.bg(selected ? t.selected : t.hover));
};
// Recaps (Claude Code's and Grok's "while you were away" line): recap.py finds
// each agent's latest one, until the person writes again. Checked every few
// seconds; the agents write one a few minutes after a turn ends.
// How often agents' states are compared (in-process, cheap): the corner note
// Herdr puts up shows until the next look closes it, so look often.
const MAC_EVERY = 100;
// Closing the note: tried at once, then this often while it hasn't shown yet,
// for at most TOAST_TRIES tries.
const TOAST_RETRY = 40;
const TOAST_TRIES = 10;
const RECAP_EVERY = 5000;
const RECAP_EVERY_AWAY = 30000; // while the window isn't in front
// decide.py judges agents that stopped with shells still open. Its verdict is the
// status every mod shows (shared "agents.effective"): waiting stays working. An agent
// that just stopped stays working until the verdict, so a pause never flashes done.
const DECIDE_EVERY = 4000;
// With nothing held and no verdict out, a stop is caught by its hold (asked at once):
// the timer then only retries, as often as decide.py's own RETRY_AFTER.
const DECIDE_IDLE_EVERY = 60000;
const DECIDE_HOLD = 5000; // ms: never wait longer than this for a verdict
const RECAP_DELAY = 300; // how long the pointer rests on a row before the card opens
// A terminal swallows mouse moves, so a pointer that leaves for one never reports leaving
// here: while something is hovered, compare the pointer with its bounds instead.
const HOVER_POLL = 80;
const RECAP_W = 300;
const CARD_LINE_H = 12.5 * 1.5; // one line of a card's text
// Idle this long, an agent moves to Archived at the list's bottom (right-click: by hand).
const ARCHIVE_AFTER = 6 * 3600000;
// Archived shows its newest few; a button above them unfolds the rest upward.
const ARCHIVE_SHOWN = 3;
const ROW_H = 30 + 2, SUB_H = 26; // a row with its half gaps; a sub-agent row
// Popups from the sidebar (the + menu, a recap) open just clear of its edge, their
// top a little above where the pointer is, so the first line reads level with it.
// Near the bottom the app keeps them inside the window.
const POP_GAP = 4;
const POP_LIFT = 6;

// #rrggbb plus an alpha byte; other forms pass through.
const alpha = (color, a) => /^#[0-9a-f]{6}$/i.test(color ?? "") ? color + a : color;
// A localStorage value, or `fallback` when it's missing or unreadable.
function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
// Agents recap.py reads (Claude Code and Grok recaps, and the last reply of those and
// opencode): without one alive it has nothing to find.
const RECAPS = (a) => a.app === "claude-code" || /^(grok|opencode)/.test(a.app ?? "") || ["claude", "grok", "opencode"].includes(a.program?.key);

// A folder's last part ("~" for home).
const folderName = (path) => (path.replace(/\/+$/, "") === home() ? "~" : path.replace(/\/+$/, "").split("/").pop() || path);
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Claude Code agents show Clawd acting out the status instead of the icon (idle
// keeps the icon). GIFs from clawd-tank, clawd-pet and clawd-on-desk (see clawd.LICENSE): 36 px,
// a few frames, 4-8 fps, so they cost little to draw.
// Each as a GIF and as its frames (clawd-<status>/NN.png, `ms` apart).
const CLAWD = {
  working: { frames: 32, ms: 120 },
  blocked: { frames: 20, ms: 120 },
  done: { frames: 23, ms: 140 },
};
const clawdOf = (a) => (a.program?.key === "claude" && CLAWD[a.status] ? a.status : null);
// Changing between them (or back to the icon): the old one fades out, the new one in.
const PIC_FADE = { duration: 140, easing: "ease-in-out" };
// Herdr doesn't play GIFs while its window isn't in front (other drawing goes on).
// There the list shows the frame for the time instead, redrawn this often, only
// while a Clawd is shown; in front, the GIF plays natively and nothing ticks.
const GIF_TICK = 120;
const pad2 = (n) => String(n).padStart(2, "0");
// Clawd fills less of its square than the icon: drawn bigger, in the icon's footprint.
const clawdPic = (name, size) => {
  const c = CLAWD[name];
  const src = window().active
    ? `mods/my-agents/clawd-${name}.gif`
    : `mods/my-agents/clawd-${name}/${pad2(Math.floor(Date.now() / c.ms) % c.frames)}.png`;
  return image(src).w(size + 4).h(size + 4).m(-2).flex_none();
};

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu || props()?.agentMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = stored("changed", {});
    this.pendingPins = stored("pins", []);
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    this.preloadFrames = true;
    cx.timer.after(5000, (cx) => { this.preloadFrames = false; cx.notify(); });
    // In the back: the next frame. Coming to the front: back to the GIF once.
    cx.timer.every(GIF_TICK, (cx) => {
      const active = window().active;
      if (this.gifs > 0 && (!active || this.wasActive === false)) cx.notify();
      this.wasActive = active;
    });
    this.recaps = {};
    // Recaps already read (opened by a click on their row), so their dot stays gone.
    this.seenRecaps = stored("seenRecaps", {});
    this.recapAt = 0;
    this.refreshRecaps(cx);
    cx.timer.every(RECAP_EVERY, (cx) => this.refreshRecaps(cx));
    cx.timer.every(HOVER_POLL, (cx) => this.checkHover(cx));
    // Carried over a reload: starting empty would show every waiting agent as done.
    this.decisions = { ...(shared("agents.effective") ?? {}) };
    this.effectiveMap = { ...this.decisions };
    this.holds = {};
    this.decidedAt = 0;
    this.decideRunAt = 0;
    this.refreshDecisions(cx);
    cx.timer.every(DECIDE_EVERY, (cx) => {
      const waiting = Object.keys(this.holds).length > 0 || Object.keys(this.decisions).length > 0;
      if (waiting || Date.now() - this.decideRunAt >= DECIDE_IDLE_EVERY) this.refreshDecisions(cx, false);
    });
    this.macStatus = null;
    cx.timer.every(MAC_EVERY, (cx) => this.macAlerts(cx));
  }

  // macOS notifications instead of Herdr's own corner note: when an agent
  // finishes while you weren't looking (Herdr's "done"), or needs you and you
  // aren't on it, post one to Notification Center and close the note Herdr
  // just put in the window's corner.
  macAlerts(cx) {
    const nativeBefore = this.nativeStatus;
    const raw = agents();
    const { closing, released } = this.holdStops(cx, raw);
    this.look(raw);
    const list = this.effective(raw);
    const prev = this.macStatus;
    this.macStatus = Object.fromEntries(list.map((a) => [a.address, a.status]));
    if (!prev) return; // nothing to compare on the first look
    const win = window().active;
    let posted = closing;
    for (const a of list) {
      const was = prev[a.address];
      if (!was || was === a.status) continue;
      // A verdict changing under an agent that didn't move isn't the agent finishing.
      const moved = released.has(a.address) || nativeBefore?.[a.address] !== this.nativeStatus[a.address];
      const done = a.status === "done" && moved;
      const blocked = a.status === "blocked" && !(win && a.focused);
      if (!done && !blocked) continue;
      const status = done ? "Ready" : "Needs you", session = this.sessionTitle(a);
      // Another machine's folder can't be asked of git here: its name will do.
      const remote = a.address.includes("/");
      this.agentCwd(a).then(async (cwd) => {
        const repo = (remote ? null : await this.repoName(cwd)) ?? (cwd ? folderName(cwd) : a.space_name);
        this.macNotify(status, repo, session, a.address, a.program);
      });
      posted++;
    }
    if (posted) this.closeCornerNotes(posted, cx);
  }

  // Herdr's corner notes can't be turned off (and the shipped toast mod can't be
  // replaced: Herdr restores its own on start), and their ids aren't handed out,
  // but every overlay takes the next "o<n>": post one of our own to learn the
  // count, then close the newest ones before it. Only as many as the newest
  // overlays in a row are toasts: a menu opened in between stops it, so it
  // closes nothing rather than the menu.
  closeCornerNotes(n, cx) {
    const status = (bin) => exec(bin, ["status"], { timeout: 3000 });
    cx.spawn(async (cx) => {
      let left = n;
      for (let tries = 0; left > 0 && tries < TOAST_TRIES; tries++) {
        if (tries) await cx.sleep(TOAST_RETRY);
        const probe = notify({ title: "", timeout: 1 });
        closeOverlay(probe);
        const last = Number(String(probe).replace(/^o/, ""));
        if (!Number.isFinite(last)) return;
        let open = [];
        try {
          const r = await status("herdr-app").catch(() => status(`${home()}/.local/bin/herdr-app`));
          open = JSON.parse(r?.stdout ?? "{}").overlays ?? [];
        } catch { continue; }
        let toasts = 0;
        for (let i = open.length - 1; i >= 0 && open[i] === "toast"; i--) toasts++;
        const now = Math.min(left, toasts);
        for (let k = 1; k <= now; k++) closeOverlay(`o${last - k}`);
        left -= now;
      }
    });
  }

  // Where the agent itself runs: its process's folder (herdr-core knows it), which
  // can differ from the folder its pane's shell last reported; else the pane's.
  async agentCwd(a) {
    const paneCwd = panes().find((p) => p.pane === a.pane)?.cwd ?? null;
    try {
      const r = await hc(["get", a.address, "--json"]);
      return (r.code === 0 && JSON.parse(r.stdout)?.foreground?.cwd) || paneCwd;
    } catch { return paneCwd; }
  }

  // The repo a folder is in (a worktree: its main repo's name), or null outside one.
  async repoName(cwd) {
    if (!cwd) return null;
    try {
      const r = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 3000 });
      const common = r.code === 0 ? r.stdout.trim() : "";
      if (!common) return null;
      return common.endsWith("/.git") ? folderName(common.slice(0, -5)) : folderName(common).replace(/\.git$/, "");
    } catch { return null; }
  }

  // The session's name as the agents list shows it: a tab someone named, else
  // what the agent calls it (Claude Code's session title); never a bare number.
  // A tab name that is that title cut short ("herdr-layout 版面與…") gives way to
  // the whole title.
  sessionTitle(a) {
    const tab = spaces().flatMap((s) => s.tabs).find((t) => t.id === a.tab);
    const lead = leadPanes(panes()).get(a.tab);
    const live = clean(lead?.title) || clean(a.title);
    const name = tab ? title(tab, lead) : "";
    const cut = name.endsWith("…") && live.startsWith(name.slice(0, -1).trimEnd());
    if (name && !cut && !/^\d+$/.test(name)) return name;
    return live || a.tab_name || a.program?.name || "Agent";
  }

  // The agent's icon on a tile, as a PNG for the notification (made once per
  // program by notify_icon.py, kept in data/my-agents/notify-icons/); null without one.
  notifyIcon(program) {
    if (!program?.icon) return Promise.resolve(null);
    this.notifyIcons ??= {};
    const key = (program.key || "agent").replace(/[^\w.-]/g, "_");
    const out = `${appHome()}/data/my-agents/notify-icons/${key}.png`;
    return this.notifyIcons[key] ??= exec("python3", [`${appHome()}/mods/my-agents/notify_icon.py`,
      `${appHome()}/${program.icon}`, program.tile || "#1c1d21", program.color || "#ffffff", out])
      .then((r) => (r.code === 0 ? out : null), () => null)
      .then((path) => { if (!path) delete this.notifyIcons[key]; return path; });
  }

  // A macOS notification through terminal-notifier, three lines: the status, the
  // agent's repo (else its folder), the session; the agent's icon beside them. A click brings Herdr to the front
  // on that agent. One per agent: a newer one replaces it. Without terminal-notifier,
  // osascript (a click there opens Script Editor).
  macNotify(status, repo, session, address, program) {
    const sh = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
    const app = `${home()}/.local/bin/herdr-app`;
    const onClick = `${sh(app)} do agent.focus --terminal ${sh(address)} >/dev/null 2>&1 || herdr-app do agent.focus --terminal ${sh(address)} >/dev/null 2>&1`;
    // terminal-notifier reads a message starting with "[" specially: escape it.
    const message = (session || " ").replace(/^\[/, "\\[");
    this.notifyIcon(program).then((icon) => exec("terminal-notifier", ["-title", status,
      ...(repo ? ["-subtitle", repo] : []), "-message", message,
      "-group", `herdr-${address}`, "-activate", "dev.herdr.app", "-execute", onClick,
      ...(icon ? ["-contentImage", icon] : [])]))
      .then((r) => { if (r.code !== 0) throw new Error(r.stderr); })
      .catch(() => {
        const q = (x) => `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        exec("osascript", ["-e", `display notification ${q(session || " ")} with title ${q(status)}${repo ? ` subtitle ${q(repo)}` : ""}`]).catch(() => {});
      });
  }


  // What an agent's status is once the verdicts are in (the map publishEffective
  // builds, the one other mods read). Only a stopped agent changes.
  effective(list) {
    const over = this.effectiveMap;
    return list.map((a) => ((a.status === "done" || a.status === "idle") && over[a.address] ? { ...a, status: over[a.address] } : a));
  }

  // Starts holding agents that just stopped. Runs from render too: the redraw for the
  // stop comes before the next timer tick, and would show them done for a moment.
  catchStops(list) {
    const prev = this.nativeSeen;
    this.nativeSeen = Object.fromEntries(list.map((a) => [a.address, a.status]));
    if (!prev) return;
    const now = Date.now();
    let changed = false;
    for (const a of list) {
      if ((a.status !== "done" && a.status !== "idle") || prev[a.address] !== "working") continue;
      // Whatever was decided before this turn is about an older message.
      delete this.decisions[a.address];
      this.holds[a.address] = { at: now, done: a.status === "done" };
      changed = true;
    }
    // Asked from the next holdStops (render has no cx for it).
    if (changed) { this.askDecide = true; this.publishEffective(); }
  }

  // Holds agents that just stopped until a verdict that started after they stopped.
  // Returns the agents let go this time, and how many corner notes Herdr put up for
  // an agent that turned out to be waiting.
  holdStops(cx, list) {
    this.catchStops(list);
    const prev = this.nativeStatus;
    this.nativeStatus = Object.fromEntries(list.map((a) => [a.address, a.status]));
    const released = new Set();
    if (!prev) return { closing: 0, released };
    const now = Date.now();
    let closing = 0, changed = false;
    for (const a of list) {
      const hold = this.holds[a.address];
      if (!hold) continue;
      if (a.status !== "done" && a.status !== "idle") { delete this.holds[a.address]; changed = true; continue; }
      if (this.decidedAt <= hold.at && now - hold.at < DECIDE_HOLD) continue;
      delete this.holds[a.address];
      released.add(a.address);
      changed = true;
      if (hold.done && this.decisions[a.address] === "working") closing++;
    }
    if (changed) this.publishEffective();
    if (this.askDecide) { this.askDecide = false; this.refreshDecisions(cx); }
    return { closing, released };
  }

  // Looking at an agent doesn't change what it shows: one that was done or needed you
  // stays so until you leave it (Herdr turns done into idle the moment you look).
  // Only the agent itself moving shows at once: working, or done / needing you again.
  look(list) {
    const base = this.baseMap ?? {};
    const before = this.lastShown ?? {};
    this.lastShown = Object.fromEntries(list.map((a) => [a.address,
      (a.status === "done" || a.status === "idle") && base[a.address] ? base[a.address] : a.status]));
    const cur = list.find((a) => a.focused);
    let next = null;
    if (cur) {
      const now = this.lastShown[cur.address];
      // Arriving: what it showed just before the click; staying: what's kept.
      const kept = cur.address === this.visit?.address ? this.visit.status : before[cur.address];
      const status = now === "working" ? null
        : now === "blocked" || now === "done" ? now
        : kept === "blocked" || kept === "done" ? kept : null;
      next = { address: cur.address, status };
    }
    if (next?.address === this.visit?.address && next?.status === this.visit?.status) return;
    this.visit = next;
    this.publishEffective();
  }

  publishEffective() {
    let map = { ...this.decisions };
    for (const k of Object.keys(this.holds)) map[k] = "working";
    this.baseMap = map;
    const v = this.visit;
    if (v?.status && map[v.address] !== "working") map = { ...map, [v.address]: v.status };
    this.effectiveMap = map;
    const raw = JSON.stringify(map);
    if (raw === this.effectiveRaw) return;
    this.effectiveRaw = raw;
    setShared("agents.effective", map);
  }

  // again: run once more after a busy run (a new stop must get a verdict that
  // started after it); the timer's own calls don't need that.
  refreshDecisions(cx, again = true) {
    if (this.decideBusy) { if (again) this.decideAgain = true; return; }
    this.decideBusy = true;
    const started = (this.decideRunAt = Date.now());
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/my-agents/decide.py`], { timeout: 60000 });
        if (r.code === 0) {
          const next = {};
          for (const [k, v] of Object.entries(JSON.parse(r.stdout.trim() || "{}"))) if (v.status) next[k] = v.status;
          this.decisions = next;
          this.decidedAt = started;
          this.publishEffective();
          cx.notify();
        }
      } catch {} finally {
        this.decideBusy = false;
        if (this.decideAgain) { this.decideAgain = false; this.refreshDecisions(cx); }
      }
    });
  }

  // Only while an agent recap.py reads is alive, and less often in the background.
  refreshRecaps(cx) {
    if (this.recapBusy) return;
    const list = agents();
    if (!list.some(RECAPS)) {
      if (this.recapRaw && this.recapRaw !== "{}") { this.recapRaw = "{}"; this.recaps = {}; cx.notify(); }
      return;
    }
    if (!window()?.active && Date.now() - this.recapAt < RECAP_EVERY_AWAY) return;
    this.recapAt = Date.now();
    this.recapBusy = true;
    cx.spawn(async (cx) => {
      try {
        // opencode's replies cost recap.py an `hc ls` and more: only when one is open.
        const opencode = list.some((a) => /^opencode/.test(a.app ?? "") || a.program?.key === "opencode");
        const r = await exec("python3", [`${appHome()}/mods/my-agents/recap.py`, ...(opencode ? ["--opencode"] : [])]);
        const raw = r.code === 0 ? r.stdout.trim() || "{}" : null;
        if (raw !== null && raw !== this.recapRaw) {
          this.recapRaw = raw;
          this.recaps = JSON.parse(raw);
          // Forget what was read of recaps that are gone (a new message replaced them).
          const before = Object.keys(this.seenRecaps).length;
          for (const k of Object.keys(this.seenRecaps)) if (!this.recaps[k]?.text) delete this.seenRecaps[k];
          if (Object.keys(this.seenRecaps).length !== before) localStorage.setItem("seenRecaps", JSON.stringify(this.seenRecaps));
          cx.notify();
        }
      } catch {} finally {
        this.recapBusy = false;
      }
    });
  }

  // The recap to show for an agent: none once its row was clicked.
  recapOf(addr) {
    const r = this.recaps?.[addr];
    return r?.text && this.seenRecaps?.[addr] !== `${r.at}|${r.text}` ? r : null;
  }

  // Clicking a row goes to the agent, where the recap is on screen anyway.
  seeRecap(addr) {
    const r = this.recaps?.[addr];
    if (this.recapOpen === addr) this.recapOpen = null;
    if (!r?.text || this.seenRecaps[addr] === `${r.at}|${r.text}`) return;
    this.seenRecaps[addr] = `${r.at}|${r.text}`;
    localStorage.setItem("seenRecaps", JSON.stringify(this.seenRecaps));
  }

  // A small white dot on the icon's top right: this agent has a recap. A ring
  // in the row's own color around it cuts it out of the icon.
  recapDot(t, a) {
    const ring = this.hovered === a.address ? t.hover : a.focused ? t.selected : t.chrome;
    return div().absolute().top(-2.5).right(-3.5).p(1.5).rounded_full().bg(ring)
      .when(!this.recapOf(a.address), (el) => el.opacity(0))
      .child(div().size(4.5).rounded_full().bg(t.foreground));
  }

  // The first row: a new tab (a terminal or an agent), as the tab bar's + did.
  newRow(t, collapsed) {
    const small = collapsed && mini();
    const dx = small ? (sidebarW() - 16 - 18) / 2 - 8 : 0;
    const size = collapsed ? 18 : 16;
    return div().py(ROW_GAP / 2).child(h_flex()
      .id("ag-new")
      .h(30)
      .px(8)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(collapsed ? 6 : 9)
      .text_color(t.muted)
      .when(!small, (el) => el.overflow_hidden().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .when(small, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_hover((on, cx) => { this.hoverNew = on; cx.notify(); })
      // Opens beside the sidebar, its top level with this row, never over the sidebar.
      .on_mouse_down("left", (e) => { this.newAt = e.position.y; })
      .on_click(() => {
        const z = settings().zoom || 1;
        openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512,
          at: { x: (sidebarW() + POP_GAP) * z, y: Math.max(0, (this.newAt ?? 0) - POP_LIFT * z) } });
      })
      .child(div().id("ag-new-icon").flex_none().relative().left(dx).transition("left", SLIDE)
        .size(size).flex().items_center().justify_center()
        .when(small, (el) => el.child(railSquare(t, 30, false, Boolean(this.hoverNew))))
        .child(svg("mods/workspace-chrome/plus.svg").size(collapsed ? 16 : 15)))
      .child(div().id("ag-new-label").flex_1().min_w(0).truncate()
        .opacity(small ? 0 : 1).transition("opacity", FADE)
        .when(!collapsed || named(), (el) => el.child("New tab"))));
  }

  // Hovering a row (a moment's rest) opens its recap to the right of the sidebar.
  // Remembers what the pointer is on; also re-enters if a lost exit left GPUI thinking it never left.
  trackHover(a, e, cx) {
    this.hoverBox = e.bounds;
    if (this.hovered !== a.address) this.hoverRecap(a, true, cx);
  }

  checkHover(cx) {
    const b = this.hoverBox;
    if (!this.hovered || !b) return;
    const p = globalThis.window.mouse_position();
    if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return;
    this.hoverRecap({ address: this.hovered }, false, cx);
  }

  hoverRecap(a, on, cx) {
    if (!on) this.hoverBox = null;
    if (on) {
      this.hovered = a.address;
      if (this.recapOf(a.address) || this.recaps?.[a.address]?.last || narrow()) cx.timer.after(RECAP_DELAY, (cx) => {
        if (this.hovered === a.address && this.recapOpen !== a.address && this.menuFor !== a.address) { this.recapOpen = a.address; cx.notify(); }
      });
    } else {
      if (this.hovered === a.address) this.hovered = null;
      if (this.recapOpen === a.address) this.recapOpen = null;
      // The row menu's pointer left the row: hovering it again may show the card.
      if (this.menuFor === a.address) this.menuFor = null;
    }
    cx.notify();
  }

  // The card names the session on top (the rail shows no names), then the recap, or
  // without one the start of the agent's last reply (recap.py cuts it to five lines).
  withRecap(t, a, rowEl, name, where) {
    const recap = this.recapOf(a.address);
    const last = recap ? null : this.recaps?.[a.address]?.last;
    const r = recap ?? last;
    const open = (Boolean(r) || narrow()) && this.recapOpen === a.address && this.menuFor !== a.address;
    const head = div().w_full().text_size(12.5).font_semibold().text_color(t.foreground).whitespace_normal().child(name ?? "");
    // The folder on its own line, quieter than the title.
    const sub = () => div().w_full().text_size(10).text_color(t.muted).whitespace_normal().child(where ?? "");
    // Anchored to a point at the row's top right: the card's top left goes there,
    // then past the list's 8 px inset and the gap, and lifted a little.
    return rowEl.relative().child(Popup.new(`recap-${a.address}`, div().w(1).h(1)).absolute().top(0).right(0).w(1).h(1).anchor("top_left")
      .when(open && !r, (el) => el.content(div().pl(8 + POP_GAP).mt(-POP_LIFT).child(v_flex().max_w(RECAP_W).px(10).py(7).gap(2).rounded(8).bg(t.popover).border(1).border_color(t.border).shadow_lg()
        .child(div().text_size(12.5).text_color(t.foreground).whitespace_normal().child(name ?? ""))
        .when(Boolean(where), (el) => el.child(sub())))))
      .when(open && Boolean(r), (el) => el.content(div().pl(8 + POP_GAP).mt(-POP_LIFT).child(v_flex().w(RECAP_W).p(12).gap(6).rounded(10).bg(t.popover).border(1).border_color(t.border).shadow_lg()
        .when(Boolean(name) || Boolean(where), (el) => el.child(v_flex().w_full().gap(2)
          .when(Boolean(name), (el) => el.child(head))
          .when(Boolean(where), (el) => el.child(sub()))))
        // A small pill naming the text, then the text under it. Last reply: at most
        // five lines, should recap.py's guess of the width be short.
        .child(h_flex().child(h_flex().flex_none().h(14).px(5).gap(3).items_center().rounded_full().bg(t.hover)
          .text_size(9.5).font_semibold().text_color(t.muted)
          // One icon for every recap, whichever agent wrote it.
          .child(svg(`mods/my-agents/${recap ? "recap" : "reply"}.svg`).size(9).flex_none().text_color(t.muted))
          .child(recap ? "Recap" : "Last reply")))
        .child(div().w_full().mt(-2).text_size(12.5).line_height(1.5).text_color(t.foreground).whitespace_normal()
          .when(!recap, (el) => el.max_h(CARD_LINE_H * 5).overflow_hidden())
          .child(r?.text ?? ""))))));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // A looked-at agent keeps its status until you leave it (look), so its place too.
  rank(a) {
    return RANK[a.status] ?? 0;
  }

  // Rows that jumped to a new place since the last draw are drawn once where they
  // were, then slide to where they are (MOVE). items: [key, height, eases] in list
  // order. A height that eases on its own (a slot opening, a rail title folding)
  // counts as it was, so what it pushes glides with it and isn't slid twice.
  moves(items, cx) {
    const prev = this.lay;
    this.lay = { y: new Map(), h: new Map() };
    let at = 0, was = 0;
    const offsets = {};
    for (const [key, h, eases] of items) {
      this.lay.y.set(key, at);
      this.lay.h.set(key, h);
      at += h;
      if (!prev?.y.has(key)) { was += h; continue; }
      const off = prev.y.get(key) - was;
      if (Math.abs(off) > 0.5) offsets[key] = off;
      was += eases ? prev.h.get(key) : h;
    }
    if (!Object.keys(offsets).length) return;
    const flip = (this.flip = { offsets, slide: false });
    cx.timer.after(16, (cx) => {
      if (this.flip !== flip) return;
      flip.slide = true;
      cx.notify();
      cx.timer.after(MOVE.duration + 50, () => { if (this.flip === flip) this.flip = null; });
    });
  }

  // A row's element, drawn where moves() says; it slides back to its place. The
  // jump is a zero-length transition, not none: without one the element wouldn't
  // remember where it was drawn, and the slide would have nowhere to start from.
  moved(key, el) {
    const f = this.flip;
    const jump = f && !f.slide;
    return el.relative().top(jump ? f.offsets[key] ?? 0 : 0).transition("top", jump ? { duration: 0 } : MOVE);
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // Right-click on a row: archive / unarchive, pin / unpin. A by-hand choice lasts
  // until the agent's state next changes (then 6 hours idle archives it again).
  agentMenu(t) {
    const m = props().agentMenu;
    const item = (id, icon, label, act) => h_flex().id(id).h(31).px(8).gap(9).rounded(7).items_center()
      .text_color(t.foreground).hover((el) => el.bg(t.hover))
      .on_click(() => { act(); closeOverlay(props().overlay); })
      .child(svg(`mods/${icon}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().child(label));
    const setArchived = (on) => {
      const marks = { ...(shared("agents.archived") ?? {}) };
      marks[m.address] = { on, at: Date.now() };
      setShared("agents.archived", marks);
    };
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(m.archived
        ? item("am-unarchive", "my-chrome/archive", "Unarchive", () => setArchived(false))
        : item("am-archive", "my-chrome/archive", "Archive", () => { if (m.pinned) run("terminal.pin", { terminal: m.address, pinned: false }); setArchived(true); }))
      .child(item("am-pin", `workspace-chrome/${m.pinned ? "pin-off" : "pin"}`, m.pinned ? "Unpin" : "Pin to the top", () => {
        run("terminal.pin", { terminal: m.address, pinned: !m.pinned });
        if (!m.pinned && m.archived) setArchived(false);
      }))
      // Closes its pane (the tab too when it's the only one), as the tab's own Close does;
      // one without a pane (sent back) is ended. Asks first, in Herdr's confirm dialog.
      .child(div().h(1).mx(6).my(4).bg(t.border))
      .child(item("am-close", "workspace-chrome/x", "Close", () => openOverlay({
        mod: "my-confirm", kind: "dialog", width: 380, height: 170,
        props: {
          title: "Close agent?",
          danger: true,
          detail: `${m.name ? `"${m.name}"` : "This agent"} will end${m.pane ? ", and its pane closes" : ""}.`,
          command: m.pane ? { name: "pane.close", args: { pane: m.pane } } : { name: "terminal.kill", args: { terminal: m.address } },
        },
      })));
  }

  // Opens the row menu where the hover card goes: just right of the sidebar, its top
  // at the row's top, lifted the same POP_LIFT (as the + menu). It takes the card's place.
  rowMenu(a, archived) {
    return (e, cx) => {
      cx.stop_propagation();
      this.menuFor = a.address; this.recapOpen = null; cx.notify();
      const z = settings().zoom || 1, top = e.bounds?.y ?? e.position.y;
      openOverlay({ mod: "my-agents", kind: "popup", width: 190, height: 122,
        at: { x: (sidebarW() + POP_GAP) * z, y: Math.max(0, top - POP_LIFT * z) },
        props: { agentMenu: { address: a.address, archived, pinned: a.pinned, pane: a.pane ?? null, name: this.sessionTitle(a) } } });
    };
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  // kidsOf: parent address -> its live sub-agents, built once per render.
  tree(kidsOf, addr, lead = []) {
    const kids = kidsOf.get(addr) ?? [];
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(kidsOf, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(alpha(t.blocked, "26")).text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(alpha(t.blocked, "26")).text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : alpha(t.dim, "00"));
  }

  // Which Clawd (or null: the icon) to draw for an agent, and its opacity. On a
  // change the old one stays while it fades out, then the new one fades in.
  picFade(a, cx) {
    this.pics ??= new Map();
    const want = clawdOf(a);
    let st = this.pics.get(a.address);
    if (!st) this.pics.set(a.address, (st = { gif: want, op: 1 }));
    st.next = want;
    // op 0: a fade is under way, and picks up st.next when it's done.
    if (st.gif !== want && st.op !== 0) {
      st.op = 0;
      cx.timer.after(PIC_FADE.duration, (cx) => {
        st.gif = st.next;
        cx.notify();
        cx.timer.after(30, (cx) => { st.op = 1; cx.notify(); });
      });
    }
    return st;
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.agentMenu) return this.agentMenu(t);
    this.gifs = 0; // Clawds drawn this time, counted by row()
    const collapsed = narrow();
    const sort = sortOf();
    const raw = agents();
    this.catchStops(raw);
    this.look(raw);
    let list = this.effective(raw);
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    // Fades of agents that are gone.
    if (this.pics) for (const k of this.pics.keys()) if (!this.listed.has(k)) this.pics.delete(k);
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    const byPriority = sort.id === "priority";
    const kidsOf = new Map();
    for (const k of all) if (k.parent && k.state === "live") kidsOf.set(k.parent, [...(kidsOf.get(k.parent) ?? []), k]);
    const subsOf = new Map(list.map((a) => [a.address, this.tree(kidsOf, a.address)]));
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...subsOf.get(a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    // Archived: by hand (until the state next changes), or idle 6 hours. Pinned never.
    const marks = shared("agents.archived") ?? {};
    const isArchived = (a) => {
      if (a.pinned) return false;
      const m = marks[a.address];
      if (m && this.since(a) <= m.at) return m.on;
      return !a.focused && a.status === "idle" && now - this.since(a) >= ARCHIVE_AFTER;
    };
    const archivedSet = new Set(list.filter(isArchived).map((a) => a.address));
    // Not archived, in list order (pinned ones among them).
    const live = list.filter((a) => !archivedSet.has(a.address));
    const pinned = live.filter((a) => a.pinned);
    const old = list.filter((a) => archivedSet.has(a.address));
    list = [...pinned, ...live.filter((a) => !a.pinned), ...old];
    if (list.length && Object.keys(marks).some((k) => !this.listed.has(k))) {
      setShared("agents.archived", Object.fromEntries(Object.entries(marks).filter(([k]) => this.listed.has(k))));
    }
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : subsOf.get(a.address);
      // Full rows get the rail rows' half gap too: crossing the rail's edge moves nothing.
      const r = collapsed ? row(a, i, subs) : div().py(ROW_GAP / 2).child(row(a, i, subs));
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabLabels = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, title(tab, leads.get(tab.id))]));
    const labels = new Map(list.map(a => [a.address, tabLabels.get(a.tab) ?? (a.title || a.program?.name || "")]));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    // Where the session is working, for the rail's hover title: its folder, home as ~.
    const folders = new Map(all.map((x) => [x.address, x.cwd]));
    const place = (a) => {
      const p = folders.get(a.address);
      if (!p) return null;
      return !a.address.includes("/") && (p === home() || p.startsWith(`${home()}/`)) ? `~${p.slice(home().length)}` : p;
    };

    const row = (a, i, subs = []) => {
      const { gif, op } = this.picFade(a, cx);
      if (gif) this.gifs++;
      const pic = gif ? clawdPic(gif, 16) : icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      // A rail row: same height as a full row, the icon on the left, the status on
      // the right, and the name between them when there's room.
      // A rail row (narrow sidebar): icon, name, status. On the mini rail the icon
      // glides to the middle, name and status fade out, and the icon itself shows
      // the status (blocked hops, working pulses, idle fades).
      if (collapsed) {
        const small = mini();
        const short = more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
        // Clawd shows the status itself: no hop, pulse or fade on top.
        const hop = small && a.status === "blocked" && !gif;
        const pulse = small && a.status === "working" && !gif;
        const dx = small ? (sidebarW() - 16 - 18) / 2 - 8 : 0;
        // Each row carries half the gap above and below: the same space between
        // rows everywhere, even across folded titles, and above the first one.
        const full = more || label(a) || a.program?.name || "";
        return div().py(ROW_GAP / 2).child(this.withRecap(t, a, h_flex()
          .id(`ag-${a.address}`)
          .on_mouse_down("right", this.rowMenu(a, archivedSet.has(a.address)))
          .h(30)
          .px(8)
          .flex_none()
          .rounded(8)
          .items_center()
          .gap(6)
          // On the mini rail the row is wider than tall: its look goes on a square
          // around the icon instead, which glides with it.
          .when(!small, (el) => el.overflow_hidden().when(a.focused, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_hover((on, cx) => this.hoverRecap(a, on, cx)).on_mouse_move((e, cx) => this.trackHover(a, e, cx)))
          .on_click((_e, cx) => { this.seeRecap(a.address); run("pane.focus", { pane: a.pane }); cx.notify(); })
          .child(div().id(`ag-icon-${a.address}`).flex_none().relative().left(dx).transition("left", SLIDE)
            // Only the square you can see opens the card, not the rest of the rail's width.
            .when(small, (el) => el.child(railSquare(t, 30, a.focused, this.hovered === a.address)
              .id(`ag-sq-${a.address}`).on_hover((on, cx) => this.hoverRecap(a, on, cx)).on_mouse_move((e, cx) => this.trackHover(a, e, cx))))
            .child(div().id(`ag-pic-${a.address}`).opacity(op === 0 ? 0 : small && a.status === "idle" ? IDLE_OPACITY : 1).transition("opacity", op === 1 ? FADE : PIC_FADE)
              .when(pulse, (el) => el.loop("opacity", PULSE))
              .child(div().when(hop, (el) => el.relative().loop("top", BOUNCE))
                .child(gif ? clawdPic(gif, 18) : Boolean(pic) ? icon(a.program, 18, t.foreground) : div().size(18))))
            .child(this.recapDot(t, a)))
          .child(div().id(`ag-name-${a.address}`).flex_1().min_w(0).truncate().text_color(a.status === "idle" && !a.focused ? t.muted : t.foreground)
            .opacity(small ? 0 : 1).transition("opacity", FADE)
            .when(named(), (el) => el.child(short)))
          .child(h_flex().id(`ag-st-${a.address}`).w(16).flex_none().items_center().justify_center()
            .opacity(small ? 0 : 1).transition("opacity", FADE).child(this.status(t, a, true))), full, place(a)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      // The icon is the status (no spinner, dot or tag at the row's end): Clawd shows
      // it itself; other icons hop when blocked and pulse while working, as on the rail.
      const hop = a.status === "blocked" && !gif;
      const pulse = a.status === "working" && !gif;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // A row never names its space, header above or not; an automatic tab number says nothing.
      const name = more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return this.withRecap(t, a, h_flex()
        .id(`ag-${a.address}`)
        .on_mouse_down("right", this.rowMenu(a, archivedSet.has(a.address)))
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => this.hoverRecap(a, on, cx))
        .on_mouse_move((e, cx) => this.trackHover(a, e, cx))
        .on_click((_e, cx) => { this.seeRecap(a.address); run("pane.focus", { pane: a.pane }); cx.notify(); })
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).relative().child(div().id(`ag-picf-${a.address}`).opacity(op).transition("opacity", PIC_FADE)
            .child(div().when(pulse, (el) => el.loop("opacity", PULSE))
              .child(div().when(hop, (el) => el.relative().loop("top", BOUNCE)).child(pic))))
          .child(this.recapDot(t, a))))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(200).truncate().text_color(idle ? t.muted : t.foreground).child(name)))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when)))), name);
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    // Pinned agents keep a closed slot in their group (all), so pinning one slides
    // it shut there while its slot in the pinned area at the top slides open.
    const groups = [];
    for (const a of live) {
      const r = a.pinned ? (this.rank(a) || RANK.idle) : rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id !== id) groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [], all: [] });
      groups.at(-1).all.push(a);
      if (!a.pinned) groups.at(-1).members.push(a);
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().min_w(0).truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        // On the rail the title gets the room; the count goes.
        .when(!collapsed && (byPriority || !open), (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    // On the rail a title folds away (height to 0, fading) for the mini rail
    // rather than vanishing, so the rows below glide up.
    // folded: what's left of it on the mini rail (a row's half gap; the title
    // keeps enough that the first square is RAIL_EDGE below the section's edge).
    const foldAway = (key, h, el, folded = ROW_GAP / 2) => collapsed
      ? div().id(key).flex_none().h(mini() ? folded : h).overflow_hidden().opacity(mini() ? 0 : 1)
        .transition("height", SLIDE).transition("opacity", FADE).child(el)
      : el;
    // The mini rail has no titles: every agent, in the same order, folded groups too.
    // A slot is a row's place that slides between 0 and its height. keep: its rows
    // stay while it shuts (else they go at once and only the space slides).
    const slotH = (a, open) => (open ? ROW_H + (collapsed || this.folded.has(a.address) ? 0 : subsOf.get(a.address).length * SUB_H) : 0);
    const titleH = collapsed && mini() ? ROW_GAP / 2 : 30;
    const shownIn = (g) => !this.folded.has(g.id) || (collapsed && mini());
    // The list from the top, for moves(): the pinned area, then each group.
    this.moves([
      ...live.map((a) => [`ps-${a.address}`, slotH(a, a.pinned), true]),
      ["pin-line", pinned.length ? 14 : 0, true],
      ...groups.flatMap((g) => [...(g.members.length ? [[`agh-${g.id}`, titleH, collapsed]] : []),
        ...(shownIn(g) ? g.all.map((a) => [`gs-${a.address}`, slotH(a, !a.pinned), true]) : [])]),
    ], cx);
    const slot = (id, open, a, keep = false) => {
      const parts = open || keep ? withKids(a) : [];
      // The clip reaches the list's edges (-8/+8): the mini rail's square is wider than its row.
      return this.moved(id, div().id(id).flex_none().mx(-8).px(8).overflow_hidden().h(slotH(a, open)).opacity(open ? 1 : 0)
        .transition("height", SLIDE).transition("opacity", FADE).children(parts));
    };
    const rows = groups.flatMap((g) => [...(g.members.length ? [this.moved(`agh-${g.id}`, foldAway(`agh-${g.id}`, 30, header(g)))] : []),
      ...(shownIn(g) ? g.all.map((a) => slot(`gs-${a.address}`, !a.pinned, a)) : [])]);
    const pinInk = settings().dark === false ? t.foreground : "#ffffff";
    // The pinned area: at the top, a line under it. The + row ends the list (above Archived).
    const pinRows = [...live.map((a) => slot(`ps-${a.address}`, a.pinned, a)),
      // The line under it, with a small solid pin in its middle (white, see-through).
      this.moved("pin-line", div().id("pin-line")).flex_none().mx(-8).px(collapsed && mini() ? 9 : 20).overflow_hidden().h(pinned.length ? 14 : 0).transition("height", SLIDE)
        // Line and pin share one color; on the mini rail the line reaches into the list's padding.
        .child(h_flex().h(14).gap(1).items_center().opacity(0.2)
          .child(div().flex_1().h(1).rounded_full().bg(pinInk))
          .child(svg("mods/my-agents/pin-solid.svg").size(7).flex_none().text_color(pinInk))
          .child(div().flex_1().h(1).rounded_full().bg(pinInk)))];

    const archive = { id: "archived", label: "Archived", status: null, members: old };
    const byAge = [...old].sort((x, y) => this.since(x) - this.since(y));
    const older = byAge.slice(0, Math.max(0, byAge.length - ARCHIVE_SHOWN)), newest = byAge.slice(older.length);
    const more = this.archiveMore && older.length > 0;
    // Older ones slide open and shut (the section, sitting on the bottom, grows
    // upward); shut, they're only built while the slide is still going.
    const shutting = Date.now() - (this.archiveAt ?? 0) < SLIDE.duration + 50;
    const slide = (a) => slot(`arc-${a.address}`, more, a, shutting);
    const small = collapsed && mini();
    const moreButton = h_flex().id("arc-more").h(26).mb(2).px(8).flex_none().gap(6).items_center().rounded(7)
      .when(small, (el) => el.justify_center().px(0))
      .text_size(11).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.archiveMore = !this.archiveMore; this.archiveAt = Date.now(); cx.notify(); })
      .child(svg(more ? "mods/workspace-chrome/chevron-down.svg" : "mods/my-agents/chevron-up.svg").size(11).flex_none())
      .when(!small, (el) => el.child(more ? "Show less" : `${older.length} more`))
      .when(small && !more, (el) => el.child(String(older.length)));
    const archiveRows = old.length ? [foldAway("agh-archived", 30, header(archive)),
      ...(this.folded.has("archived") && !small ? [] : [
        ...older.map(slide),
        ...(older.length ? [moreButton] : []),
        ...newest.flatMap(withKids)])] : [];

    return track(v_flex().id("agents-root"))
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      // The title stays on the rail; its sort button doesn't. The mini rail folds it away.
      .child(foldAway("ag-title", 41, 
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .when(!collapsed, (el) => el.child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "my-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            )),
        RAIL_EDGE - ROW_GAP / 2))
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().mode("always").children(pinRows).children(rows).child(this.newRow(t, collapsed))
        // Archived sits at the bottom: a spacer takes what the list leaves.
        .when(archiveRows.length > 0, (el) => el.child(div().flex_1().min_h(8)).children(archiveRows).child(div().h(6).flex_none())))
      // Load every Clawd frame once, unseen, so the first time they're needed none is blank.
      .when(this.preloadFrames, (el) => el.child(div().absolute().top(0).left(0).size(1).opacity(0).overflow_hidden()
        .children(Object.entries(CLAWD).flatMap(([name, c]) => Array.from({ length: c.frames },
          (_, i) => image(`mods/my-agents/clawd-${name}/${pad2(i)}.png`).size(1))))));
  }
}

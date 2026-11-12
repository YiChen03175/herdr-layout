// The side panel's GitLab tab (layouts/my-main.json's panel-body stack, the tab bar's
// GitLab button): my merge requests through `glab`, in three lists:
//   Open        MRs I opened that aren't merged or closed
//   Merged      MRs I opened that were merged in the last MERGED_DAYS days
//   To review   open MRs where I'm a requested reviewer and haven't reviewed yet
// Click a row to open it in the browser; right-click an Open one for a menu that
// can close it (after a confirm dialog). The tab bar's button lights up with a count
// of what's new (shared "my-gitlab.new", see publishNews).
//
// The menu and the dialog are this same mod as overlays, with props { menu: mr }
// or { closeMr: mr }; a close bumps shared "my-gitlab.changed" so the panel reloads.
// While one is closing, shared "my-gitlab.closing" holds { webUrl: since }: the
// panel's row spins until the reload no longer lists it.
//
// A third copy, props { headless: true } in a 0 px block of the layout, starts with
// the window: it keeps the tab bar's count current while the panel isn't showing
// (a panel copy only starts the first time its tab shows).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, layout, shared, setShared, props, openOverlay, closeOverlay } from "herdr";

const ICON = (name) => `mods/my-gitlab/${name}.svg`;
const MERGED_DAYS = 7;
// Refreshed this often while the panel shows (by the panel), and every 5 minutes
// while it's folded away (by the headless copy, for the tab bar's review count).
const POLL_SHOWN = 120000;
const POLL_HIDDEN = 300000;
// A close whose dialog went away mid-way (Esc) never says it's done: a mark this
// old makes the copy in charge reload, which drops it if the MR is gone.
const CLOSING_CHECK = 15000;
// A row still marked closing after this long goes back to normal.
const CLOSING_MAX = 60000;
const isClosing = (url) => Date.now() - (closingNowSafe()[url] ?? 0) < CLOSING_MAX;
function closingNowSafe() { return shared("my-gitlab.closing") ?? {}; }
function setClosing(url, on) {
  const next = { ...closingNowSafe() };
  if (on) next[url] = Date.now(); else delete next[url];
  setShared("my-gitlab.closing", next);
}
// Opening the panel refreshes it when what it shows is older than this.
const STALE_ON_OPEN = 30000;
const VISIBLE_EVERY = 1000;

// News: a review asked of me, or one of my open MRs approved, that I haven't seen in
// this panel yet. shared "my-gitlab.seen" keeps the ones seen (only while they're
// still listed: one that comes back is news again), "my-gitlab.new" how many aren't.
// look: the panel is showing, so everything listed counts as seen.
const approved = (mr) => (mr.approvalsLeft ?? 0) === 0 && (mr.approvedBy?.nodes?.length ?? 0) > 0;
function publishNews(lists, look) {
  const now = [...lists.review.map((mr) => `review ${mr.webUrl}`), ...lists.open.filter(approved).map((mr) => `approved ${mr.webUrl}`)];
  const before = shared("my-gitlab.seen");
  // The first time, what's already there isn't news.
  const seen = look || !Array.isArray(before) ? now : before.filter((k) => now.includes(k));
  if (JSON.stringify(seen) !== JSON.stringify(before)) setShared("my-gitlab.seen", seen);
  const fresh = now.filter((k) => !seen.includes(k)).length;
  if (shared("my-gitlab.new") !== fresh) setShared("my-gitlab.new", fresh);
}

const QUERY = `query($mergedAfter: Time) {
  currentUser {
    username
    open: authoredMergeRequests(state: opened, sort: UPDATED_DESC, first: 50) {
      nodes {
        iid title webUrl draft updatedAt detailedMergeStatus conflicts
        approvalsLeft approvedBy { nodes { username } }
        project { name fullPath namespace { fullName } }
        headPipeline { status }
      }
    }
    merged: authoredMergeRequests(state: merged, mergedAfter: $mergedAfter, sort: MERGED_AT_DESC, first: 50) {
      nodes { iid title webUrl mergedAt project { name namespace { fullName } } }
    }
    review: reviewRequestedMergeRequests(state: opened, reviewStates: [UNREVIEWED, REVIEW_STARTED], sort: UPDATED_DESC, first: 50) {
      nodes {
        iid title webUrl draft updatedAt detailedMergeStatus conflicts
        author { username name }
        project { name namespace { fullName } }
        headPipeline { status }
      }
    }
  }
}`;

const CLOSE_MR = `mutation($projectPath: ID!, $iid: String!) {
  mergeRequestUpdate(input: { projectPath: $projectPath, iid: $iid, state: CLOSED }) {
    errors
    mergeRequest { state }
  }
}`;

const NO_GLAB = "找不到 glab：brew install glab，然後 glab auth login。";

// Runs a GitLab GraphQL request through glab; resolves with its data, or throws
// GitLab's or glab's message (NO_GLAB when glab can't be started at all).
async function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  let r;
  try { r = await exec("glab", args, { timeout: 30000 }); } catch (e) {
    const msg = String(e?.message ?? e);
    throw new Error(/time/i.test(msg) ? "GitLab didn't answer in time." : NO_GLAB);
  }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `glab exited ${r.code}`);
  const body = JSON.parse(r.stdout);
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// This panel is on screen: the panel column shown, with this tab picked.
function visible() {
  const root = layout();
  return !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "gitlab";
}

function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!(m >= 1)) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Pipeline status -> [glyph, theme color name].
function pipeline(p) {
  switch (p?.status) {
    case "SUCCESS": return ["✓", "ansi2"];
    case "FAILED": return ["✗", "ansi1"];
    case "RUNNING": case "PENDING": case "PREPARING": case "WAITING_FOR_RESOURCE": case "CREATED": return ["●", "ansi4"];
    case "MANUAL": case "SCHEDULED": return ["◐", "ansi3"];
    case "CANCELED": case "SKIPPED": return ["⊘", "dim"];
    default: return ["○", "dim"];
  }
}

// A conflict takes the row's status icon (in place of the pipeline's).
const conflicted = (mr) => mr.conflicts || mr.detailedMergeStatus === "CONFLICT" || mr.detailedMergeStatus === "BROKEN_STATUS";

// GitLab's merge verdict -> [label, theme color name], or null when it says
// nothing new (UNCHECKED: GitLab only works it out when someone opens the MR).
// Conflicts show on the status icon instead (conflicted()).
function verdict(mr) {
  switch (mr.detailedMergeStatus) {
    case "NEED_REBASE": return ["Needs rebase", "ansi3"];
    case "DISCUSSIONS_NOT_RESOLVED": return ["Open threads", "ansi3"];
    case "CI_MUST_PASS": return ["CI must pass", "ansi1"];
    case "CI_STILL_RUNNING": return ["CI running", "ansi4"];
    case "REQUESTED_CHANGES": return ["Changes requested", "ansi1"];
    case "BLOCKED_STATUS": return ["Blocked", "ansi1"];
    default: return null;
  }
}

export default class Gitlab extends View {
  init(_props, cx) {
    // The right-click menu and the close dialog: overlays of this mod, no polling.
    if (props()?.menu) return;
    if (props()?.closeMr) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.closing = false;
      this.closeError = null;
      return;
    }
    this.headless = Boolean(props()?.headless);
    this.lists = null; // { open, merged, review }
    this.error = null;
    this.loading = false;
    this.fetchedAt = 0; // last successful load
    this.triedAt = 0;   // last attempt, successful or not: spaces the polls
    this.folded = new Set(["merged"]); // Open and Merged fold (Merged starts folded); To review doesn't
    this.shown = visible();
    // The panel copy is in charge while the panel shows, the headless one otherwise.
    const inCharge = () => this.headless ? !this.shown : this.shown;
    if (inCharge() || !this.headless) this.refresh(cx);
    this.changeSeen = shared("my-gitlab.changed");
    cx.timer.every(VISIBLE_EVERY, (cx) => {
      const shown = visible(), opened = shown && !this.shown;
      this.shown = shown;
      if (!inCharge()) return;
      // Opening the panel is looking at what's new (the reload below adds anything newer).
      if (opened && this.lists) publishNews(this.lists, true);
      const now = Date.now();
      // A merge request was closed from the dialog: reload now.
      if (shared("my-gitlab.changed") !== this.changeSeen) {
        this.changeSeen = shared("my-gitlab.changed");
        this.refresh(cx, true);
        return;
      }
      const lostClose = Object.values(closingNowSafe()).some((at) => now - at > CLOSING_CHECK) && now - this.triedAt > CLOSING_CHECK;
      if (opened && now - this.fetchedAt > STALE_ON_OPEN) this.refresh(cx);
      else if (lostClose || now - this.triedAt > (this.headless ? POLL_HIDDEN : POLL_SHOWN)) this.refresh(cx);
    });
    // Keeps the "3m" labels honest without a fetch, only while they show.
    if (!this.headless) cx.timer.every(60000, (cx) => { if (this.shown) cx.notify(); });
  }

  // again: a reload that must not be lost to one already under way.
  refresh(cx, again = false) {
    if (this.loading) { if (again) this.reloadAfter = true; return; }
    this.loading = true;
    this.triedAt = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const after = new Date(Date.now() - MERGED_DAYS * 86400000).toISOString();
        const me = (await graphql(QUERY, { mergedAfter: after })).currentUser;
        this.lists = { open: me.open.nodes, merged: me.merged.nodes, review: me.review.nodes };
        // The panel's title: the organization most of these MRs are in (its top-level group).
        const orgs = {};
        for (const mr of [...me.open.nodes, ...me.merged.nodes, ...me.review.nodes]) {
          const org = mr.project?.namespace?.fullName?.split(" / ")[0];
          if (org) orgs[org] = (orgs[org] ?? 0) + 1;
        }
        this.org = Object.entries(orgs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.org;
        publishNews(this.lists, visible());
        // Closed ones are gone from the list now: their marks go too (and any left too long).
        const marks = closingNowSafe(), listed = new Set(this.lists.open.map((mr) => mr.webUrl));
        const kept = Object.fromEntries(Object.entries(marks).filter(([url, at]) => listed.has(url) && Date.now() - at < CLOSING_MAX));
        if (Object.keys(kept).length !== Object.keys(marks).length) setShared("my-gitlab.closing", kept);
        this.error = null;
        this.fetchedAt = Date.now();
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.reloadAfter) { this.reloadAfter = false; this.refresh(cx); }
      }
    });
  }

  // The row's right-click menu (an overlay of this mod: props { menu: mr }).
  menu(t, mr) {
    const item = (id, icon, label, color, action) => h_flex().id(id).h(30).px(8).gap(9).rounded(6).items_center()
      .cursor_pointer().text_color(color).hover((s) => s.bg(t.hover))
      .on_click(action)
      .child(svg(ICON(icon)).size(14).flex_none())
      .child(div().flex_1().child(label));
    const me = props().overlay;
    return v_flex().w_full().p(5).gap(1).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(3).pb(5).text_size(11).text_color(t.dim).truncate().child(`${mr.project.name} !${mr.iid}`))
      .child(item("gl-menu-open", "external-link", "Open in browser", t.foreground, () => { closeOverlay(me); this.browse(mr.webUrl); }))
      .child(item("gl-menu-close", "x-circle", "Close merge request…", t.ansi1, () => {
        closeOverlay(me);
        openOverlay({ mod: "my-gitlab", kind: "dialog", width: 440, height: 190, props: { closeMr: mr } });
      }));
  }

  // The close dialog: Enter or Close closes the merge request on GitLab, Esc or Cancel doesn't.
  confirmClose(cx) {
    const mr = props().closeMr;
    if (this.closing) return;
    this.closing = true;
    this.closeError = null;
    setClosing(mr.webUrl, true);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = (await graphql(CLOSE_MR, { projectPath: mr.project.fullPath, iid: String(mr.iid) })).mergeRequestUpdate;
        if (res?.errors?.length) throw new Error(res.errors.join("; "));
        setShared("my-gitlab.changed", Date.now());
        closeOverlay(props().overlay);
      } catch (e) {
        setClosing(mr.webUrl, false);
        this.closeError = String(e?.message ?? e);
        this.closing = false;
        cx.notify();
      }
    });
  }

  closeDialog(t, mr) {
    const me = props().overlay;
    const busy = this.closing;
    // While closing: the buttons don't take clicks, Cancel fades, Close spins.
    const button = (id, label, bg, fg, border, action, spinner = false) => h_flex().id(id).h(32).px(14).gap(7).items_center().rounded(8)
      .border_1().border_color(border).bg(bg).text_color(fg)
      .when(!busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .when(busy && !spinner, (el) => el.opacity(0.45))
      .when(spinner, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().spin(900)))
      .child(label);
    return v_flex().id("gl-close").track_focus(this.handle)
      .on_key_down((e, cx) => {
        // While closing, keys do nothing: the result is on its way.
        if (e.key === "enter") { if (!this.closing) this.confirmClose(cx); }
        else if (e.key === "escape") { if (!this.closing) closeOverlay(me); }
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(18).gap(10).rounded(8).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Close merge request?"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().gap(3).min_w(0)
        .child(div().truncate().text_color(t.foreground).child(mr.title))
        .child(div().text_size(12).text_color(t.dim).child(`${mr.project.name} !${mr.iid} · it can be reopened on GitLab`)))
      .child(div().flex_1().min_h(0).text_size(12).text_color(t.ansi1).truncate().child(this.closeError ?? ""))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("gl-no", "Cancel", t.raised, t.foreground, t.input, () => closeOverlay(me)))
        .child(button("gl-yes", busy ? "Closing…" : "Close", t.ansi1, t.background, t.ansi1, (_e, cx) => this.confirmClose(cx), busy)));
  }

  browse(url) {
    exec("open", [url]).catch(() => {});
  }

  badge(t, text, color) {
    return div().px(5).rounded(4).border(1).border_color(t[color] ?? color).text_color(t[color] ?? color).text_size(10.5).flex_none().child(text);
  }

  // A row: the title (whole on hover), and under it where it is and its state.
  // Only the project's name gives way when the panel is narrow; the time sits at the right.
  // closable: right-click opens the menu that can close it (my open ones only).
  // closing: being closed from the dialog: a spinner for its status, faded, no clicks.
  row(t, key, mr, glyph, info, time, badges = [], closable = false) {
    const closing = closable && isClosing(mr.webUrl);
    if (closing) {
      glyph = div().w(14).flex_none().child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.muted).spin(900));
      time = "Closing…";
      badges = [];
    }
    return v_flex()
      .id(`gl-${key}-${mr.webUrl}`)
      .px(8).py(6).gap(3).rounded(7)
      .when(closing, (el) => el.opacity(0.55))
      .when(!closing, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.browse(mr.webUrl)))
      .when(closable && !closing, (el) => el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "my-gitlab", kind: "popup", width: 230, height: 110, props: { menu: mr } });
      }))
      .child(h_flex().gap(7).items_center()
        .child(glyph)
        .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(t.foreground).child(mr.title)))
      .child(h_flex().pl(21).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().min_w(0).truncate().child(mr.project.name))
        .child(div().flex_none().child(info ? `!${mr.iid} · ${info}` : `!${mr.iid}`))
        .child(div().flex_1())
        .children(badges)
        .child(div().flex_none().child(time)));
  }

  dot(t, color, text) {
    return div().w(14).flex_none().text_size(12).text_color(t[color]).child(text);
  }

  // The row's one status icon, most pressing first:
  //   red warning     conflict
  //   ✗ ● ◐ ⊘         the pipeline failed, is running, waits, was skipped
  //   amber ✓ circle  CI passed (or there's none) but no approval yet
  //   green ✓         CI passed and approved
  // (One approval is all a merge request needs here.) Rows without approval
  // data (To review) show the pipeline alone.
  status(t, mr) {
    const icon = (name, color) => div().w(14).flex_none().child(svg(ICON(name)).size(13).text_color(t[color]));
    if (conflicted(mr)) return icon("triangle-alert", "ansi1");
    const ci = mr.headPipeline?.status;
    const ciOk = !ci || ci === "SUCCESS";
    if (ciOk && mr.approvalsLeft !== undefined) {
      return approved(mr) ? this.dot(t, "ansi2", "✓") : icon("circle-check", "ansi3");
    }
    const [g, c] = pipeline(mr.headPipeline);
    return this.dot(t, c, g);
  }

  openRow(t, mr) {
    const v = verdict(mr);
    const badges = [];
    if (mr.draft) badges.push(this.badge(t, "Draft", "dim"));
    if (v) badges.push(this.badge(t, v[0], v[1]));
    return this.row(t, "open", mr, this.status(t, mr), null, ago(mr.updatedAt), badges, true);
  }

  mergedRow(t, mr) {
    const glyph = div().w(14).flex_none().child(svg(ICON("merge")).size(13).text_color(t.ansi5));
    return this.row(t, "merged", mr, glyph, null, ago(mr.mergedAt));
  }

  reviewRow(t, mr) {
    const who = mr.author?.name || mr.author?.username || "";
    return this.row(t, "review", mr, this.status(t, mr), who, ago(mr.updatedAt),
      mr.draft ? [this.badge(t, "Draft", "dim")] : []);
  }

  // A list's title folds it (unless foldable is false); folded, just its count.
  // An empty list is just its title, with its 0.
  section(t, id, icon, label, items, row, foldable = true) {
    const open = !foldable || !this.folded.has(id);
    return v_flex().flex_none()
      .child(h_flex().id(`gl-sec-${id}`).h(28).px(8).mt(6).gap(7).items_center().rounded(6)
        .text_size(11.5).text_color(t.muted)
        .when(foldable, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { open ? this.folded.add(id) : this.folded.delete(id); cx.notify(); }))
        .child(svg(ICON(icon)).size(13).flex_none())
        .child(div().font_semibold().child(label))
        .child(div().text_color(t.dim).child(String(items.length)))
        .child(div().flex_1())
        .when(foldable, (el) => el.child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))))
      .when(open, (el) => el.children(items.map((mr) => row(t, mr))));
  }

  render() {
    const t = theme();
    if (props()?.menu) return this.menu(t, props().menu);
    if (props()?.closeMr) return this.closeDialog(t, props().closeMr);
    if (this.headless) return div();
    const L = this.lists;
    // Refresh: one button with how old the list is ("3m"), icon and age in one color.
    const icon = svg(this.loading ? "mods/workspace-chrome/spinner.svg" : ICON("refresh")).size(13);
    const age = this.fetchedAt && L ? ago(new Date(this.fetchedAt).toISOString()) : "";
    const refresh = h_flex().id("gl-refresh").h(24).px(7).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.refresh(cx))
      .child(this.loading ? icon.spin(900) : icon)
      .when(Boolean(age), (el) => el.child(age));
    const header = h_flex().h(42).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.org ?? "GitLab"))
      .child(refresh);

    const body = v_flex().id("gl-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(10)
      .when(Boolean(this.error), (el) => el.child(div().m(6).p(10).rounded(8).border(1).border_color(t.ansi1)
        .text_size(12).text_color(t.ansi1).whitespace_normal().child(this.error)))
      .when(!L && !this.error, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child("Loading…")))
      .when(Boolean(L), (el) => el
        // What waits on you first, and only when something does; always open.
        .when(L.review.length > 0, (el) => el.child(this.section(t, "review", "eye", "To review", L.review, (t, mr) => this.reviewRow(t, mr), false)))
        .child(this.section(t, "open", "git-pull-request", "Open", L.open, (t, mr) => this.openRow(t, mr)))
        .child(this.section(t, "merged", "merge", "Merged", L.merged, (t, mr) => this.mergedRow(t, mr))));

    return v_flex().id("gitlab").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(header).child(body);
  }
}

// Accounts and keys: what each part of this layout needs (GitLab login, an
// OpenRouter key, a Slack token, terminal-notifier, Claude Code's login), whether
// it has it (status.py), and one button to get it. Installs run in a new tab;
// keys are pasted here (masked) and saved to <app home>/secrets/ (0600).
// Opened as a dialog: `mod.open my-setup`, the footer's Accounts, the GitLab
// panel and the rename dialog; props.focus names the item to open on.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, props, closeOverlay, theme, appHome, readTextFile, writeTextFile } from "herdr";

const STATUS = () => `${appHome()}/mods/my-setup/status.py`;
const LOGIN = () => `${appHome()}/mods/my-setup/gitlab_login.py`;
const SECRETS = () => `${appHome()}/secrets`;
// Where gitlab_login.py keeps the authorize URL while a login waits.
const LOGIN_URL = () => `${appHome()}/data/my-setup/gitlab-login-url`;
const REFRESH = 4000; // local checks while open, so an install finished in its tab shows up
const GITLAB_EVERY = 20000; // GitLab asks the network: less often
// Which status.py run answers for an item: GitLab's (slow, the network) or the local one.
const groupOf = (id) => (id === "gitlab" ? "gitlab" : "local");

// exec resolves on a failed run too: this throws its message instead.
async function must(command, args) {
  const r = await exec(command, args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${command} exited ${r.code}`);
}

// A new tab running a command (an install or a login), named for what it does.
const inTab = (name, command) => run("tab.new", { name, argv: ["sh", "-c", `${command}; echo; echo "完成後可關閉此分頁。"; exec "\${SHELL:-/bin/zsh}" -l`] });
const brew = (pkg) => inTab(`Install ${pkg}`, `brew install ${pkg}`);

// Slack's create-app page with this app filled in: a user token that can only search.
// After Create: Install to Workspace, then OAuth & Permissions has the xoxp- token.
const SLACK_MANIFEST = { display_information: { name: "Herdr" }, oauth_config: { scopes: { user: ["search:read"] } } };
const SLACK_NEW_APP = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_MANIFEST))}`;

// Buttons: [label, action, solid]. Solid: the one that sets up what's missing (for a
// key, only a required one).
const ITEMS = [
  // Logging in: glab's own web login (gitlab_login.py answers its questions), so
  // the browser opens GitLab's Authorize page and that's all.
  { id: "gitlab", title: "GitLab", what: "在 GitLab 面板查看你的 Merge Request 與待你審查的項目" },
  { id: "openrouter", title: "OpenRouter 金鑰", what: "自動建議分頁名稱，並判斷 agent 是否在執行背景指令", required: true,
    secret: { file: "openrouter.key", prefix: "sk-or-", placeholder: "sk-or-v1-…" } },
  { id: "slack", title: "Slack Token（選用）", what: "將 Slack 上提及你的 Merge Request 一併列入待審清單",
    secret: { file: "slack.token", prefix: "xoxp-", placeholder: "xoxp-…",
      guide: { text: "建立 App → Install to Workspace → 複製 User OAuth Token", link: "打開 Slack ↗", url: SLACK_NEW_APP } } },
  { id: "notifier", title: "terminal-notifier", what: "點擊系統通知時，直接切換到對應的 agent",
    actions: (s) => s === "ok"
      ? [["通知設定", () => exec("open", ["x-apple.systempreferences:com.apple.Notifications-Settings.extension"]).catch(() => {}), false]]
      : [["安裝", () => brew("terminal-notifier"), true]] },
  { id: "claude", title: "Claude Code", what: "在底部狀態列顯示 Claude 方案的用量",
    actions: (s) => s === "ok" ? []
      : s === "missing" ? [["安裝", () => inTab("Install Claude Code", "curl -fsSL https://claude.ai/install.sh | bash"), true]]
      : [["登入 Claude Code", () => run("tab.new", { name: "Claude login", argv: ["claude"], task: "/login" }), true]] },
];

export default class Setup extends View {
  init(_props, cx) {
    this.status = {};
    this.failed = new Set(); // ids status.py couldn't answer for
    this.checking = new Set(ITEMS.map((i) => i.id)); // asked status.py, no answer yet
    this.busy = new Set(); // something the person started (save, login, logout) is running
    this.inflight = { gitlab: 0, local: 0 }; // status.py runs still out, by group
    // Bumped by each action on an item: an answer about it asked before then is dropped.
    this.epoch = Object.fromEntries(ITEMS.map((i) => [i.id, 0]));
    this.note = {}; // id -> { text, kind: "error" | "progress" }
    this.touched = false; // the person did something: props.focus no longer highlights
    this.editing = props()?.focus && ITEMS.find((i) => i.id === props().focus)?.secret ? props().focus : null;
    this.handle = cx.focus_handle();
    // One masked box per key, with its own placeholder.
    this.inputs = Object.fromEntries(ITEMS.filter((i) => i.secret).map((i) => {
      const input = InputState.new({ value: "", placeholder: i.secret.placeholder });
      input.set_masked(true);
      input.on("submit", (_e, cx) => this.save(i.id, cx));
      input.on("change", (_e, cx) => { if (this.note[i.id]?.kind === "error") { this.note[i.id] = null; cx.notify(); } });
      input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
      input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
      return [i.id, input];
    }));
    if (this.editing) this.inputs[this.editing].focus(); else this.handle.focus();
    // Opened from the GitLab panel's login button: start the login right away.
    if (props()?.login && props()?.focus === "gitlab") this.gitlabLogin(cx);
    this.refreshAll(cx, true);
    cx.timer.every(REFRESH, (cx) => this.refreshAll(cx));
  }

  // GitLab asks the network (seconds); the rest are local and come back at once.
  // Each run is a task of this dialog, so an answer arriving after it closed is dropped.
  refreshAll(cx, first = false) {
    cx.spawn((cx) => this.refresh(cx, "local", ITEMS.map((i) => i.id).filter((id) => groupOf(id) === "local")));
    // Not while a login or logout runs (it checks again when it's done), except the first time.
    const due = !this.busy.has("gitlab") && Date.now() - (this.gitlabAt ?? 0) >= GITLAB_EVERY;
    if (first || due) cx.spawn((cx) => this.refresh(cx, "gitlab", ["gitlab"]));
  }

  // Asks status.py about `ids` (`args`: how) and shows the answers. One periodic run per
  // group at a time, none while an action's own check is out; `force` (that check) always runs.
  async refresh(cx, group, ids, args = ids, force = false) {
    if (this.inflight[group] > 0 && !force) return;
    this.inflight[group]++;
    if (group === "gitlab") this.gitlabAt = Date.now();
    const asked = ids.map((id) => this.epoch[id]);
    let d = null;
    try {
      const r = await exec("python3", [STATUS(), ...args], { timeout: 30000 });
      if (r.code === 0) d = JSON.parse(r.stdout);
    } catch {} // no answer: as if it had none for these ids
    this.inflight[group]--;
    ids.forEach((id, i) => {
      if (asked[i] !== this.epoch[id]) return; // asked before an action changed it
      if (d?.[id]) {
        this.status[id] = d[id];
        this.failed.delete(id);
        // A stale error goes once the item is fine again.
        if (d[id].state === "ok" && this.note[id]?.kind === "error") this.note[id] = null;
      } else if (!this.status[id]) this.failed.add(id);
      this.checking.delete(id);
    });
    cx.notify();
  }

  // Something the person started on an item: answers already out about it are stale.
  start(id, note, cx) {
    this.touched = true;
    this.busy.add(id);
    this.note[id] = note;
    this.epoch[id]++;
    cx.notify();
  }

  // ...and when it's done: the item checked again (`args`: how), then the note.
  // Called from a task (cx.spawn), whose cx stays valid across the awaits.
  async finish(id, note, cx, args = [id]) {
    this.epoch[id]++;
    await this.refresh(cx, groupOf(id), [id], args, true);
    this.busy.delete(id);
    this.note[id] = note;
    cx.notify();
  }

  edit(id, cx) {
    this.touched = true;
    const left = this.editing;
    this.editing = left === id ? null : id;
    // The box opened (and the one closed) starts empty; an error about what was typed goes.
    for (const k of new Set([left, id])) {
      if (!k) continue;
      this.inputs[k].set_value("");
      if (this.note[k]?.kind === "error") this.note[k] = null;
    }
    if (this.editing) this.inputs[id].focus(); else this.handle.focus();
    cx.notify();
  }

  // glab's web login: the browser opens GitLab's Authorize page; this waits
  // (up to 5 minutes) for the click, then checks.
  gitlabLogin(cx) {
    if (this.busy.has("gitlab")) return;
    this.loggingIn = true;
    this.cancelled = false;
    this.loginUrl = false;
    this.start("gitlab", { text: "請在瀏覽器的 GitLab 頁面按 Authorize", kind: "progress" }, cx);
    // Once glab has a URL to open, it can be copied into another browser profile.
    const watch = (cx) => {
      if (!this.loggingIn || this.loginUrl || this.cancelled) return;
      exec("test", ["-s", LOGIN_URL()]).then((r) => {
        if (r.code === 0 && this.loggingIn) { this.loginUrl = true; cx.notify(); } else cx.timer.after(500, watch);
      }).catch(() => {});
    };
    cx.timer.after(500, watch);
    cx.spawn(async (cx) => {
      let d;
      try {
        const r = await exec("python3", [LOGIN()], { timeout: 330000 });
        try { d = JSON.parse(r.stdout); } catch { d = { ok: false }; } // no answer from it: "glab 無回應"
      } catch {
        d = { ok: false, error: "逾時" }; // exec gave up on it
      }
      this.loggingIn = false;
      await this.finish("gitlab", d?.ok || this.cancelled ? null : { text: `登入失敗：${d?.error ?? "glab 無回應"}`, kind: "error" }, cx);
    });
  }

  cancelLogin(cx) {
    this.cancelled = true;
    this.note.gitlab = { text: "取消中…", kind: "progress" };
    cx.notify();
    exec("python3", [LOGIN(), "--cancel"]).catch(() => {});
  }

  copyLoginUrl(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'pbcopy < "$1"', "sh", LOGIN_URL()]).catch(() => null);
      if (!r || !this.loggingIn || this.cancelled) return; // the login ended meanwhile: its note stands
      this.note.gitlab = r.code === 0 ? { text: "已複製授權連結，請在要使用的瀏覽器設定檔中開啟", kind: "progress" }
        : { text: "授權連結已失效，請重新登入", kind: "error" };
      cx.notify();
    });
  }

  // Removes glab's saved login for gitlab.com (a GITLAB_TOKEN set elsewhere, e.g. a
  // shell's, still works there). Whether it worked shows in the check that follows.
  gitlabLogout(cx) {
    if (this.busy.has("gitlab")) return;
    this.start("gitlab", { text: "登出中…", kind: "progress" }, cx);
    cx.spawn(async (cx) => {
      await exec("glab", ["auth", "logout", "--hostname", "gitlab.com"], { timeout: 20000 }).catch(() => {});
      await this.finish("gitlab", null, cx);
    });
  }

  // Saved under secrets/ (folder 0700, file 0600), then checked with the service.
  save(id, cx) {
    const item = ITEMS.find((i) => i.id === id);
    if (!item?.secret || this.busy.has(id)) return;
    const value = this.inputs[id].value().trim();
    const fail = (text, cx) => { this.note[id] = { text, kind: "error" }; cx.notify(); };
    if (!value) return fail("請先貼上金鑰", cx);
    if (!value.startsWith(item.secret.prefix)) return fail(`格式不符：應以 ${item.secret.prefix} 開頭`, cx);
    this.busy.add(id); // from here on: a second Enter or 儲存 doesn't save it again
    cx.spawn(async (cx) => {
      const dir = SECRETS(), path = `${dir}/${item.secret.file}`;
      try {
        await must("mkdir", ["-p", dir]);
        await must("chmod", ["700", dir]);
        await writeTextFile(path, value + "\n", await readTextFile(path).catch(() => null));
        await must("chmod", ["600", path]);
      } catch (e) {
        this.busy.delete(id);
        return fail(`儲存失敗：${e?.message ?? e}`, cx);
      }
      this.inputs[id].set_value("");
      this.editing = null;
      this.handle.focus();
      this.start(id, { text: "已儲存，驗證中…", kind: "progress" }, cx);
      await this.finish(id, null, cx, ["--verify", id]);
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.editing) this.edit(this.editing, cx); else closeOverlay(props()?.overlay);
      cx.stop_propagation();
    }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const color = { ok: t.ansi2, missing: t.ansi3, logged_out: t.ansi3, bad: t.ansi1, unknown: t.dim };
    const noteColor = { error: t.ansi1, progress: t.dim };
    const button = (id, text, solid, action) => h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(7)
      .border_1().border_color(solid ? t.solid : t.input).bg(solid ? t.solid : t.background)
      .text_color(solid ? t.solid_foreground : t.foreground).text_size(12).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    // The highlighted row: the one being edited, else the one opened on until the person acts.
    const active = this.editing ?? (this.touched ? null : p.focus);
    const row = (item) => {
      const s = this.status[item.id];
      const state = s?.state ?? "unknown";
      const busy = this.busy.has(item.id);
      const spinning = this.checking.has(item.id) || busy;
      const loading = !s && this.checking.has(item.id); // nothing to show yet
      const failed = !s && this.failed.has(item.id);
      const editing = this.editing === item.id;
      const actions = loading || failed || editing ? []
        : item.id === "gitlab" ? (busy
            // Waiting on the browser: copy its link (for another profile) or give up.
            ? (this.loggingIn && !this.cancelled
              ? [...(this.loginUrl ? [["複製連結", (_e, cx) => this.copyLoginUrl(cx), false]] : []), ["取消", (_e, cx) => this.cancelLogin(cx), false]]
              : [])
          : state === "missing" ? [["安裝 glab", () => { brew("glab"); closeOverlay(p.overlay); }, true]]
          : state === "ok" ? [["登出", (_e, cx) => this.gitlabLogout(cx), false]]
          : [["用瀏覽器登入", (_e, cx) => this.gitlabLogin(cx), true]])
        : item.secret ? (busy ? []
          : [[state === "ok" || state === "bad" ? "更換" : "設定", (_e, cx) => this.edit(item.id, cx), Boolean(item.required) && state === "missing"]])
        : item.actions(state).map(([text, go, solid]) => [text, () => { go(); closeOverlay(p.overlay); }, solid]);
      const note = this.note[item.id];
      const status = note ? div().text_color(noteColor[note.kind]).child(note.text)
        : failed ? div().text_color(t.ansi1).child("無法取得狀態")
        : div().text_color(loading ? t.dim : state === "ok" ? t.muted : color[state] ?? t.muted).child(s ? s.detail : "檢查中…");
      return v_flex().flex_none().px(12).py(8).gap(6).rounded(9).when(active === item.id, (el) => el.bg(t.raised))
        .child(h_flex().gap(10).items_start()
          // The dot sits on the title's line.
          .child(div().h(18).w(12).flex_none().flex().items_center().justify_center()
            .child(spinning
              ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.dim).spin(900)
              : div().size(8).rounded_full().bg(failed ? t.ansi1 : color[state] ?? t.dim)))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().h(18).text_size(13).font_semibold().child(item.title))
            .child(div().text_size(11.5).text_color(t.dim).whitespace_normal().child(item.what))
            // While its key is being set, the box (with its buttons) takes the status line's place.
            .child(editing
              ? v_flex().gap(5)
                .child(h_flex().mt(4).gap(8).items_center()
                  .child(Input.new(this.inputs[item.id]).flex_1().h(28).px(9).rounded(7).border_1()
                    .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(12.5))
                  .child(button(`su-${item.id}-cancel`, "取消", false, (_e, cx) => this.edit(item.id, cx)))
                  .child(button(`su-${item.id}-save`, "儲存", true, (_e, cx) => this.save(item.id, cx))))
                .when(note?.kind === "error", (el) => el.child(div().text_size(11.5).text_color(t.ansi1).whitespace_normal().child(note.text)))
                // Where the key comes from, right under the box that takes it.
                .when(Boolean(item.secret.guide), (el) => el.child(h_flex().gap(6).items_center().text_size(11.5)
                  .child(div().flex_1().min_w(0).text_color(t.dim).whitespace_normal().child(item.secret.guide.text))
                  .child(div().id(`su-${item.id}-guide`).flex_none().text_color(t.accent).cursor_pointer().hover((s) => s.opacity(0.8))
                    .on_click(() => exec("open", [item.secret.guide.url]).catch(() => {})).child(item.secret.guide.link))))
              : status.text_size(11.5).whitespace_normal()))
          // While loading, a placeholder the size of a button.
          .when(loading, (el) => el.child(div().self_center().w(64).h(28).flex_none().rounded(7).bg(t.raised).opacity(0.6)))
          .when(actions.length > 0, (el) => el.child(h_flex().self_center().flex_none().gap(8)
            .children(actions.map(([text, go, solid], i) => button(`su-${item.id}-${i}`, text, solid, go))))));
    };
    return v_flex().id("my-setup").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).pt(16).gap(4).bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(16).items_center().pb(6)
        .child(div().flex_1().text_size(15).font_semibold().child("Accounts & keys"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().px(16).pb(4).text_size(11.5).text_color(t.dim).whitespace_normal()
        .child("金鑰只存放在本機的 ~/.config/herdr-app/secrets/，僅用於向對應服務驗證，不納入版本控制。"))
      // The rows scroll, so an open key box never pushes the last ones out of sight.
      .child(v_flex().id("su-list").flex_1().min_h(0).px(16).pb(12).gap(2).overflow_y_scrollbar().children(ITEMS.map(row)));
  }
}

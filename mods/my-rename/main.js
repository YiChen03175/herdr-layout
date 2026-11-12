// A rename prompt that also suggests a name. Enter saves, Esc cancels.
// my-rename (a clone of Herdr's prompt): with props.terminal, suggest.py asks
// Claude Haiku what that terminal is working on; the suggestion fills the box
// while you haven't typed, and stays a click away once you have.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, exec, appHome } from "herdr";

export default class Rename extends View {
  init(_props, cx) {
    this.text = props()?.value ?? "";
    this.original = this.text;
    this.typed = false;
    this.suggestion = null;
    this.suggesting = Boolean(props()?.terminal);
    this.input = InputState.new({ value: this.text });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value();
      if (this.text !== this.suggestion && this.text !== this.original) this.typed = true;
      cx.notify();
    });
    this.input.on("submit", () => this.submit());
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    if (this.suggesting) this.suggest(cx);
  }

  suggest(cx) {
    const p = props();
    exec("python3", [`${appHome()}/mods/my-rename/suggest.py`, p.terminal, p.value ?? ""], { timeout: 60000 })
      .then((r) => {
        let name = null;
        try { name = r.code === 0 ? JSON.parse(r.stdout).name : null; } catch {}
        this.suggesting = false;
        this.suggestion = name;
        if (name && !this.typed) this.use(name);
        cx.notify();
      })
      .catch(() => { this.suggesting = false; cx.notify(); });
  }

  // Puts a name in the box, selected, so typing replaces it.
  use(name) {
    this.input.set_value(name);
    this.text = name;
    this.input.set_selected_range({ start: 0, end: name.length });
    this.input.focus();
  }

  submit() {
    const p = props();
    closeOverlay(p.overlay);
    run(p.command.name, { ...(p.command.args ?? {}), name: this.text });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const label = (text) => div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child(text);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover(s => s.opacity(0.88)).on_click(action).child(text);
    // Under the box: what the suggestion is doing, or a way to swap between it and the old name.
    const chip = (id, text, action) => div().id(id).px(7).h(20).flex().items_center().rounded_full()
      .bg(t.raised).border_1().border_color(t.input).text_color(t.foreground).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => { action(); cx.notify(); }).child(text);
    const shown = this.suggestion && this.text === this.suggestion;
    // Asked, answered, and no name came back.
    const failed = Boolean(p.terminal) && !this.suggesting && !this.suggestion;
    const hint = this.suggesting ? div().text_color(t.dim).child("Suggesting a name…")
      : failed ? div().text_color(t.dim).child("No suggestion this time.")
      : !this.suggestion ? null
      : shown ? h_flex().gap(6).items_center().child(div().text_color(t.dim).child("Suggested by Claude Haiku."))
          .when(Boolean(this.original), el => el.child(chip("rn-orig", `Keep "${this.original}"`, () => this.use(this.original))))
      : h_flex().gap(6).items_center().child(div().text_color(t.dim).child("Suggestion:"))
          .child(chip("rn-sugg", this.suggestion, () => this.use(this.suggestion)));
    return v_flex().id("prompt").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child((p.title ?? "").replace(/^./, (c) => c.toUpperCase())))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().h(26).pt(6).text_size(11.5).when(Boolean(hint), el => el.child(hint)))
      .child(h_flex().pt(12).gap(8).justify_end()
        .child(button("pm-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("pm-save", "Save", true, () => this.submit())));
  }
}

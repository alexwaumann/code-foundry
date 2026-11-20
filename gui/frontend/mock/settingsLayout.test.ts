import { describe, expect, it } from "vitest";
import { MockSettings, staticPages } from "./settings";

/**
 * The mock's settings pages mirror internal/store/settings (TestPageLayout there pins the real
 * ones; docs/notes/settings-pages-sections.md): the same pages in nav order, Advanced last, and
 * the moved sections with their fields.
 */
describe("the mock's settings layout", () => {
  const settings = new MockSettings(
    () => [],
    () => undefined,
  );
  const fieldsOf = (page: string, section: string) =>
    settings
      .fields()
      .filter((f) => f.page === page && f.section === section)
      .map((f) => f.key);

  it("has the daemon's pages in order, Advanced last", () => {
    expect(staticPages.map((p) => p.id)).toEqual(["general", "appearance", "layout", "notifications", "dictation", "source", "keybindings", "plugins", "ember", "advanced"]);
  });

  it.each([
    ["general", ["threads", "textgen", "snooze", "until-event", "files", "updates"]],
    ["appearance", ["theme", "window", "terminal"]],
    ["layout", ["panes"]],
    ["dictation", ["dictation"]],
    ["ember", ["experiment", "models", "sessions"]],
    ["advanced", ["executables", "threads", "logging"]],
  ])("%s has the sections %j", (page, sections) => {
    expect(staticPages.find((p) => p.id === page)?.sections?.map((s) => s.id)).toEqual(sections);
  });

  it.each([
    ["general", "threads", ["threads.default_model", "threads.default_effort", "threads.default_worktree", "threads.auto_name"]],
    ["general", "snooze", ["threads.default_snooze", "threads.auto_save_after", "threads.auto_archive_after"]],
    ["general", "until-event", ["threads.snooze_events"]],
    // Threads open as first, Smart swap right below it.
    ["layout", "panes", ["layout.threads_open_as", "layout.smart_swap", "layout.smart_placement", "layout.thread_info", "sidebar.needs_scope"]],
    ["dictation", "dictation", ["dictation.enabled", "dictation.anywhere", "dictation.hold_key", "dictation.microphone", "dictation.sounds", "dictation.other_audio", "dictation.avoid_bluetooth", "dictation.spoken_symbols", "dictation.spoken_formatting"]],
    ["ember", "sessions", ["ember.epoch_context_tokens", "ember.epoch_max_hours"]],
    ["advanced", "threads", ["threads.cache_ttl_seconds", "threads.close_grace_seconds"]],
  ])("%s/%s holds %j", (page, section, keys) => {
    expect(fieldsOf(page, section)).toEqual(keys);
  });

  it("titles the renamed and new sections", () => {
    const title = (page: string, section: string) => staticPages.find((p) => p.id === page)?.sections?.find((s) => s.id === section)?.title;
    expect([title("general", "snooze"), title("ember", "sessions"), title("advanced", "threads"), title("layout", "panes"), title("dictation", "dictation")]).toEqual(["Snooze", "Fresh sessions", "Threads", "", ""]);
  });
});

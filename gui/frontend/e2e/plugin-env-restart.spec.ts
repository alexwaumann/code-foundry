import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row } from "./fixtures";

// A plugin's session environment changed since a running thread's Claude started
// (Thread.plugin_env_stale; docs/notes/plugins-env-restart.md): the thread info card's
// project row is marked and its hover card says what changed, and the title menu offers
// Restart Claude (thread.restart), which asks only when it would interrupt a turn
// (docs/notes/thread-header-crumb.md). The mock's POST /__mock/thread/envstale is the
// daemon's staleness check.

test.beforeEach(async () => {
  await resetMock();
});

const stale = (id: string, change: string) => mockPost(`thread/envstale?id=${id}&change=${encodeURIComponent(change)}`);
const titleMenu = async (page: Page) => {
  await page.getByTestId("thread-header").getByTestId("thread-title").click();
  return page.getByTestId("thread-title-menu");
};

// An idle stale thread: the card's mark and note arriving and going (src/components/threadinfo/PlaceGroup.test.tsx),
// the title's warning dot (src/components/thread/ThreadParts.test.tsx), Restart Claude only while stale and
// running thread.restart (src/components/thread/ThreadMenuItems.test.tsx). That an idle thread restarts
// without asking is the daemon's rule: internal/command/commands_thread_restart_test.go TestThreadRestart.

// Restarting a working thread asking first (the conversation continues, the turn interrupted): the daemon's, internal/command/commands_thread_restart_test.go (TestThreadRestart "a working thread asks", "…restarts once confirmed"); the title menu's Restart Claude is src/components/thread/ThreadMenuItems.test.tsx's, the confirm src/components/confirm/ConfirmDialog.test.tsx's.

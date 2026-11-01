import { expect, test } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

// Plugins' flags on threads (docs/notes/plugins-3-events-flags-env.md): a flagged thread
// needs attention (window title, sort), line 1 says the plugin's name in amber or red and line 3 the reason, and an
// until-seen flag goes when the thread is opened. The mock's POST /__mock/thread/flag is a
// plugin's thread/setFlag.

test.beforeEach(async () => {
  await resetMock();
});

const flag = (id: string, level: string, reason: string, plugin = "gh-actions", name = "GitHub Actions", untilSeen = false) =>
  mockPost(
    `thread/flag?id=${id}&plugin=${plugin}&name=${encodeURIComponent(name)}&level=${level}&reason=${encodeURIComponent(reason)}${untilSeen ? "&untilSeen=1" : ""}`,
  );

// A flag's name on line 1 in amber or red, its reason on line 3, live as it arrives and clears:
// src/components/sidebar/SidebarRow.test.tsx ("a plugin's flag arriving over the stream"); the
// attention group, the count and not-running: src/api/threadFlags.test.ts; the window title's
// count: src/stores/threads.test.ts ("window title carries the attention count").

// An until-seen flag going when the thread is opened: the daemon's (internal/store/thread/flags_test.go, "until seen clears when the thread is opened…"); a flag's row status is src/components/sidebar/SidebarRow.test.tsx's.

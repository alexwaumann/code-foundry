/**
 * The log preview's fixtures (docs/notes/file-previews-6-logs.md): a Go daemon's slog text
 * log with a stack trace, and a test run's captured terminal output with colour codes and a
 * progress bar. Text only, so vitest can import it.
 */
const E = "\u001b[";

/** logs/daemon.log: slog text, levels INFO/DEBUG/WARN/ERROR, an error with its trace. */
export const DAEMON_LOG = `time=2026-11-14T09:14:02.113-08:00 level=INFO msg="daemon listening" port=7421 version=v0.22.0-tip.3
time=2026-11-14T09:14:02.118-08:00 level=INFO msg="project store ready" projects=6 worktrees=14
time=2026-11-14T09:14:02.131-08:00 level=DEBUG msg="fsevents stream started" paths=6
time=2026-11-14T09:14:02.340-08:00 level=INFO msg="gh viewer resolved" login=dev
time=2026-11-14T09:14:09.902-08:00 level=WARN msg="gh rate limit low" remaining=112 reset=41m
time=2026-11-14T09:14:31.007-08:00 level=INFO msg="thread started" id=t-8f2c project=code-foundry model=sonnet-5.5
time=2026-11-14T09:14:31.455-08:00 level=DEBUG msg="claude initialized" id=t-8f2c tools=24 mcp=3
time=2026-11-14T09:15:12.870-08:00 level=INFO msg="turn finished" id=t-8f2c steps=7 cost=0.42
time=2026-11-14T09:15:47.224-08:00 level=ERROR msg="worktree add failed" project=code-foundry branch=cf/file-formats err="exit status 128"
    fatal: a branch named 'cf/file-formats' already exists
    goroutine 84 [running]:
    internal/store/project.(*Store).addWorktree(0x14000128000, {0x1400021c0f0, 0x10})
        internal/store/project/worktree.go:212 +0x1c4
time=2026-11-14T09:15:47.229-08:00 level=INFO msg="thread stopped" id=t-8f2c reason=crashed
time=2026-11-14T09:16:03.518-08:00 level=INFO msg="thread started" id=t-91aa project=dotfiles model=haiku-5.5
time=2026-11-14T09:16:40.006-08:00 level=WARN msg="mcp server slow to connect" server=linear waited=9s
time=2026-11-14T09:17:22.611-08:00 level=INFO msg="pull request refreshed" project=code-foundry number=720 checks=1
time=2026-11-14T09:18:05.090-08:00 level=INFO msg="turn finished" id=t-91aa steps=3 cost=0.03
time=2026-11-14T09:18:05.774-08:00 level=DEBUG msg="snapshot published" store=thread subscribers=2
time=2026-11-14T09:19:44.300-08:00 level=INFO msg="update check" channel=tip latest=v0.22.0-tip.3
`;

/** logs/test-run.txt: a test runner's output as captured from a terminal (a .txt: the sniff finds it). */
export const TEST_RUN = `${E}2K${E}36minstalling${E}0m [          ]   0%\r${E}2K${E}36minstalling${E}0m [#####     ]  50%\r${E}2K${E}36minstalling${E}0m [##########] 100%
${E}1m${E}46m RUN ${E}0m ${E}36mv5.0.3${E}0m ${E}90m/Users/dev/src/code-foundry/gui/frontend${E}0m

 ${E}32m✓${E}0m src/api/files.test.ts ${E}90m(14 tests)${E}0m ${E}90m23ms${E}0m
 ${E}32m✓${E}0m src/lib/filePath.test.ts ${E}90m(31 tests)${E}0m ${E}90m9ms${E}0m
 ${E}32m✓${E}0m src/components/files/fileKind.test.ts ${E}90m(22 tests)${E}0m ${E}90m12ms${E}0m
 ${E}33m❯${E}0m src/components/files/FileTab.test.tsx ${E}90m(9 tests | ${E}31m1 failed${E}90m)${E}0m ${E}33m412ms${E}0m
   ${E}32m✓${E}0m shows a markdown file rendered ${E}90m41ms${E}0m
   ${E}32m✓${E}0m switches to source ${E}90m18ms${E}0m
   ${E}31m×${E}0m shows a CSV as a table ${E}90m38ms${E}0m
 ${E}32m✓${E}0m src/stores/filePanel.test.ts ${E}90m(8 tests)${E}0m ${E}90m6ms${E}0m

${E}31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯${E}0m

${E}1m${E}41m FAIL ${E}0m src/components/files/FileTab.test.tsx ${E}90m>${E}0m shows a CSV as a table
${E}1m${E}31mAssertionError${E}0m${E}31m: expected 'Source' to be 'Table'${E}0m

${E}32m- Expected${E}0m
${E}31m+ Received${E}0m

${E}32m- Table${E}0m
${E}31m+ Source${E}0m

 ${E}36m❯${E}0m src/components/files/FileTab.test.tsx:${E}33m212${E}0m:${E}33m41${E}0m
    ${E}90m210|${E}0m   render(<FileTab tab={csvTab} />);
    ${E}90m211|${E}0m   const mode = await screen.findByRole("radiogroup");
    ${E}90m212|${E}0m   expect(checked(mode)).toBe("Table");
    ${E}90m   |${E}0m                         ${E}31m^${E}0m

${E}1m Test Files ${E}0m ${E}1m${E}31m1 failed${E}0m ${E}90m|${E}0m ${E}1m${E}32m46 passed${E}0m ${E}90m(47)${E}0m
${E}1m      Tests ${E}0m ${E}1m${E}31m1 failed${E}0m ${E}90m|${E}0m ${E}1m${E}32m611 passed${E}0m ${E}90m(612)${E}0m
${E}1m   Duration ${E}0m 8.41s
`;

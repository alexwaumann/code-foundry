# Plugins layout: Go-side fixes from the fuzzing pass (2026-10-19)

The layout primitives (PRs #221, #229, #233, #236) were fuzzed on the Go side
(`sdk.md`) and live against a real daemon and GUI (`live.md`, 2026-10-19). This
change fixes the Go-side findings and the daemon findings live #3, #11 and #12. A sibling
change (`cf/plugin-layout-fixes-gui`) fixes the GUI findings. The fuzzing branch's
harnesses ship here as the regression suite: the view generator (`viewgen_test.go`, in
both packages), the property tests, the exhaustive depth, element, height and strip
tests, the act edge cases, and the targets `FuzzGeneratedView` and
`FuzzGeneratedViewInTheDaemon` in `make fuzz`. Each known-issue repro is now a plain
test (`pluginsdk/ui/regress_test.go`,
`internal/store/plugin/layout_regress_internal_test.go`), and no gated test is left.

## Findings

| Id | Root cause | Fix | Test |
|---|---|---|---|
| sdk 0 (FuzzOwnedParams crasher) | `terminal/create` without a title took `filepath.Base(argv[0])` with no checks | The derived title goes through the same `oneLine` rule as a given title and is refused the same way ("title (argv[0]'s base name without one; pass a title) is one line of at most 80 bytes") | `TestTerminalTitleFromArgv`; both crasher inputs are seeds in `testdata/fuzz/FuzzOwnedParams/` |
| sdk 1 (high) | `checker.node` reported a node past `MaxDepth` and kept descending, and every key's full path was kept in `c.keys`: O(depth²). A 978 KB view (3300 nested tabs nodes) allocated 3.2 GB in Validate and 1.7 GB of daemon heap | A node past `MaxDepth` is counted, refused once, and its insides are not walked. With depth bounded, paths are bounded too. The UTF-8 walk keeps its path as segments, joins one only for a problem it names, and caps it at 512 bytes | `TestDeepViewCostIsBounded` (3 MB in 11 ms; 32 MB / 2 s bounds; also a bad string at the bottom), `TestValidateViewDeepIsCheap` (daemon, 17 MB with decoding; 64 MB / 5 s bounds) |
| live 12 | The depth message listed every container kind | The walk carries the stack of container kinds: `inside 5 containers (section > columns > tabs > masterDetail > pane), at most 4` | `TestDepthEveryMix` checks the stack for every mix of 5 |
| live 3 | `keptVersions = 4`: at 40 views a second the version on screen was gone before the click arrived (27 % failed), and the error carried the instance key | A version acts for `keptFor` (3 s) after a newer view replaced it, at most 64, pruned on each new version. Age counts from replacement, so a long-shown view just replaced still acts. A gone version is a failed precondition reading "the view changed before this action reached it; try again" (`staleVersionError`). The numbers go to the plugin's log | `TestActsOnRecentVersions` (21 versions back, then refused 4 s on, with a skewed clock), `TestKeptVersions` (the 64 cap, the 3 s edge) |
| live 11 | The act timeout and "stopped while handling" errors wrapped nothing, so the API answered `CodeInternal` | `causedError` keeps the words and wraps `context.DeadlineExceeded` (Connect DeadlineExceeded) or the new `plugin.ErrUnavailable` (Unavailable; `pluginError` maps it). `Options.ActTimeout` (default 10 s) | `TestActTimeoutAndStop` (the surf helper's new `hang` and `exit` buttons), API codes in `TestGetSurfaceAndAct` |
| sdk 2 | `Act` dropped a client's value for tab and select acts, but not its values | Both are dropped for tab and select acts | `TestLayoutActEdges` |
| sdk 3 | `reject` moved the notice's key around node keys only (not columns, grid items, tabs, rows) | Keys starting `cf-` (`ui.ReservedKeyPrefix`) are refused in plugin views. The notice keeps `cf-invalid-view`, the key the GUI's NoticeNode checks | `TestRejectNoticeKeyIsReserved` |
| sdk 4 | A master-detail row's own `selected`, and `detail` nodes while `selected` is `""`, were accepted. The GUI shows neither, but the hidden detail's elements still acted from the CLI and counted toward the limits | Both are refused (refusing was preferred to documenting them) | `TestMasterDetailIgnoredStateRefused` |
| sdk 5 | `change` on a fieldset was checked before the fieldset branch. It is never indexed, so it could never fire | Refused | `TestFieldsetChangeRefused` |
| sdk 6 | View-wide problems (elements, log nodes, size) were recorded last, so past `MaxProblems` they were only counted | `checker.always` names them past the cap | `TestViewWideProblemsNamed` |
| sdk 7 | `viewLimits` lacked the column weight and width, the px height bounds, `MaxTerminalButtons` and `MaxPattern`. The elements label left out columns and grid items | Rows added, label fixed | `TestViewLimitsNameEveryLimit` parses `pluginsdk/ui` for exported `Max*`/`Min*` constants. `MaxProblems` and the GUI's `MaxLiveNodes` are exempt |
| sdk 8 | The primitives.md act table had no `Value` for select | Added, with "no `Values`" for tab and select | docs |
| sdk 9 | An event named `select` or `tab` arrives as `kind: click` with that action, so a plugin that switches on `Action` alone mistakes it for a choice | Documented: dispatch on `Kind` first. Refusing those names would break plugins that use them. The surf helper now dispatches on Kind | docs |
| sdk 10 | plugintest's `Act` sent acts verbatim, and the fake host announced no capabilities | `Act` shapes tab and select acts from the latest view (kind, action, node, `Value` the key, no `Values`) and refuses the wrong kind. Other acts still go as given, so a plugin's own refusals stay testable. `Options.Capabilities` nil announces `plugintest.HostCapabilities` | `TestActShapesTabsAndSelects`, `TestDefaultCapabilities`, and `TestPluginTestAnnouncesTheHostsCapabilities` (equal to the daemon's list) |
| sdk 11 | `Height.UnmarshalJSON` returned a plain error, so the problem had no path | Returns `*json.UnmarshalTypeError`, which encoding/json fills with the field path | `TestBadHeightKeepsItsPath` |
| sdk 12 | The fuzz null-list check lacked `detail` | Added | `TestRequiredListsAreEveryRequiredList` (reflection over the view model) |
| sdk 13 | `plugin surface` had no node column | `NODE` column | `TestPluginSurfaceCommands` |
| sdk 14 | `kindOf` and `Node.kind` were the same function | `kindOf` removed | |

## Decisions and gotchas

* **Refused depth means uncounted insides.** A view refused for depth no longer counts the
  elements below the refused node, so its "N elements" problem can be smaller than
  before. The property test skips the count comparison for views deeper than
  `MaxDepth`.
* **`cf-` is reserved.** This is a new refusal. No plugin in this repo or the
  registry used such keys. The GUI's own synthetic keys (`${node.key}-empty` in
  MasterDetailNode) could use the prefix to stay out of plugins' way. That is the GUI
  change's call.
* **The surf helper's master-detail now selects `pr1`**, since its detail with nothing
  selected is refused now. It gained a second actions node (`bar2`: `hang`, `exit`)
  because an actions bar holds at most 6 buttons.
* **Unavailable and the GUI.** `invalidateOnTransportError` drops the cached endpoint on
  Unavailable, so a plugin dying under an act makes the GUI re-resolve the daemon once.
  That is cheap, and the same code was already used for a closed store.
* **No SDK tag.** The SDK's validation got stricter (cf- keys, master-detail state,
  fieldset change), so a plugin built on this SDK refuses those views itself. The host
  enforces the rules either way. Tag `pluginsdk/vX.Y.Z` when the series is released.

## End to end

An isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-fix-sdk/home`, `--dev`, `claude_path` set to
`cmd/fakeclaude`), the hello example linked with `plugin dev`, and a no-project thread:

```
$ code-foundry plugin act hello demo --thread s-263daff80c42 --key run-list --quiet
acted on run-list (view version 1)
$ code-foundry plugin surface hello demo --thread s-263daff80c42   # excerpt
  KEY                KIND    ACTION  LABEL     FORM  NODE
  runs-run-5         select  select  Build #5        runs-md
  runs-tab-log       tab     tab     Log             runs-tabs
$ code-foundry plugin act hello demo --thread s-263daff80c42 --key runs-run-5 --values '{"name":"Ada"}' --quiet
acted on runs-run-5 (view version 2)          # the values do not reach the plugin
$ code-foundry plugin act hello demo --thread s-263daff80c42 --key runs-run-4 --version 99 --quiet
code-foundry plugin.act: the view changed before this action reached it; try again
$ code-foundry plugin logs hello | grep "act on version"
05:12:28.364 host       act on version 99 of hello/demo/thread:s-263daff80c42 refused: gone (the current one is 3)
```

The daemon was stopped and the home removed. `TestPluginWakes` (thread store) failed 12
of 20 runs on main as well: one fire woke two subscriptions in random order, and the test
took the first wake for the one-shot's. It now takes either order.

## Left out

* sdk 10's `Host.ActOn` (resolving every act kind and refusing what `idx.find` would)
  was not built. `Act` shapes only the acts whose shape the host derives (tab and
  select). Making it strict for clicks and submits would break plugin tests that check
  the plugin's own refusal of unknown keys (hello's `runs_test.go`, `surface_test.go`).
* sdk.md's GUI item (`MasterDetailNode.tsx`'s `-empty` key) and the live GUI findings
  belong to the GUI change.

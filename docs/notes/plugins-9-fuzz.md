# Plugins 9: fuzz targets and the bugs they found (2026-10-18)

The ninth PR of the plugin stack, on `cf/plugins-7-registry` (73685d8b). It adds Go
fuzz targets for every place a plugin, a registry or a tarball feeds the daemon bytes,
table tests with misbehaving fake plugins, a short GUI property test, and fixes what
they found, plus two follow-ups the coordinator asked for (#22, #23). Each fix is the
smallest change that closes the hole; each bug has a regression input (a named seed under the target's `testdata/fuzz/`, or a table test).

## Targets

`make fuzz` runs each target for `FUZZTIME` (default 30s), one after another. It is not
part of `make check`; the seed corpora (the `f.Add` seeds and `testdata/fuzz/`) run as
ordinary tests in `make check`.

| Target | Package | What it checks |
|---|---|---|
| `FuzzSplitter` | `pluginsdk` | the line splitter, fed in random chunks, gives the lines a reference split gives (blank and oversize lines dropped), never buffering more than the limit |
| `FuzzConn` | `pluginsdk` | a `Conn` reading arbitrary bytes in arbitrary pieces: no panic; every request (a JSON object with a string method and an id) is answered while the input is open; everything written is a well-formed response under the line limit; EOF closes it and the writer drains |
| `FuzzParseManifest` | `pluginsdk` | `ParseManifest` + `Validate` on anything; a valid manifest re-encodes byte-stably and validates again; every arg default parses as the registry parses it; permission helpers are reflexive |
| `FuzzMatchCommand` | `pluginsdk` | command globs: an invalid glob never matches; a literal matches only itself; `*` never crosses a dot |
| `FuzzView` | `pluginsdk/ui` | a view `Validate` accepts encodes, decodes on the host into a view `Validate` accepts (SDK and daemon agree), and re-encodes byte-stably; a second input appends invalid UTF-8 to string fields (a Go plugin can build those) |
| `FuzzValidateView` | `internal/store/plugin` | the daemon's `validateView` on raw bytes: the same problems as the SDK's `Validate` (besides the host-only command and secret checks), a canonical form that validates again byte for byte and has `[]` (never `null`) for every required list; then install, render, index, `find` every element, append to every node (only log nodes take it), pull |
| `FuzzViewMutate` | `internal/store/plugin` | the same checks on structured mutations of the hello demo's views: a path into the JSON tree, then null, drop, wrong type, empty or 70 000-char string, -1, MaxFloat64, ×500 array, 40-deep sections, unknown kind, duplicate element (duplicate keys), duplicate JSON key, `1e999` |
| `FuzzPredicate` | `internal/store/plugin` | `CompilePredicate` on any string (compile under 2 s), evaluation over facts drawn from the input; three-valued logic agrees with itself (`!(p)` is `not p`, `p && p` and `p \|\| p` are `p`) |
| `FuzzActValues` | `internal/store/plugin` | `Act`'s value checks against the every-kind form: unknown names refused; what is sent has its control's type (bool, `[]string`, valid UTF-8 string); secrets only with a submit; stores only under keys the secret store takes |
| `FuzzValidateEnvironment` | `internal/store/plugin` | `session/setEnvironment` (and `thread/create` / `terminal/create` env) on anything: no reserved or malformed key, no oversize or NUL value, only absolute directories under home without `:`/NUL/newline, every limit held, issues capped |
| `FuzzManifestCommands` | `internal/store/plugin` | a manifest `LoadManifest` accepts registers: its commands and show commands pass the command registry's own validation |
| `FuzzOwnedParams` | `internal/store/plugin` | `thread/create` and `terminal/create` params: what reaches the thread and terminal stores has a one-line title, a prompt and argv within limits, valid unreserved env, a cwd and add-dirs that are directories under home |
| `FuzzParseIndex` | `…/registry` | `index.json` on anything: kept entries validate, are distinct and sorted; artifact URLs are https (http only on loopback); no release URL whose tag or asset reaches gh as a flag |
| `FuzzVersion` | `…/registry` | semver: `Compare` is antisymmetric and reflexive, `Newer` agrees with it, a malformed version is never newer |
| `FuzzParseLocation` | `…/registry` | registry locations, release URLs, `ParseList`, `ParseRepoRef`: results are https (or loopback http) without credentials, repos `owner/name`, no flag-shaped tag or asset |
| `FuzzFindChecksum` | `…/registry` | checksums files: a found hash is 64 lowercase hex |
| `FuzzExtract` | `…/registry` | tarballs built from the input (every entry type: files, dirs, symlinks, hard links, char/block devices, FIFOs, PAX globals, GNU sparse, unknown; names with `..`, absolute, backslash, NUL, long, unicode; modes): nothing outside the package directory, only directories and 0644/0755 regular files, the unpacked limit held |
| `FuzzExtractBytes` | `…/registry` | the same on raw bytes, seeded with real tarballs |

`TestMisbehavingPlugins` (`internal/store/plugin/robustness_test.go`) runs fake plugins
with the existing re-exec pattern (`helper_test.go` now falls through to
`extraHelpers`): **garbage** (invalid UTF-8, a partial line, a 5 MiB line, a 100 000-deep
nesting bomb, batches, responses to unknown ids, a request with `"jsonrpc": 2`, binary
stderr) keeps running with the same pid and answers commands; **flood** (log and
view/update notifications and requests as fast as the pipe takes them) keeps the heap
within 256 MB of its start (it stayed at 10 MB), the store answering within a second,
commands working and disable prompt; **wrongids** (every answer to the wrong id) fails
after the crash limit with "not answering pings"; **closestdout** (stdout closed, stderr
alive) crashes with "closed its stdout" and its process is killed; **binstderr**
(invalid UTF-8 and a line cut inside a rune) fails with a UTF-8 last error and log;
**bigline** (a 100 MB line) is skipped without the heap growing; **midexit** (exits while
handling a command) fails the command at once and restarts; **hugeresult** (a result
over the line limit) fails the command at once instead of after its timeout.

`gui/frontend/src/components/plugin/fuzz.test.tsx` renders 150 seeded mutations of the
hello demo's views, within what the daemon accepts (lists emptied, optional fields
dropped, hostile or long text, numbers at their bounds, elements repeated under new
keys), through the header, tab bar and node list, asserting no throw (3000 seeds passed
locally).

### Run times

Every target ran for 5 m 30 s (`-parallel 4`, three targets at a time on a 12-core Mac)
after its fixes, with no failure. `FuzzManifestCommands` found #21 in its first long run;
it, `FuzzParseManifest` and the then-new `FuzzOwnedParams` ran again after that fix:

| Target | Time | Executions |
|---|---|---|
| `FuzzSplitter` | 5m30s | 18 367 741 |
| `FuzzConn` | 5m30s | 16 389 946 |
| `FuzzParseManifest` | 5m32s | 19 324 462 |
| `FuzzMatchCommand` | 5m31s | 10 671 236 |
| `FuzzView` | 5m31s | 664 346 |
| `FuzzValidateView` | 5m31s | 1 505 141 |
| `FuzzViewMutate` | 5m31s | 372 432 |
| `FuzzPredicate` | 5m31s | 2 004 866 |
| `FuzzActValues` | 5m30s | 1 255 545 |
| `FuzzValidateEnvironment` | 5m30s | 3 295 919 |
| `FuzzManifestCommands` | 5m31s | 5 145 411 |
| `FuzzOwnedParams` | 5m31s | 4 710 540 |
| `FuzzParseIndex` | 5m31s | 8 732 179 |
| `FuzzVersion` | 5m31s | 1 627 508 |
| `FuzzParseLocation` | 5m31s | 5 784 304 |
| `FuzzFindChecksum` | 5m31s | 3 468 711 |
| `FuzzExtract` | 5m31s | 86 972 |
| `FuzzExtractBytes` | 5m31s | 478 572 |

Before that, while finding the bugs, most ran for a minute or so at a time.

## Bugs

Severity: **high** breaks something for every plugin or for the user's panel with a
plausible plugin; **medium** a bounded-by-nothing resource or a wedge a buggy or hostile
plugin or package can cause; **low** a validation hole or an inconsistency.

| # | Severity | Input | Failure | Fix |
|---|---|---|---|---|
| 1 | high | a plugin writes non-UTF-8 bytes to stderr (a crash dump, a latin-1 locale) or a stderr line over 16 KiB with multibyte text (the cut lands inside a rune) | the bytes reached the plugin's log lines and its last error; protobuf refuses invalid UTF-8 in `string` fields, so `PluginService.List` (every plugin, the Settings page, `plugin list`) and `plugin logs` failed until the line rotated out | `logBuffer.add` cuts on a rune boundary and replaces invalid bytes with U+FFFD; the actor does the same to the last error (`logs.go`, `actor.go`); `TestMisbehavingPlugins/binstderr`, `/garbage` |
| 2 | high | a valid view with an empty chips, pairs, actions, section, form or list node (a Go plugin's `ui.Chips{}`, `Section{}`), or with no `nodes` | the daemon's canonical JSON had `null` for those lists (`json:"rows"` without omitempty, nil slice); the GUI renderer reads them as arrays (`chips.findIndex`, `children.length`, `fields.map`, `items.map`) and the panel broke; no `nodes` read as "not a view" | `fillLists` before the canonical encoding makes every required list `[]` (`surface_act.go`); `FuzzValidateView` checks for null lists; seed `empty-lists-encode-as-null` |
| 3 | medium | 100 concurrent `thread/create` (or `terminal/create`) calls | each saw room under the limit (count, then create, no lock): 100 Claude threads for a limit of 32, 100 terminals for 16 | an actor mutex around count + create (`threads.go`, `terminals.go`, `actor.go`); `TestOwnedLimitsUnderConcurrency` |
| 4 | medium | `view/append` with 65 535 empty lines (64 KiB, the per-append limit), 512 times | the append ring (512 appends kept for watchers catching up) held 2 MiB per append: 1 GiB per surface instance | the ring is bounded by an estimated size too (4 MiB); a watcher further behind gets the whole view, as before (`surface.go`); `TestAppendRingIsBoundedByBytes` |
| 5 | medium | a peer floods notifications faster than `Notify` handles them (the daemon validates each `view/update`; a plugin's `OnEvent` may be slow) | the incoming notification queue grew without bound | at most 4096 notifications or 16 MiB wait; the rest are dropped and reported once per burst (`pluginsdk/jsonrpc.go`); `TestConnBoundsTheNotificationQueue`, `TestMisbehavingPlugins/flood` |
| 6 | medium | a peer floods requests whose handlers block | one goroutine per request, without bound | at most 64 requests in flight (`ConnOptions.MaxInflight`); the rest are answered at once with `CodeRateLimited`, reported once per burst; `TestConnBoundsRequestsInFlight` |
| 7 | medium | a handler's result over the line limit (a command answering more than 4 MiB) | `enqueue` refused it and nothing was sent: the caller waited out its whole timeout (up to 600 s for a command) | the answer becomes a `CodeInternal` error naming the limit; `ErrTooLong` is a typed error; `TestConnResultOverTheLineLimit`, `TestMisbehavingPlugins/hugeresult`, seed `result-over-line-limit` |
| 8 | medium | a release tarball with any number of PAX (or GNU long-name) headers before one entry | Go's tar reader merges consecutive meta headers into one `Next`, so the entry count and the file-size sum never moved: a ~10 MB download decompressed ~10 GB (measured 0.7 s per 500 MB), a 256 MiB one for minutes, before consent | the gzip stream is capped at `MaxUnpackedBytes` + 64 MiB (`registry/archive.go`); `TestExtractStopsAtTheDecompressionCap` |
| 9 | medium | `plugin.json` is a FIFO (in a plugin folder or a dev folder) | `os.ReadFile` blocked at open, forever, during discovery, with the store's operation lock held: enable, disable, reload, install hung (and a link to `/dev/zero` or a huge file was read whole) | `readManifest` reads only a regular file, at most 1 MiB (`manager.go`); `TestReadManifestRefusesFIFOsAndHugeFiles` |
| 10 | medium | a manifest arg `{"type": "int", "default": "many"}` (or a bool default `"maybe"`, a path default `"src"`) | `Validate` accepted it; the command registry parses defaults and refused the command, so `ReplacePrefix` refused the whole set: every command of the plugin stayed unregistered | `ArgSpec.validate` parses defaults as the registry does (`pluginsdk/manifest.go`); `FuzzManifestCommands`, seeds `int-arg-default-not-a-number`, `path-arg-default-relative` |
| 11 | low | a request with a field of the wrong type (`{"jsonrpc": 2, "id": 3, "method": "x"}`), or a response whose error object is malformed (`"code": "x"`) | the line was dropped as malformed: the request never got an answer, the matching call waited for its timeout | a line that decodes only partly (`UnmarshalTypeError`) still answers a request with `CodeInvalidRequest` and fails a pending call at once; `TestConnAnswersMalformedMessages`, seeds `request-with-wrong-type-jsonrpc`, `response-error-code-string` |
| 12 | low | a 1 MiB view of ~87 000 bad nodes, sent in a loop | `Validate` wrote a message per problem: 175 000 messages, 193 MB allocated and 390 ms per view | `Validate` names 50 problems and counts the rest; the UTF-8 walk builds paths only when a string is bad: 70 MB, 80 ms (`ui/validate.go`); `TestValidateFuzzFindings` |
| 13 | low | a Go plugin's view with invalid UTF-8 in a byte-limited field (event data 600 bytes of `\xff`, a log, a copy value) | the SDK's `Validate` accepted it; JSON turned each byte into `�` and the daemon refused the view as over the limit (the SDK and the daemon disagreed) | `Validate` refuses invalid UTF-8 in any string of the view, named by its JSON path; seed `event-data-invalid-utf8` |
| 14 | low | a secret input with `"store": "jenkins:token"` | the view validated (`KeyPattern` allows `:`), then every submit failed: the secret store's keys have no `:` | `ui.StorePattern` (`[A-Za-z0-9._-]{1,64}`) for `store`; `TestValidateFuzzFindings` |
| 15 | low | two fields of one name in a form (a text input and a secret, or across a fieldset) | the values are keyed by name: one field's value (and a secret's store) silently stood for the other's | `Validate` refuses a name used twice in one form; `TestValidateFuzzFindings` |
| 16 | low | an act with a 70 KB text field and a secret field with `store` | the secret was written to the Keychain, then the act was refused as over 64 KiB: the plugin never heard of it | the payload size is checked before any secret is stored (`surface_act.go`); `TestOversizeActStoresNoSecret` |
| 17 | low | a release URL `https://github.com/o/r/releases/download/--clobber/-O` in an index | the tag and asset went to `gh release download` as positional args and were read as flags | `ParseReleaseURL` refuses a tag or asset starting with `-` (the download then is a plain GET); seeds `release-tag-is-a-gh-flag`, `release-url-tag-is-a-gh-flag` |
| 18 | low | `session/setEnvironment` with 100 000 malformed keys (in a 4 MiB line) | 100 000 issues: each logged as its own line, all sent back in the answer (over the line limit, so before #7 the call never got one), all kept in the plugin's state | 32 issues and "… and N more" (`environment.go`); `FuzzValidateEnvironment` |
| 19 | low | `context/set` for many thread ids, each set then cleared; or with a megabyte thread id | an empty scope map was kept per id; ids of any size were kept | an emptied scope is dropped; ids over 256 bytes are refused (`facts.go`); `TestClearedFactScopesAreDropped` |
| 20 | low | `thread/create` with a 4 MB prompt; `terminal/create` with a million empty argv strings | the prompt had no limit (`thread/send` has 256 KiB); argv counted bytes only, so empty strings were free | the prompt has `MaxThreadMessage`; each argv entry counts its NUL; `TestOwnedLimitsUnderConcurrency` |
| 21 | medium | a plugin named `0` or `1password` (valid without commands) with a surface; or with neither | surfaces bring `plugin.<name>.show.<surface>` commands, and the registry refuses a prefix whose segment starts with a digit: no show commands, so the surfaces never opened; with neither, the empty registration still failed on the prefix and the plugin showed a "commands not registered" issue | `Validate` asks a command-segment name for surfaces too; registering nothing for such a name is a no-op (`pluginsdk/manifest.go`, `commands.go`); seeds `digit-name-with-surface`, `digit-name-no-commands` |
| 22 | medium | `input.pattern` `(a+)+$`, `(-[a-z]+)*`, or a 10 KB pattern | validated (RE2 compiles it), then the GUI's backtracking JavaScript could spend exponential time on a value: a typed value froze the window on blur or submit | `Validate` refuses a pattern over 256 characters or with a quantified group holding a `+`/`*` quantifier (`(…+)+`, `(…*)*`, `(…+)*`, `(…*)+`; escapes and classes skipped; conservative, so `^[a-z]+(-[a-z]+)*$` is refused too: check such values in the plugin) (`ui/validate.go`); `TestNestedQuantifier` |
| 23 | medium | a session environment (or a plugin thread's or terminal's env) with `DYLD_INSERT_LIBRARIES`, `LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONPATH`, `PERL5OPT`, `RUBYOPT`, `BASH_ENV`, `ENV`, `ZDOTDIR` or `SSH_ASKPASS` | accepted: code loaded into every process the thread starts (Claude itself, its tools, its shells) | refused as "loads code into every process the thread starts" (anything `DYLD_*`, `LD_*` and the eight names); `ANTHROPIC_*`, `AWS_*` stay allowed (`environment.go`); `TestValidateEnvironment` "keys that load code" |

Nothing panicked: every target ran its corpus and minutes of mutations without a panic
in the code under test. The predicate compiler held up: Go's RE2 has no backtracking,
`MaxPredicate` (1 KiB) bounds a pattern, and Go refuses nested repeats over 1000; the
slowest pattern measured (`[\x{0}-\x{10FFFF}]{1000}` against 1 KiB) evaluates in about
3 ms, compile in under 10 ms.

## Found, not fixed

* **A form pattern can freeze the GUI (ReDoS): mitigated, not solved.** `input.pattern`
  compiles in Go's RE2 but runs in JavaScript's backtracking `RegExp`: `(a+)+$` against 26
  `a`s and a `!` takes 3.5 s in V8, and each further `a` doubles it. The cheap mitigation
  is in (#22 below); a real fix needs the check in the daemon (RE2, linear) or a worker
  with a timeout in the GUI. The GUI already checks patterns only on blur and on submit
  (`FormNode`'s `blur` and `submit`; typing only clears an error), so no GUI change was
  needed for "on commit only".
* **The session environment keeps `ANTHROPIC_*` and `AWS_*` allowed.** A plugin with
  `sessionEnv` can point Claude at another API endpoint or other credentials. That is what
  the permission's consent text says ("add environment variables … to new Claude
  sessions"), and the expected enterprise auth plugin needs those keys. The keys that load
  code into every process a thread starts are reserved now (#23).
* **Plugin-side event drops are not resynced.** With the notification cap (#5), a Go
  plugin whose `OnEvent` falls 4096 events behind drops the rest (`pluginsdk: dropping
  notifications …` on its stderr, so in its log); the host's resync-after-drop covers only
  drops in the host's own queue. Blocking the reader instead would deadlock a handler that
  calls the host and waits for the answer the blocked reader would have read.
* **A request id over the line limit cannot be answered** (the answer echoes it). JSON-RPC
  ids are short; not worth a special case.
* **Duplicate field names across forms.** A click outside any form sends every field of
  the view, by name; two forms with a field of one name collide there (the last wins).
  Only names within one form are refused now.
* **Go's fuzz engine sometimes fails a clean run with "context deadline exceeded"** as
  `-fuzztime` ends (seen with `FuzzParseManifest` and `FuzzParseIndex`, no failing input
  written, not reproducible). `make fuzz` reports it and goes on.

## Gotchas

* Restacked (2026-10-18) onto `cf/plugins-13-skill-touchup`: #200 had bounded incoming
  JSON-RPC work too. The merge keeps #200's configurable `ConnOptions.MaxInflight` (64) and
  `MaxNotifications` (4096) and adds this PR's byte cap (`MaxNotifyQueue`, 16 MiB) and
  once-per-burst reporting; #200's case-insensitive reserved env keys now cover the
  code-loading keys too; #201's `ui.MaxActValues` check refuses an oversize act before
  this PR's payload cap, so `TestOversizeActStoresNoSecret` covers both.

* The fuzz targets' seeds read the hello demo's views and the real manifests by relative
  path (`../../internal/store/plugin/testdata/hello-demo`, `../plugins/examples/...`); in
  the nested `pluginsdk` module they are skipped when absent, so the module still tests on
  its own.
* Structured mutation needed a guard: inflating an array of an inflated array grows past
  any memory (the first `FuzzViewMutate` run hung the worker that way); one ×500 per input.
* `prettier` is not this repository's formatter (no config, 80 columns): do not run it on
  frontend files; `eslint` is.

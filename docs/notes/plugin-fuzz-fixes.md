# Plugin fuzz fixes (2026-10-21)

Fixes for findings 1, 2, 3 and 6 of the plugin fuzz report. Findings 4 (case-folded skill
names) and 5 (invalid UTF-8 argv) were left to other passes.

## 1. `plugin dev` / `plugin install <folder>` inside the plugins directory

`plugin dev --force` (or `install --force`) on `~/.code-foundry/plugins/<name>` moved the
package to staging, deleted it, and linked the name to its own (now missing) path.
`Dev` and `installLink` now refuse any folder inside the plugins directory, before the
`--force` check (`refuseInsidePlugins`, install.go). The message says the package
already runs from there, that `plugin restart <name>` picks up a rebuild, and that dev
mode needs the folder moved out. The plugins directory is resolved with EvalSymlinks
before the comparison (macOS temp dirs and any symlinked home), and `fsx.Within`
compares case-insensitively, like APFS. This also fixes the error that offered `--force`
with the same path twice: that case no longer reaches it.

## 2. Keychain secrets over ~2 KB

Measured on macOS 26 with a throwaway service: `security -i` reads a line of at most
4096 bytes, newline included, whole. A longer line is cut there and the rest is parsed
as another command, after the cut value has been stored. Set hex-encodes the value, so
the old 16 KiB cap could never hold. The longest add line (128-byte service, 64-byte
plugin name, 128-byte key) leaves 3739 hex characters, so `MaxSecretBytes` is now 1800.
`TestKeychainSetRefused` checks that sum. Set also refuses a line over 4096 bytes before
running `security`.

Set now treats any output from `security -i` (stdout or stderr) as a failure. A stored
value prints nothing. On failure it deletes the item it may have written, using a
non-cancelled context with a 10 s timeout, and returns "the Keychain refused the value
(N bytes)". It never quotes `security`, whose "unknown command" output echoes the value's
hex. On a rotation, a refused store therefore removes the old value too. That is better
than a cut value that looks valid.

`TestKeychainRoundTrip` (CF_TEST_KEYCHAIN=1) now stores a MaxSecretBytes value, plain and
non-ASCII, under the longest service and account, and checks that one byte more is
refused before `security` runs. No other storage path was tried: the Security framework
through cgo or splitting a value across items were not cheap enough for this pass. The
pluginsdk docs say nothing about the cap; the plugin skill's host-api.md does and now
says 1800 bytes.

## 3. Consent bound to what was shown

The consent dialog showed the dry run's consent text, but the confirmed run granted
whatever plugin.json said at that moment. The fix is a generic `Command.BindConfirm`:
the command names an optional String arg (`consent-digest` on `plugin.enable` and
`plugin.dev`), and Invoke's confirmation then carries
`Bind {arg: command.ConfirmDigest(message)}` (`ConfirmationRequired.bind` in the proto).
After a yes, the GUI (`invokeConfirmed`) and the interactive CLI merge the bind args into
the re-invoke, for the invoked command only. The plugin.act button path re-invokes
plugin.act, not the pressed command, so it carries no digest and behaves as before.

- The digest is over the consent text itself (`ConsentText`, plus the takeover sentence
  for `plugin dev --force`), so any change to what the dialog said invalidates the yes:
  permissions, version, exec, or what a takeover deletes. A change that only shrinks the
  permissions so that no consent is needed any more enables as usual.
- `bind` is a new field rather than reusing `args`, because clients treat `args` as a
  second stage. A second stage replaces the plugin consent dialog with the generic
  confirm dialog, and the CLI's no-terminal path would point at `--consent-digest`
  instead of `--yes`.
- The store checks the digest under `opMu` (`EnableShown`, `DevShown`), so the check and
  the grant are atomic. `Dev` re-reads plugin.json after linking (reloadLocked), so it
  passes enableLocked the digest of the manifest it checked, not the one the caller sent.
- `--yes` never sees a confirmation, so it sends no digest and consents to whatever the
  plugin asks, as before (scripts, agents).
- `plugin install <ref> --enable` was not changed: registry packages are bounded by their
  index entry's permissions.

## 6. FuzzViewMutate building a 1.5 GB view

The failing input wrapped the root in deep sections about 1,770 times (a 3 MB tree,
70,000 levels deep), then op 7 inflated it 500 times. `mutateView` now keeps an estimate
of the encoded size that only ever grows. It counts op 4's 70 KB strings, op 7's 499
copies (refused when they would pass twice the budget) and op 10's copies, and
mutation stops once the estimate passes `2*maxRawView`. Op 8 runs at most three times
(120 levels; `ui.MaxDepth` is 4). The input is committed as
`testdata/fuzz/FuzzViewMutate/deep-sections-nest-without-bound` and runs in about 30 ms.

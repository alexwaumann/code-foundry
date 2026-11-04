# Accessibility probe (2026-11-03)

A temporary check of what a system-wide "hold Alt, speak, paste into any app" dictation
depends on. It is not the feature: no settings, commands, UI or daemon changes.
`"Code Foundry" --accessibility-probe [--prompt]` opens no window and starts no daemon.

To remove it: delete `gui/accessibility_probe_darwin.go` and its test, the check in
`gui/main.go`, and `responsiblePid` and the `spawnDisclaimed` split in
`gui/responsible_darwin.go`. `gui/althold*.go` and `gui/paste*.go` are meant to stay for the
feature.

## Run it

Use a real terminal, and a scratch folder rather than `~/.code-foundry/app`, so the
installed app is left alone. Both builds go to the same path, as an update does.

1. **Install build A.** From this branch:

   ```
   make package VERSION=v0.0.1-probe.1
   mkdir -p ~/cf-probe/app
   tar -xzf dist/code-foundry-darwin-arm64.tar.gz -C ~/cf-probe/app
   codesign -dvvv ~/cf-probe/app/"Code Foundry" 2>&1 | grep CDHash=
   ```

   Keep the CDHash for step 6.

2. **Prompt.** `~/cf-probe/app/"Code Foundry" --accessibility-probe --prompt`. The line
   `responsible pid` must say `itself: true`; with `false` the terminal is being judged and
   nothing after it counts. A prompt should appear and the executable should get a row in
   the list the probe names (macOS 27: Device Control and Data Access; before it:
   Accessibility). This run also tries the tap, so a second prompt, for Input Monitoring,
   may follow: note whether it does. Ctrl-C if it is still running.

3. **Grant.** Turn the row on. If there is no row, add the executable with +
   (Cmd+Shift+G, then `~/cf-probe/app`). Leave Input Monitoring alone for now, unless step 2
   prompted for it and the step 4 tap then fails.

4. **Run without the prompt.** `~/cf-probe/app/"Code Foundry" --accessibility-probe`. Read
   the top lines, then click into a text field in another app (TextEdit, Notes) and watch
   the terminal.

5. **Test each item,** in that field, with something you can recognise on the clipboard:

   | Item | Do | Expect |
   | --- | --- | --- |
   | 1 Grant | read the top lines | `AXIsProcessTrusted: true` |
   | 3 Tap | hold left Alt 1 s, then right Alt 1 s | `alt down`/`alt up` with the side, `hold counted` |
   | 3 Tap | press both Alts together, hold 1 s | `alt both`, `hold counted ...: both` |
   | 3 Tap | tap Alt | `hold discarded: held N ms, under 300 ms`, no paste |
   | 3 Tap | Alt+Left, then Alt+E | `hold discarded: key N pressed`; the caret moves by a word, the dead key works: Alt still reaches the app |
   | 3 Tap | Alt, then Shift, during one hold | `hold discarded: Shift pressed during the hold` |
   | 4 Paste | a counted hold | `Code Foundry paste test <time>` lands in the field; then Cmd+V pastes your old clipboard again |
   | 4 Paste | hold Alt, click another app's window, release | `not pasting: the app in front changed` |

6. **Install a differently built B.** It differs by its version, so by its cdhash. Swap it
   in as the installer does, and check the CDHash is not step 1's:

   ```
   make package VERSION=v0.0.1-probe.2
   mkdir ~/cf-probe/app.new
   tar -xzf dist/code-foundry-darwin-arm64.tar.gz -C ~/cf-probe/app.new
   rm -rf ~/cf-probe/app && mv ~/cf-probe/app.new ~/cf-probe/app
   codesign -dvvv ~/cf-probe/app/"Code Foundry" 2>&1 | grep CDHash=
   ```

7. **Repeat without the prompt.** Run step 4 and step 5 again. Do not touch System Settings
   first. This is item 2.

8. **Optional: what the grant is keyed on.** `cp -R ~/cf-probe/app ~/cf-probe/moved` and run
   the probe from there. `AXIsProcessTrusted: true` means the identifier alone is enough;
   `false` means the path counts too, which is fine: updates keep the path.

9. **Clean up.** Remove the row with −, and `rm -rf ~/cf-probe`. All releases share this
   identity, so leaving the row may leave the installed app trusted as well.

## What each outcome means

* **Item 1.** `AXIsProcessTrusted: true` after the grant: a bare executable with the fixed
  identity works. No row and + refused, or a row that stays false: it does not, and the
  feature needs a bundle or a Developer ID. On a managed Mac, a greyed-out list means policy
  decides, not this build.
* **Item 2.** True in step 7 with no prompt, and the tap and paste still work: the grant
  survives updates, and this also settles the "not verified" point in `tcc-read-errors.md`
  for Accessibility. False, or a row that shows on while the probe says false: tccd keyed it
  to the build, so every update would need the row removed and added again.
* **Item 3.** Lines for each side: the tap works. `creation failed` with Accessibility true,
  or an Input Monitoring prompt in step 4, means Accessibility does not cover a listen-only
  tap and the feature needs a second grant: turn on Input Monitoring and rerun. `running`
  with no lines on any key means the tap was accepted but gets nothing, which is the same
  answer. Check first that the terminal's Secure Keyboard Entry is off and that the field is
  not a password field: secure input hides keys from every tap.
* **Item 4.** Only the text in the field proves it. macOS drops a refused `CGEventPost`
  without an error, so `Cmd+V posted` means nothing alone. If the text does not land while
  `CGPreflightPostEventAccess` is false, posting needs more than that grant gave; if it does
  not land while that is true, try another app before concluding anything. A line saying
  `clipboard left alone` means something else wrote to the clipboard first, usually a
  clipboard manager; that is the guard working.

`CGPreflightListenEventAccess` may stay false with a working tap. What the tap does is the
answer; that line only says which list holds the grant.

The exit code is 0 after a watch that ended by Ctrl-C or the 3 minutes, and 1 with no tap.

## Decisions

* **With nothing granted and no `--prompt`, the tap is not created, and the probe says so.**
  Creating one may itself bring up the Input Monitoring prompt, and without `--prompt` the
  probe must not prompt. Public reports disagree on what macOS does, and finding out here
  would have meant risking the prompt. So an actual refusal is only seen on `--prompt`
  runs and with Accessibility alone.
* **With Accessibility alone it does create the tap, even without `--prompt`.** That is the
  one case that might still prompt. Skipping it would stop the probe from testing whether
  that grant is enough, and it needs a grant the tester just gave.
* A hold runs from the first Alt down to the last Alt up. The second Alt after 80 ms counts
  as another key and discards the hold.
* Alt's state is read from each event's flags, not counted from edges, so a lost event is
  corrected by the next one. A disabled tap discards the hold in progress.
* Times are taken in the callback from `CLOCK_UPTIME_RAW`, not from `CGEventGetTimestamp`,
  to avoid depending on what unit that uses on Apple silicon.
* The callback writes 32-byte records to a non-blocking pipe, as the microphone does; a
  full pipe drops the record and the next one carries the count.
* Our own Cmd+V carries a mark in `kCGEventSourceUserData` and the callback skips it, or it
  would read as keys pressed during a new hold.
* Cmd+V is V down and up with the Command flag, with no Command key events, so a failure
  cannot leave Command held. A private event source keeps physical keys out of its flags.
* A paste blocks the probe's loop for about 650 ms. Events wait in the pipe with their
  times, so holds are still judged correctly, only printed late. It also means Ctrl-C during
  a paste still restores the clipboard.

## Gotchas for the feature

* NSWorkspace only updates `frontmostApplication` on the main run loop, per its docs. The
  probe has no NSApplication, so its main thread (Wails locks `main` there at init) turns
  the run loop every 20 ms. The real app has that loop already, but must read from the
  main thread.
* The V key is `kVK_ANSI_V`, a position: wrong on Dvorak and similar layouts.
* Reading the pasteboard to save it makes its owner render promised data, which could be
  slow for a large image. Types that give no data are counted and not restored.
* Hex also runs a tap health timer (taps can be disabled without notice) and opts out of
  App Nap. The probe does neither, since it runs for 3 minutes in a terminal; the feature
  will want both.
* Hex's rule stops at the release. The feature must start recording at the 300 ms mark, so
  it needs a timer that the state machine does not have yet.
* The fixed identity is forgeable (`tcc-read-errors.md`). With Accessibility on it, any
  local program signed with that identifier could post events and read keys. That is a
  bigger trade-off than file reads, and should be weighed before shipping the feature.

## Verification

Table tests, no cgo: `TestAltHold`, `TestPumpAltEvents`, `TestPasteText`,
`TestAccessibilityProbeArgs`, `TestAccessibilityListName`, `TestTapDecision`,
`TestAltReportLine`, `TestWaitExitCode`.

On this Mac (macOS 27.0.1), `make package VERSION=v0.0.1-probe.1`, unpacked to a scratch
folder, signature checked (`dev.alexwaumann.codefoundry`, the fixed requirement, 12 plist
entries), started from a session whose responsible process is another app:

```
Code Foundry accessibility probe
version: v0.0.1-probe.1
executable: /tmp/probe-a/Code Foundry
macOS: 27.0.1
responsible pid: 25280 (this process is 25280; itself: true)
AXIsProcessTrusted: false
CGPreflightListenEventAccess (Input Monitoring): false
CGPreflightPostEventAccess: false
the list: System Settings > Privacy & Security > Device Control and Data Access
event tap: not created: neither Accessibility nor Input Monitoring is granted, creating it could prompt, and only --prompt may prompt
```

Exit code 1, passed on by the waiting parent. No prompt, no daemon started, nothing written
to the scratch `CODE_FOUNDRY_HOME`. `--accessibility-probe --nope` is refused with 2. The
list's name was read from System Settings' own strings (`ACCESSIBILITY`, and `LISTEN_EVENT`
is still Input Monitoring).

A throwaway build with fake events and a fake pasteboard (not committed), respawn included:
the parent waits and passes on the exit code, the 3-minute limit fires (shortened), SIGTERM
to the parent and SIGINT to the group both stop it with exit 0, and with the parent killed
the child still ends at the limit. The real save, write and restore ran on a private named
pasteboard, never the general one: items and types came back whole, the transient marker
was there during the paste, and a write by someone else left the clipboard alone.

**Not verified, all of which needs a grant answered by hand:** a live tap (its C code has
only been compiled), real Alt events, a posted Cmd+V reaching an app, the general pasteboard,
`--prompt`, and items 1 to 4 themselves. Also not seen: frontmost changing while the run loop
turns, as no app switch happened during the check.

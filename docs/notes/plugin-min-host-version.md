# A plugin can require a minimum Code Foundry version

Until now the only compatibility check between a plugin and the app was the protocol
major. A plugin version that uses a host command, view node or SDK call a later Code
Foundry release added would install and update on an older app and then misbehave. A
plugin can now say the oldest Code Foundry it runs on, and the app never installs,
offers or starts a version it is too old for.

## The field

`minHostVersion` in `plugin.json` (`pluginsdk.Manifest.MinHostVersion`) and in a
registry entry (`registry.Entry.MinHostVersion`): strict semver without a leading v,
validated like `version`; absent means any. "Host" follows `pluginsdk.HostInfo`, which
already calls the app the host. A malformed value fails the manifest's validation, and an
index entry with one is skipped with an issue (as a malformed `version` is).

Tooling carries it through: `pack.MakeEntry` (and so `pluginpack -entry`) and the
example's `scripts/registry-entry.go` (the scaffold's) write it only when set, and
`MakeEntry` refuses tarballs of one version that disagree on it. The registry
repository's `scripts/validate.py`, which compares an entry with the tarball's
`plugin.json`, lives in that repository and does not check the new key yet: a follow-up
there, not here.

## The rule

`update.AtLeast(running, minimum)`, one function with a table test, beside the
updater's semver compare:

- an empty or malformed minimum is none;
- a running version that is not semver (`dev`, any unparsable build) satisfies anything:
  it is built from a checkout;
- a tip (`vX.Y.Z-tip.N`) counts as `X.Y.Z`: `next-version.sh --tip` makes X.Y.Z the stable
  that commit would become, so the tip already has everything a plugin needing X.Y.Z may
  use;
- otherwise semver precedence (an rc is older than its release).

The running version is `Options.HostVersion` (the daemon passes `internal/version`'s),
shown without its v in messages.

## Where it applies

- **Install** (`plugin install`, the Install button): a registry entry is refused from the
  index in `resolve`, before any download, as `ErrFailedPrecondition`:
  "needy 1.0.0 needs Code Foundry 0.31.0 or newer; this is 0.29.2". A GitHub release (and
  an older registry version, which comes from the releases) has no index to say so:
  `checkPackage` reads the downloaded manifest and returns a `*NeedsHostError`, which
  `install` reports with the same words (not "is not a valid package") before the swap;
  the staging folder goes with the work dir.
- **Updates**: `offerFor` is unchanged (the source decides what is offered); the offer
  carries `MinHost`, and `installInfo` files it as `Plugin.Update` or, when this app is too
  old, `Plugin.HeldUpdate` (the offer plus this app's version). A held offer is no update:
  no `update_available`, no Needs you group, Update all and `plugin update` pass over it;
  `CheckUpdates` lists it with `NeedsHost`/`Host`, and the CLI says
  "not offered: … (update Code Foundry first: code-foundry update)". `setMerged` compares
  the raw offer whichever field holds it, so a change between held and offered publishes.
- **Release installs' updates**: a release has no index entry, so `checkReleases` reads a
  newer release's manifest out of its tarball (`releaseMinHost`: resolve, download into a
  staging dir, verify the checksum when there is one, `registry.ReadManifest`, remove).
  It does so once per new version: the next check reuses the recorded `MinHost` when the
  version and ref are the same. A failure keeps the last answer, as a failed
  `LatestVersion` does, rather than offering a version it could not read.
- **Browse**: `BrowseEntry.NeedsHost`; the API sends `needs_host` and
  `update_available = relation UPDATE && !needs_host`. The relation stays the source's
  (the GUI still needs "not installed" vs "update" to place the caption).
- **Start**: the actor refuses a manifest needing a newer app as a permanent failure, next
  to the protocol check, with the same words. A dev link keeps its dev behaviour (it backs
  off and tries again rather than failing for good), as it does for a protocol mismatch.

## Proto

`PluginHostNeed {version, min_host_version, host_version}`; `Plugin.min_host_version`,
`Plugin.held_update`; `PluginIndexEntry.min_host_version`, `needs_host`;
`PluginUpdate.needs_host`, `host_version`. The host version travels in the message so the
GUI needs nothing else to say "You have 0.29.2".

## GUI

Variant A of the agreed sketch: where the row would have had Update (installed) or
Install/Update (Browse), muted caption text says what it needs ("1.4.0 needs Code Foundry
0.31.0", "Needs Code Foundry 0.31.0"); the details add "Version 1.4.0 needs Code Foundry
0.31.0 or newer. You have 0.29.2." and an "Update Code Foundry" link that runs
`app.update.check` (it opens the update dialog and checks: the existing flow). The rule
lives in `pluginMain` (a `held` main) and `entryAction` (`needs-host`); a dev link shows no
held update. Versions are shown as declared (0.31.0), not shortened to 0.31 as in the
sketch: trimming would be ambiguous with pre-releases.

The mock lists `deploy-board` and a `linear-sync` 1.4.0 needing 0.31.0 against its own
v0.1.0, so both states can be driven and are in the SHOTS spec.

## Checked end to end

A daemon built as v0.29.2 on a scratch home with a loopback registry: `plugin browse`
marks the entry, `plugin install needy` is refused with no tarball request in the server's
log, `plugin update --check` and `plugin update` hold syncer 0.2.0 and say why, and a dev
link needing 0.31.0 does not start ("cannot start: needy 1.0.0 needs …"). The GUI on the
same daemon (`make drive DAEMON=dev VERSION=v0.29.2`) shows the caption and the details,
and the link opens the update dialog.

## Gotcha

A `CODE_FOUNDRY_HOME` under the session scratchpad is too long for the daemon's socket
path (macOS allows 103 bytes): use a short `/tmp` dir for a scratch daemon.

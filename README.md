# Code Foundry

A macOS desktop app for running fleets of Claude Code sessions across git worktrees.
One daemon owns the sessions; the app and the `code-foundry` CLI are clients of it.

## Install

Requirements:

* macOS on Apple silicon
* the [GitHub CLI](https://cli.github.com) (`gh`), signed in: `gh auth login`
* [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) and `git` on your PATH

Then run:

```sh
gh release download --repo alexwaumann/code-foundry --pattern install.sh -O - | bash
```

The installer downloads the latest release, verifies its checksum, and:

* installs `CodeFoundry.app` into `~/Applications`
* links `~/.local/bin/code-foundry` to the CLI inside the bundle
* adds `~/.local/bin` to your PATH in `~/.zshrc`, once, if it is not already there

Open a new shell afterwards, then launch the app from `~/Applications` or with:

```sh
code-foundry gui
```

### Options

Download the script first to pass flags:

```sh
gh release download --repo alexwaumann/code-foundry --pattern install.sh
bash install.sh --help
```

| Flag | Effect |
|---|---|
| `--version vX.Y.Z` | install that release instead of the latest |
| `--yes` | never prompt |
| `--force` | reinstall even if that version is already installed |
| `--skip-path` | do not touch `~/.zshrc` |
| `--app-dir DIR` | where `CodeFoundry.app` goes (default `~/Applications`) |
| `--bin-dir DIR` | where the `code-foundry` link goes (default `~/.local/bin`) |

## Update

The app checks for new releases on its own and shows an update in the footer. Pick
**Code Foundry → Check for Updates…** to check now. Installing an update replaces the
bundle on disk; relaunch the app and restart the daemon from the update dialog to run it.

From a terminal:

```sh
code-foundry update
```

## Uninstall

```sh
rm -rf ~/Applications/CodeFoundry.app ~/.local/bin/code-foundry
```

State lives in `~/.code-foundry` (settings, database, logs, and the worktrees it created).
Remove it too if you want a clean slate.

## Developing

Requirements: an Apple silicon Mac with the Xcode Command Line Tools, Go 1.26 (go.mod's
toolchain directive fetches it), `pkg-config` (`brew install pkgconf`), and Node 24 with
pnpm. The GUI also needs `wails3`
(`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28`).

```sh
make build       # ./bin/code-foundry
make check       # what CI runs
make gui-build   # gui/bin/CodeFoundry.app
make gui-bin     # gui/bin/CodeFoundry only, no .app bundle (see below)
```

If your machine's management software blocks unsigned app bundles, use `make gui-bin`.
It builds only the bare executable and removes any `gui/bin/CodeFoundry.app`, and
`code-foundry gui` then launches the executable instead. That build is not a bundle, so
the in-app updater does not apply to it; everything else works.

No zig or ghostty checkout is needed: libghostty-vt is vendored prebuilt in
[third_party/libghostty-vt](third_party/libghostty-vt). `make ghostty-vt-rebuild` rebuilds
it from source and is only for bumping it
([docs/notes/vendored-libghostty-vt.md](docs/notes/vendored-libghostty-vt.md)).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PLAN.md](docs/PLAN.md), and
[CLAUDE.md](CLAUDE.md) for the rest of the build commands.

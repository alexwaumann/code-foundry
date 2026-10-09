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

* installs the app into `~/.code-foundry/app`: `code-foundry` (the daemon and CLI),
  `CodeFoundry` (the window) and a `VERSION` file
* links `~/.local/bin/code-foundry` to the CLI
* adds `~/.local/bin` to your PATH in `~/.zshrc`, once, if it is not already there

The app is two executables, not an `.app` bundle, because managed Macs often block
unsigned bundles. So it is not in `~/Applications` or Launchpad. Open a new shell
afterwards, then launch it with:

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
| `--skip-link` | do not create or replace the `code-foundry` link |
| `--app-dir DIR` | the app directory (default `~/.code-foundry/app`, or `$CODE_FOUNDRY_HOME/app`); it is replaced as a whole, so it must be a previous install or absent |
| `--bin-dir DIR` | where the `code-foundry` link goes (default `~/.local/bin`) |

## Update

The app checks for new releases on its own and shows an update in the footer. Pick
**Code Foundry → Check for Updates…** to check now. Installing an update replaces the
app directory the running daemon was started from; relaunch the app and restart the
daemon from the update dialog to run it.

From a terminal:

```sh
code-foundry update
```

## Uninstall

```sh
rm -rf ~/.code-foundry/app ~/.local/bin/code-foundry
```

The rest of `~/.code-foundry` is state (settings, database, logs, and the worktrees it
created). Remove it too if you want a clean slate.

Installed an earlier version as `CodeFoundry.app`? Quit it and remove
`~/Applications/CodeFoundry.app`; the installer replaces the old CLI link.

## Developing

Requirements: an Apple silicon Mac with the Xcode Command Line Tools, Go 1.26 (go.mod's
toolchain directive fetches it), `pkg-config` (`brew install pkgconf`), and Node 24 with
pnpm. The GUI also needs `wails3`
(`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28`).

```sh
make build       # ./bin/code-foundry
make check       # what CI runs
make gui-build   # gui/bin/CodeFoundry, a bare executable (no .app bundle)
```

`./bin/code-foundry gui` starts `gui/bin/CodeFoundry` and points it at that CLI. Dev
builds never check for updates.

`make build` also builds libghostty-vt from a pinned ghostty commit with a pinned zig,
both downloaded into the gitignored `third_party/` on first use (about a minute; needs
network access to ziglang.org, github.com and codeberg.org).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PLAN.md](docs/PLAN.md), and
[CLAUDE.md](CLAUDE.md) for the build commands.

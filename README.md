# Code Foundry

A macOS desktop app for running fleets of Claude Code threads across git worktrees.
One daemon owns the threads; the app and the `code-foundry` CLI are clients of it.

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
  `Code Foundry` (the window), `code-foundry-dictate` (the dictation engine) and a
  `VERSION` file
* links `~/.local/bin/code-foundry` to the CLI
* adds `~/.local/bin` to your PATH in `~/.zshrc`, once, if it is not already there

The app is three executables, not an `.app` bundle, because managed Macs often block
unsigned bundles. So it is not in `~/Applications` or Launchpad. Open a new shell
afterwards, then launch it with:

```sh
code-foundry gui
```

New to the app? Read the [getting started guide](docs/GETTING-STARTED.md), also in the app under **Help › Getting Started**.

### Options

Download the script first to pass flags:

```sh
gh release download --repo alexwaumann/code-foundry --pattern install.sh
bash install.sh --help
```

| Flag | Effect |
|---|---|
| `--channel stable\|tip` | which release is the latest (default `stable`; `tip` includes prereleases) |
| `--version vX.Y.Z` | install that release instead of the latest |
| `--yes` | never prompt |
| `--force` | reinstall even if that version is already installed |
| `--skip-path` | do not touch `~/.zshrc` |
| `--skip-link` | do not create or replace the `code-foundry` link |
| `--app-dir DIR` | the app directory (default `~/.code-foundry/app`, or `$CODE_FOUNDRY_HOME/app`); it is replaced as a whole, so it must be a previous install or absent |
| `--bin-dir DIR` | where the `code-foundry` link goes (default `~/.local/bin`) |

## Update

The app checks for new releases on its own, downloads a newer one in the background and
shows it at the bottom of the sidebar. Pick **Code Foundry → Check for Updates…** to
check now. **Restart Now** in the update dialog installs it and restarts the daemon and
the app together.

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

## Developing

Requirements: an Apple silicon Mac with the Xcode Command Line Tools, Go 1.26 (go.mod's
toolchain directive fetches it), `pkg-config` (`brew install pkgconf`), `cmake`
(`brew install cmake`), Node 24 and Bun 1.4.3 or newer (`bun check` is the frontend's type
checker). The GUI also needs `wails3`
(`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`).

```sh
make build       # ./bin/code-foundry and ./bin/code-foundry-dictate
make check       # what CI runs
make gui-build   # "gui/bin/Code Foundry", a bare executable (no .app bundle)
```

`./bin/code-foundry gui` starts `gui/bin/Code Foundry` and points it at that CLI. Dev
builds never check for updates.

`make build` also builds libghostty-vt from a pinned ghostty commit with a pinned zig on
first use (about a minute; needs network access to ziglang.org, github.com and
codeberg.org). The result lives in `~/Library/Caches/code-foundry/ghostty-vt/` and is
shared by every checkout and worktree; the downloads are deleted after the build. It
builds whisper.cpp, which `code-foundry-dictate` links, the same way from a pinned release
into `~/Library/Caches/code-foundry/whisper-cpp/`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CLAUDE.md](CLAUDE.md) for the build
commands; earlier design decisions are in [docs/notes](docs/notes) and the git history.

## License

Copyright 2026 Alejandro Waumann. Licensed under the [Apache License, Version 2.0](LICENSE).

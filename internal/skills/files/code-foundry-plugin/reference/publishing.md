# Publishing a plugin

A plugin ships as GitHub release tarballs listed in a registry: a git repository whose
`plugins/<name>.json` entries name each plugin's tarballs and their SHA-256 sums. The
public one is `alexwaumann/code-foundry-plugins`; a workplace may run its own with the
same layout in a private repository. Code Foundry configures no registry by default: a
user lists the ones they trust in the `plugins.registries` setting (`code-foundry settings
set plugins.registries https://github.com/alexwaumann/code-foundry-plugins`; several
separated by commas). Code Foundry installs from the registry for the user (download,
hash check, consent); the author's part ends with the registry pull request.

Do every step that publishes (creating the repository, pushing a tag, opening the
registry pull request) only after the user has said yes.

## The repository

`github.com/<owner>/code-foundry-plugin-<name>`, laid out like the example (and like
`alexwaumann/code-foundry-plugin-gh-actions` and `…-test-watcher`, which split a larger
plugin into files by concern: commands, surface, view, events, a poller or runner):

```
plugin.json          the manifest; its version is the release's
main.go, *_test.go   the plugin and its tests (testdata/ for captured payloads)
go.mod, go.sum       module github.com/<owner>/code-foundry-plugin-<name>, the SDK pinned
Makefile             build, test, dist, registry-entry
scripts/registry-entry.go   used by make registry-entry (build-ignored)
.gitignore           bin/, dist/, the binary `go build` names after the module
.github/workflows/ci.yml       go vet + go test -race on pushes to main and pull requests
.github/workflows/release.yml  tarballs + SHA256SUMS on a v<version> tag
README.md            the example's template filled in: what it does, how to install it,
                     its permissions and why, development
```

The example's files are already where the repository wants them (`.github/workflows/`
included), so a copy is the repository:

```
git init && git add -A && git commit -m "<name> 0.1.0"
gh repo create <owner>/code-foundry-plugin-<name> --public --source . --push
gh run watch --exit-status $(gh run list --workflow ci.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

When the user created the repository first, clone it, copy the example into the clone
(the skill's step 1: keep its LICENSE) and commit and push instead of `git init` and `gh
repo create`.

The workflows use `actions/checkout@v5` and `actions/setup-go@v6` on `ubuntu-24.04`
(cross-compiling for macOS; `go-version-file: go.mod`).

## Versions

- `version` in `plugin.json` is strict semver without a `v` (`0.1.0`, `0.2.0-rc.1`); the
  release tag is `v<version>`. The example also has it in `main.go` (`version`, for views
  and logs; `TestManifest` fails when the two differ). Bump both in the same commit as
  the change: patch for fixes,
  minor for features, major when commands, args or settings break.
- A version that asks for more permissions than the user granted disables the plugin on
  update until they consent again: say why in the release notes.

## The release

`release.yml` runs on a pushed `v*` tag: `go test ./...`, checks the tag equals `v` +
`plugin.json`'s version, runs `make dist`, and creates the GitHub release with the
tarballs and `SHA256SUMS`.

```
git commit -am "<name> 0.2.0" && git tag v0.2.0 && git push && git push origin v0.2.0
gh run watch --exit-status $(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh release view v0.2.0
```

`make dist` (run it locally first) builds, with `CGO_ENABLED=0`, one tarball per macOS
architecture: `dist/<name>-<version>-darwin-arm64.tar.gz` and `…-darwin-amd64.tar.gz`.
Each holds the package folder's contents **at its root**: `plugin.json` and the
executable `exec` names (`bin/<name>`), nothing else. Check one:

```
tar -tzf dist/<name>-<version>-darwin-arm64.tar.gz     # plugin.json, bin/<name>
```

A local `make dist` does not reproduce CI's tarballs byte for byte (another Go
toolchain, other file times), so the registry entry's hashes must come from the
release's own `SHA256SUMS`, never a local one. To try a release by hand, unpack it into a
folder **under the home directory** and `code-foundry plugin dev <folder> --yes`
(`plugin dev` refuses folders elsewhere, `/tmp` included; a plugin linked from another
folder before needs `--force`, which deletes that link's secrets, data and consent).

## The registry entry

After the release workflow finished:

```
make registry-entry          # REPO=owner/name if `gh repo view` cannot tell
```

downloads the release's `SHA256SUMS` and writes `dist/<name>.json`:

```json
{
  "name": "<name>",
  "displayName": "<displayName>",
  "description": "<description>",
  "repo": "<owner>/code-foundry-plugin-<name>",
  "version": "0.1.0",
  "protocol": 1,
  "permissions": {
    "commands": [], "events": [], "threadStatus": false, "sessionEnv": false,
    "secrets": false, "threads": false, "terminals": false, "api": false
  },
  "artifacts": {
    "darwin/arm64": {"url": "https://github.com/<owner>/code-foundry-plugin-<name>/releases/download/v0.1.0/<name>-0.1.0-darwin-arm64.tar.gz", "sha256": "…"},
    "darwin/amd64": {"url": "https://github.com/<owner>/code-foundry-plugin-<name>/releases/download/v0.1.0/<name>-0.1.0-darwin-amd64.tar.gz", "sha256": "…"}
  }
}
```

`name`, `version` and `permissions` (all eight keys) come from `plugin.json`, which the
registry's CI compares with the `plugin.json` inside each tarball. Then the pull request
(a branch if you can push to the registry, else a fork):

```
gh repo clone alexwaumann/code-foundry-plugins && cd code-foundry-plugins   # or: gh repo fork alexwaumann/code-foundry-plugins --clone
git switch -c add-<name>-0.1.0
cp <plugin repo>/dist/<name>.json plugins/<name>.json
python3 scripts/validate.py plugins/<name>.json      # what CI runs: downloads, hashes, reads plugin.json
git add plugins/<name>.json && git commit -m "Add <name> 0.1.0"
git push -u origin HEAD && gh pr create --repo alexwaumann/code-foundry-plugins --fill
```

The registry's CI downloads each tarball, checks the SHA-256, reads `plugin.json` from it,
checks that name, version and permissions match and that the `exec` file is in it. When
the pull request merges, `index.json` is regenerated, and users whose `plugins.registries`
lists the registry see the plugin in Browse and `code-foundry plugin browse`. Without the
registry configured, `code-foundry plugin install <owner>/<repo>` installs straight from
the release: it checks each tarball against the release's `SHA256SUMS` (or
`checksums.txt`, pluginpack's name; either is accepted) and later offers that
repository's newer releases as updates.

To try the install as a user would (`plugin install <owner>/<repo>`, the consent dialog),
remove a dev link first with `plugin uninstall <name> --purge`: without `--purge` the
consent, secrets and data stay and the reinstall asks nothing; installing the same name
from another source than before needs `--force`, which deletes them.

**Updating**: release the new version, `make registry-entry` again, and a pull request
replacing `plugins/<name>.json`. Users who installed from the repository directly are
offered the new release without the registry.

**Alternative packer.** Code Foundry versions with registry support also ship
`pluginsdk/cmd/pluginpack`
(`go run github.com/alexwaumann/code-foundry/pluginsdk/cmd/pluginpack@<pin> -out dist -repo <owner>/<repo> -entry dist/<name>.json darwin/arm64=<dir> darwin/amd64=<dir>`),
which packs built package folders into the same tarballs, writes `checksums.txt`
instead of `SHA256SUMS`, and the entry in one step (run it in the release workflow, so the
hashes are the release's). Either is accepted by the registry;
the example's `make dist` + `make registry-entry` needs nothing beyond this SDK version.

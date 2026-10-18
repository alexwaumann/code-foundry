# Publishing a plugin

A plugin ships as GitHub release tarballs listed in a registry. The default registry is
`alexwaumann/code-foundry-plugins`; a workplace may run its own with the same layout in a
private repository. Installing from a registry (`code-foundry plugin install <name>`:
download the tarball for the Mac, check its SHA-256, ask for consent before it runs)
arrives in a later Code Foundry version; check `code-foundry help plugin.install`. Until
then a user tries a plugin with `plugin dev` on a checkout or an unpacked tarball.

Do every step that publishes (creating the repository, pushing a tag, opening the
registry pull request) only after the user has said yes.

## The repository

`github.com/<owner>/code-foundry-plugin-<name>`, laid out like the example:

```
plugin.json          the manifest; its version is the release's
main.go, *_test.go   the plugin and its tests
go.mod, go.sum       module github.com/<owner>/code-foundry-plugin-<name>, the SDK pinned
Makefile             build, test, dist
.gitignore           bin/, dist/
.github/workflows/release.yml
README.md            what it does, its permissions and why, how to install
```

```
git init && git add -A && git commit -m "<name> 0.1.0"
gh repo create <owner>/code-foundry-plugin-<name> --public --source . --push
```

## Versions

- `version` in `plugin.json` is strict semver without a `v` (`0.1.0`, `0.2.0-rc.1`); the
  release tag is `v<version>`. Bump it in the same commit as the change: patch for fixes,
  minor for features, major when commands, args or settings break.
- A version that asks for more permissions than the user granted disables the plugin on
  update until they consent again: say why in the release notes.

## The release

The example's `.github/workflows/release.yml` runs on a pushed `v*` tag: `go test ./...`,
checks the tag equals `v` + `plugin.json`'s version, runs `make dist`, and creates the
GitHub release with the tarballs and `SHA256SUMS`.

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
cat dist/SHA256SUMS
```

The release asset URL is
`https://github.com/<owner>/code-foundry-plugin-<name>/releases/download/v<version>/<name>-<version>-darwin-arm64.tar.gz`.

## The registry entry

Add `plugins/<name>.json` to `alexwaumann/code-foundry-plugins` (a branch if you can
push there, else a fork):

```json
{
  "name": "<name>",
  "displayName": "<displayName from plugin.json>",
  "description": "<description from plugin.json>",
  "repo": "<owner>/code-foundry-plugin-<name>",
  "version": "0.1.0",
  "protocol": 1,
  "permissions": {
    "commands": [],
    "events": [],
    "threadStatus": false,
    "sessionEnv": false,
    "secrets": false,
    "threads": false,
    "terminals": false,
    "api": false
  },
  "artifacts": {
    "darwin/arm64": {
      "url": "https://github.com/<owner>/code-foundry-plugin-<name>/releases/download/v0.1.0/<name>-0.1.0-darwin-arm64.tar.gz",
      "sha256": "<from SHA256SUMS>"
    },
    "darwin/amd64": {
      "url": "https://github.com/<owner>/code-foundry-plugin-<name>/releases/download/v0.1.0/<name>-0.1.0-darwin-amd64.tar.gz",
      "sha256": "<from SHA256SUMS>"
    }
  }
}
```

- The file name is `<name>.json`; `name` and `version` equal the manifest's.
- `permissions` equals the manifest's block (missing keys read false or empty; write all
  eight so a reader sees them).
- `artifacts` needs `darwin/arm64`; add `darwin/amd64`. The sha256 values are the
  release's `SHA256SUMS` (download them with `gh release download v<version> -p SHA256SUMS -O -`).

```
gh repo clone alexwaumann/code-foundry-plugins && cd code-foundry-plugins   # or: gh repo fork alexwaumann/code-foundry-plugins --clone
git switch -c add-<name>-0.1.0
# write plugins/<name>.json
python3 scripts/validate.py plugins/<name>.json      # what CI runs: downloads, hashes, reads plugin.json
git add plugins/<name>.json && git commit -m "Add <name> 0.1.0"
git push -u origin HEAD && gh pr create --repo alexwaumann/code-foundry-plugins --fill
```

The registry's CI downloads each tarball, checks the SHA-256, reads `plugin.json` from it
and checks that name, version and permissions match and that the `exec` file is in it.
When the pull request merges, `index.json` is regenerated.

**Updating**: release the new version, then a pull request changing `version`,
`permissions` (if they changed) and both `artifacts` URLs and hashes in
`plugins/<name>.json`.

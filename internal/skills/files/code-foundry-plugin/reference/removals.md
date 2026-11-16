# The plugin SDK's removal list

{{cf.provenance}}

Calls on their way out of `pluginsdk`, from this Code Foundry's SDK (`removals.go` in
the module; `code-foundry plugin removals`, `--json` for the same as data). Rendered from
the list itself, so it is never out of date with this build.

## Stages

- **deprecated**: still works (the host may serve it another way). The Go symbol has a
  `Deprecated:` comment, so `go vet`-style tools and editors flag it; the plugin's log
  says once per run that it was called and what replaces it.
- **retired**: same signature, does nothing. The call logs a warning naming the
  replacement (once per process), and the host answers its protocol method without
  acting. A plugin still using it has silently lost the feature.
- **deleted**: gone from the SDK and from this list; a plugin using it no longer builds
  against a newer SDK. Only ever on the user's say, by date.

## The list

{{cf.removals}}

## Checking a plugin

Search its Go code for every symbol in a row (`grep -rnw 'SetFlag\|Flags()' --include=*.go .`
style, one pattern per symbol, the part after the last dot), or run `staticcheck ./...`,
which reports each use of a deprecated symbol (SA1019). For each hit, tell the user: the
call, its stage and since when, what replaces it, and offer to move it as part of the
work. Move it the way the row's "Move" says; the replacement's section in `host-api.md`
has the details.

# Plugin skill: publish to the user's registry (2026-10-18)

The plugin-authoring skill's step 10 sent every agent's registry pull request to
`alexwaumann/code-foundry-plugins`. Code Foundry configures no registry by default
(`docs/notes/plugins-7-registry.md`), so the skill now publishes only to a registry the
user configured or names, and stops when there is none.

## What changed

- `SKILL.md` step 10: read `code-foundry settings get plugins.registries`; one registry:
  a pull request to it; several: ask which; none: stop and tell the user what is left.
  The showcase line installs `alexwaumann/code-foundry-plugin-showcase` from its release
  (it said "once `plugins.registries` is configured", which assumed that registry). The
  frontmatter says "a" plugin registry, not "the". Two reference lines were merged to
  stay at the 120-line limit (`internal/skills/skills_test.go`).
- `reference/publishing.md`: the intro names no registry; "The registry entry" gains
  "Which registry" (the setting, its three spellings, the four cases, the
  install-from-release fallback, "do not change the setting unless asked") and "The pull
  request" with `<registry>` placeholders.
- The example's `Makefile` and `scripts/registry-entry.go` comments no longer name a
  registry (the skill ships them byte for byte, so an agent reads them).

## Reading the registries

No daemon change. `settings get plugins.registries` prints the stored value: the comma
list as typed (`owner/repo`, `https://github.com/owner/repo` or an index URL), an empty
line when none; `--json` adds the schema's description. `plugin browse` names each
registry with its plugins and errors, or prints the "no plugin registry is configured"
line; its `--json` has `registries[].url`, normalised, and only `{"platform": …}` when
none. The skill uses the setting: one line, no network, and it is what the user typed.

**"unknown setting" was not a bug.** Without `CODE_FOUNDRY_HOME` the dev CLI talked to
the daemon on `~/.code-foundry`, a dev build from 91dc68ed (before the plugin stack),
whose schema has no `plugins.*`. The CLI does not compare its version with the daemon's,
so skew shows up as whatever the old daemon says. Against an isolated daemon of this
build the key reads and writes as expected.

## Transcripts

Isolated daemon (`CODE_FOUNDRY_HOME=~/.cf-reg-home bin/code-foundry daemon --dev`, CLAUDE*
unset):

```
## none
$ code-foundry settings get plugins.registries

$ code-foundry plugin browse
no plugin registry is configured; add one with: code-foundry settings set plugins.registries https://github.com/<owner>/<repo>
## one
$ code-foundry settings set plugins.registries alexwaumann/code-foundry-plugins
plugins.registries = "alexwaumann/code-foundry-plugins"
$ code-foundry settings get plugins.registries
alexwaumann/code-foundry-plugins
$ code-foundry plugin browse
NAME          VERSION  INSTALLED  PERMISSIONS  DESCRIPTION
gh-actions    0.3.0    -          commands(…)  GitHub Actions runs, jobs and failed-step logs for the se...
showcase      0.2.0    -          commands(…)  Every plugin component in one gallery: each view node, fi...
test-watcher  0.3.0    -          commands(…)  Runs the project's tests in a thread's worktree whenever ...
registry https://github.com/alexwaumann/code-foundry-plugins: 3 plugin(s), fetched 2026-10-18 22:45 (cached)
## several
$ code-foundry settings set plugins.registries https://github.com/alexwaumann/code-foundry-plugins,acme/cf-registry
$ code-foundry settings get plugins.registries
https://github.com/alexwaumann/code-foundry-plugins,acme/cf-registry
```

`code-foundry plugin install alexwaumann/code-foundry-plugin-showcase` with no registry:
`installed showcase 0.2.0 from alexwaumann/code-foundry-plugin-showcase`.

Agent dry run: `claude -p --model claude-haiku-5-5 --effort medium` with the isolated
home's skills, told to do step 10 for a released `lint-watch` but run only `settings get`
and `plugin browse`:

- **None**: "lint-watch 0.1.0 is released (tag `v0.1.0`, the tarballs, and
  `dist/lint-watch.json` are ready), but it isn't listed in any registry yet. … To finish,
  name the registry repository to publish to (`<owner>/<repo>`), or add one with
  `code-foundry settings set plugins.registries <owner>/<repo-or-URL>` or in Settings →
  Plugins → Registries, then tell me. Until then, anyone can install it straight from
  the release with `code-foundry plugin install ada/code-foundry-plugin-lint-watch`."
- **One** (`ada-co/cf-plugins`): chose it ("the only configured registry, so the skill's
  rule sends the pull request there") and printed the recipe with `--repo
  ada-co/cf-plugins`.
- **Two**: "Which registry should the pull request go to?", recipe with `<registry>`.

None of the three runs mentioned `alexwaumann/code-foundry-plugins`.

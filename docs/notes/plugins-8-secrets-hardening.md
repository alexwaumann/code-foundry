# Plugins 8: secrets isolation and install hardening (2026-10-18)

A security pass over the plugin stack (PRs 1–7), focused on secrets. Based on
`cf/plugins-7-registry`; the orchestrator rebases it. Every claim below has a test or was
reproduced live (isolated `CODE_FOUNDRY_HOME` under the home directory, Keychain items
removed afterwards).

## Threat model

A plugin is an executable the user consented to; it runs **as the user**. That fixes what
the host can and cannot promise:

* A plugin can do anything the user's processes can: read `~/.code-foundry/daemon.token`,
  talk to `daemon.sock` (the CLI's socket, no token), run `code-foundry plugin secrets
  delete …`, or run `security find-generic-password` on the Keychain. **No plugin is
  sandboxed from another.** A malicious plugin is malicious software running as the user.
* So the boundaries the host enforces are about **the protocol and the host's own
  behaviour**, and about **consent**:
  1. **Per-plugin secret namespace through the protocol.** `secret/*` reaches only the
     calling plugin's items; no key, name or encoding reaches another plugin's.
  2. **Values flow host → owning plugin over stdio only.** The host never puts a secret
     value in argv, logs, events, views, RPC responses, the database or error text.
  3. **Consent before any code runs, and consent belongs to a source.** A package does
     not run, or inherit another package's consent, secrets or data, without the user
     agreeing to that specific package.
* Attackers considered: a buggy or careless plugin (misuses keys, leaks into its own
  views or logs); a hostile **package author** who has not run code yet (a registry
  entry, a release, a folder the user is about to `plugin dev`), who tries to land a
  package that inherits a trusted plugin's state; a hostile plugin that already runs
  (only the protocol boundary and resource limits apply to it; see "Accepted risks").

## Findings

| # | Attack | Result |
|---|---|---|
| 1 | `secret/get|set|delete` with `../other/key`, `other/key`, `/x`, `%2F`, empty, unicode, 129 chars, `\0`, `\n`, spaces, quotes | **Already safe** at the protocol (`checkSecretKey`), now also **enforced at the sink** (`keychainAccount`) |
| 1b | Account collision: `<plugin>/<key>` | **Already safe** (no `/` in a name or key), now a tested invariant |
| 1c | `security -i` command-line injection through a key or service (a newline is a second command) | **Fixed (defence in depth)**: the sink refuses any account or service that is not one word of the safe charset |
| 1d | Cross-home: an isolated `CODE_FOUNDRY_HOME` plugin of the same name reads or overwrites the real home's items | **Broken → fixed**: a Keychain service per non-default home |
| 1e | A stale item (database reset, earlier package) readable by a new plugin of the name | **Broken → fixed**: `secret/get` reads only keys recorded in this home's `plugin_secrets` |
| 2 | Name takeover: a release of another repository, another registry's entry, a dev link to another folder, or a reinstall from elsewhere after `uninstall` inherits consent, secrets and data | **Broken → fixed**: consent, secrets and data are bound to the install source; another source needs `--force`, which deletes them and asks for consent again |
| 2b | `plugin update` silently switching to another registry's entry of the name | **Broken → fixed**: a registry install is only offered updates by its own registry |
| 2c | A package replaced by hand inside `plugins/<name>` | **Accepted** (writing there already means running as the user) |
| 3 | `api` plugin calling `PluginService.DeleteSecret`, `Enable`, `Install` … | **Accepted, documented**: the API cannot tell a plugin from the user (same uid, same token, and the socket needs none); consent text now says so |
| 3b | Any RPC returning a secret value | **Already safe** (secrets RPCs carry names and times only) |
| 4a | Value in argv / `ps` | **Already safe**: `security -i`, value hex-encoded on stdin; now a test with a fake `security` asserts argv |
| 4b | Value in `security`'s error output, history file | **Already safe** (live: errors never echo the command line; `-i` writes no history) |
| 4c | Logs, `plugin logs`, bus events, surface act log | **Already safe** (keys only; tests grep for the value) |
| 4d | Session env values (a plugin pushing `GITHUB_TOKEN`) shown by `plugin env`, `PluginService.Environment` and Settings → Plugins | **Broken → fixed**: names only, everywhere |
| 4e | Session env and plugin thread env stored in SQLite (needed to respawn) | **Accepted** (`db.sqlite` is the user's, 0600 home); documented for plugin authors |
| 4f | Act path: form secrets GUI → daemon | **Already safe**: not logged, not in events, never echoed back (the GUI's secret input never shows a stored value; drafts are in memory only and cleared on submit) |
| 4g | A plugin rendering, logging or toasting its own secret, or passing it in a terminal's argv | **Accepted**: nothing can stop it; the skill says not to |
| 4h | `plugin act --values '{"token": …}'` from a shell | **Accepted**: the user's own argv; the GUI is the way to enter one |
| 5 | Keychain ACL | **Accepted, documented**: items trust only their creator, `/usr/bin/security` (not "all applications"), which means any process of the user can read them without a prompt (live test below) |
| 6a | `host/invoke` globs and `plugin.*` refusal | **Already safe** (`**` never reaches a management verb; reserved names cover every `plugin.*` verb) |
| 6b | Tarball extraction: zip-slip, absolute names, `..`, links, devices, FIFOs, setuid bits, duplicates, size and entry bombs | **Already safe**; added rows for backslash, FIFO, char device and setuid/sticky bits |
| 6c | `plugin dev` / link outside home through a symlink | **Already safe** (resolved before the check) |
| 6d | Data dir mode | **Already safe** (0700, root 0700) |
| 6e | `session/setEnvironment` reserved keys by case (`path`, `Home`, `code_foundry_x`) or whitespace (`PATH `) | Whitespace **already refused** (name pattern); case **broken → fixed** |
| 6f | `thread/create` / `terminal/create` cwd, `addDirs`, `pathPrepend` through a symlink under home pointing outside | **Broken → fixed** (checked on the resolved path) |
| 6g | `terminal/create` argv injection | **Already safe** (argv, not a shell string; NUL refused; 64 KiB cap) |
| 6h | `view/update` size, JSON-RPC line length | **Already safe** (256 KB view, 4 MiB line, 64 KiB act payload) |
| 6i | A plugin flooding requests (one goroutine each, `secret/get` forks `security` each) or notifications | **Broken → fixed**: at most 64 requests in flight per connection (more answered `-32005` at once), 4096 queued notifications |
| 6j | A plugin that never answers | **Already safe** (initialize 5 s, ping 30 s / 5 s twice, command and act timeouts, outbound queue cap) |

## Fixes

### Secrets namespace (`internal/store/plugin/secrets.go`, `host.go`, `db.go`)

* `keychainAccount(plugin, key)` builds every account and refuses a name outside
  `[a-z0-9][a-z0-9-]{0,63}` or a key outside `[A-Za-z0-9._-]{1,128}`, so the Keychain layer
  is safe whatever its caller checked (the management side passes a user-supplied name).
  `Set` also refuses a service that is not one word. Table test with the escape keys and
  an injectivity check; `TestKeychainArgv` runs a fake `security` and asserts the argv of
  all three calls (the value never appears; no `-A`, no `-T`).
* **Per-home service** (`KeychainServiceFor`): `code-foundry-plugin` for `~/.code-foundry`,
  `code-foundry-plugin-<sha256(home)[:12 hex]>` for any other `CODE_FOUNDRY_HOME`. Seen
  live during this audit: another agent's isolated home had left `showcase/random` under
  the plain service, i.e. in the real home's namespace.
* **Database-gated reads**: `secret/get` answers "not found" unless `plugin_secrets`
  records the key for this plugin. The database is the authority on what belongs to whom;
  purges iterate it, so an item it does not list can never be read back by a new plugin.
* `DeleteSecret` no longer reads the value just to learn whether it existed (it forked
  `security -g` and held the value in memory); the database row decides "not found", and
  the Keychain item is deleted either way (an orphan is cleaned).

### Install identity (`origin.go`, migration `0033_plugin_origin.sql`)

* `plugins.origin` records the source a plugin's consent, secrets and data dir belong to:
  `registry:<url>`, `github:<owner/repo>` (lower case), `path:<folder>` (a dev link), or
  `manual:<package dir>` (put in `plugins/` by hand, then enabled). The migration fills it
  from `dev_path`, else `plugin_installs`. Enabling with consent binds an empty one.
* `install` (before downloading, and again under `opMu`), `install <folder>` and `dev`
  call `checkOrigin`: the same origin, an unknown one, or nothing to inherit (no consent,
  no secrets, empty data dir) binds silently. Otherwise **refused** without `--force`,
  naming both sources and what would be inherited, and pointing at `--force` or
  `uninstall --purge`. With `--force`, `claimLocked` stops the plugin, `forget`s it (session
  env, flags, threads archived, terminals closed), deletes its secrets (Keychain then
  rows) and data dir, clears consent, and records the new origin. The install result
  carries a warning, the plugin log says "taken over by …", and the new package is **never
  enabled on the install's consent**: `--enable` comes back `needs_consent`.
* `plugin dev --force` (new arg, `DevPluginRequest.force`): the dry run the CLI uses for
  its confirm reports `needs_consent` and appends "It replaces the plugin X from the folder
  …: the consent you gave it and its 1 secret(s) in the Keychain will be deleted." to the
  consent text, so `--yes` is an explicit consent to the takeover.
* `offerFor` offers a registry install updates only from its own registry (as PR 7 did for
  GitHub installs), so adding a registry that lists the same name first, or the first one
  dropping it, never turns `plugin update` into a takeover.
* Choice: **delete, not rebind**. Keeping the secrets under a new source with a warning was
  the alternative; deleting is simpler to reason about and costs a re-entered token. It
  does cost a dev who switches a plugin between two checkouts: the second link needs
  `--force` and starts empty (the skill's publishing page says so).

### Leaks and limits

* `PluginService.Environment` never fills `PluginEnvVar.value` (proto comment says so);
  `plugin env` prints `env KEY`; Settings → Plugins lists names. The skill already told
  plugins not to push secrets; the host now does not display them if one does.
* Reserved session env keys compare upper-cased (`path`, `Home`, `code_foundry_token`,
  `Claude_Code_x` refused). zsh ties `path` to `PATH`; a tool reading variables
  case-insensitively would see the others.
* `withinHome` (environment.go) checks the cleaned path and then the symlink-resolved one
  against the resolved home: `pathPrepend`, `addDirs`, thread and terminal `cwd`.
* `pluginsdk.Conn`: `MaxInflight` (64) concurrent incoming requests, the rest answered
  `CodeRateLimited` immediately and reported through `OnIssue` (the plugin log);
  `MaxNotifications` (4096) queued notifications, the rest dropped. Both sides of the
  protocol get it (it is the SDK's Conn).
* Consent text for `api`: "full control of Code Foundry, including managing other plugins
  and deleting their secrets (it gets the daemon's endpoint and token)".

## Keychain ACL (live)

`security -i` with `add-generic-password -U -s <svc> -a p/k -X <hex>` (the daemon's call),
then `security dump-keychain -a`: the item's `decrypt` ACL lists one application,
`/usr/bin/security` (requirement `identifier "com.apple.security" and anchor apple`),
partition `apple-tool:`; it is not "allow all applications" (`-A`). From another shell,
`security find-generic-password -s <svc> -a p/k -w` printed the value with **no prompt**:
any process of the user can read every plugin's items, because they all trust the one
binary the daemon writes through.

Options weighed: `-T ""` makes the daemon's own reads prompt (it reads through the same
binary); `-T <daemon>` does not help while reads go through `security`; Security.framework
via cgo with an ACL naming only the daemon would make other processes prompt, but the
daemon is unsigned, so the ACL (by code hash) breaks on every update and prompts the user
each time, and a determined plugin can still prompt the user with a plausible dialog.
**Chosen: document.** The login Keychain is per user; the daemon cannot keep a value from
another process of the same user. The per-plugin namespace is a protocol guarantee, not
an OS one.

## Accepted risks

* Plugins are not sandboxed from each other or from the daemon (socket, token file,
  Keychain, the user's files). `api` adds convenience, not power. Peer-pid checks on the
  socket were considered and rejected: a plugin can read the token file or launch a
  process outside its tree.
* A plugin can leak its own secrets (views, logs, toasts, argv of its terminals, the
  session env its threads see). The host never does.
* Session env values and plugin thread env persist in `db.sqlite` (to respawn threads
  before the plugin pushes again).
* A package changed by hand inside `plugins/<name>` keeps that name's origin.
* `sessionEnv` can set `NODE_OPTIONS`, `ANTHROPIC_BASE_URL`, `DYLD_*` … for every Claude
  thread; the consent text says the plugin adds environment variables to new sessions.

## Later

* ~~**Owned threads survive a takeover**~~ **Done** (2026-10-18,
  `docs/notes/plugins-plugin-threads-remove.md`): a forced takeover and every uninstall
  remove the old package's threads through the thread store's `Remove` (no re-tagging),
  and threads alone count as something a new source would inherit.
* Native Keychain access with a daemon-only ACL once the binary is signed.
* A `plugin act` way to pass `--values` on stdin.
* Rate-limit the "refused … requests in flight" log line.

## Gotchas

* `gofmt` rewrites `''` in a doc comment to a typographic quote: say "empty".
* `make check`'s `go test -race` flaked twice on daemon start under load
  (`TestCLISettings`, `TestProjectServiceEndToEnd`: "daemon did not become ready"); both
  pass alone.
* `security dump-keychain -a` is the only CLI way to see an item's ACL (dump to a file
  and search; it lists no values without `-d`).

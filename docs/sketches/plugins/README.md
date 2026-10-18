# Plugin system: design package (2026-10-14)

Design package; build decisions of 2026-10-18 are in `DECISIONS.md`, which overrides the rest. Start here, then:

| File | What |
|---|---|
| `BRIEF.md` | The decisions made in conversation with Alex that the three pieces below were written against |
| `ARCHITECTURE.md` | Daemon, protocol, GUI, lifecycle, security, five-PR build order, ranked open questions |
| `PRIMITIVES.md` | The UI primitive catalog, view-model schema (replace + log append), events, both plugins' states as JSON |
| `DESIGN.md` + `index.html` + `shots/` | HTML mockups of the Jenkins tracker (6 states), the auth wizard (6 states) and the surface list, dark/light/280px, rendered from view-model data (screenshots regenerate with `shoot.mjs`; not committed) |

The three were written in parallel by separate agents from the brief. This file
reconciles where they diverged and merges their open questions.

## Reconciliation

**Primitive names.** `PRIMITIVES.md` is the canonical vocabulary; the mockup's data
files use earlier names. Mapping, and what the catalog adopts from the mockup:

| Mockup (`jenkins.js`, `auth.js`) | Catalog (`PRIMITIVES.md`) | Note |
|---|---|---|
| `fields` | `pairs` | rename only |
| `link` node | `open_url` button (`style: link`) or `url` on an inline span | the catalog cut the standalone node |
| `time` node | inline `time` span (`elapsed`, `relative`, `countdown`) | both invented it independently; the catalog's inline form wins so it can sit in header sub-lines and pair values |
| `code` node | `text {size: lg, mono, copyable}` | same rendering; no new node |
| `spinner` node | `progress {indeterminate, label, meta}` or a `running` glyph on a row | the catalog cut spinner |
| `checkbox` | `select {multiple, style: list}` | checkbox groups; the fieldset gap (DESIGN.md awkward spot 7) stays open |
| `button` as a free node | only inside `actions`, header, row, section, notice, empty, form | the mockup already only uses it inside `actions` |
| `divider` | cut | unused in every state |
| `section.stale` | **adopt** into the catalog | "last known" data when Jenkins is unreachable |
| `log` line `tone` (amber warning, red error lines) | **adopt** as per-line tone in v1; ANSI stays deferred | the mockup colours lines; the plugin picks a tone per line, the host never parses escapes |
| `header` as a pinned slot, body scrolls under it | same (`ViewHeader`) | agreed by both |

**Wire format.** `PRIMITIVES.md` §B sketches the view model as protobuf.
`ARCHITECTURE.md` §B.6 argues it should travel as JSON end to end (a `type`
discriminator and polymorphic inline content do not map to protojson), validated
generically by the daemon and typed in `src/api/plugin.ts`. Recommendation: JSON. The
proto sketch stays useful as the field-level spec.

**Where contributions are declared.** The brief said the initialize handshake;
`ARCHITECTURE.md` pushback 1 moves them to `plugin.json` so the host can show consent,
list commands and surfaces, and keep them listed while a plugin is crashed. Initialize
may narrow, never widen. Recommendation: accept.

**Thread status.** The brief said "needs-attention for free". `ARCHITECTURE.md` §C.6
makes it a flags overlay on the session (not the stream-owned status) and notes the
sidebar sort, line-2 reason and dock need small edits (PR 4). The mockup shows the
intended result (`shots/jenkins-failed-dark.png`: amber line 2, bell badge).

**Availability predicates.** The brief said "from data the host already has"; Jenkins
check URLs are not in the gh poll, so the predicate has one async fact. Evaluate on the
daemon through a `plugin.<name>.show.<surface>` command's `When` (§C.5).

## Open questions for Alex, merged and ranked

Decisions the build cannot start without:

1. **Contributions in the manifest** rather than the handshake (above). Accept?
2. **Token model:** proxy-only by default, an opt-in `api` permission hands over the
   normal endpoint and token, no scoped tokens in v1 (`ARCHITECTURE.md` §B.5). Accept?
3. **View model as JSON end to end,** not proto (above). Accept?
4. **`--mcp-config` on the work laptop:** does the managed settings profile let it
   through? Five-minute test before PR 5; the fallback is `claude mcp add --scope user`
   and an env-only hook.
5. **Consent model:** new plugins disabled until enabled through a permission dialog,
   re-consent when permissions grow.

Design rules the mockups assumed (change the mockups if you disagree):

6. **Emerald for `ok`** (as MCP "Connected" and PR checks) rather than strictly neutral.
7. **Neutral header icon** for every plugin; no identity hue (amber collides with
   "needs you").
8. **No filled button anywhere;** the state's main action is amber-outlined, wizard
   steps bordered, the rest muted. Or allow one filled primary per view?
9. **Destructive buttons** go through the host's command confirm dialog.
10. **Plugin tabs get no hotkey letter** in v1.
11. **Secret inputs inside a plugin view** (Jenkins token), or a host-owned Keychain
    dialog the plugin never sees?

Can wait until the PR that needs them:

12. "Send failure to Claude": send at once, confirm with the excerpt size, or draft into
    the composer? (PR 3)
13. Flag defaults: clear when seen vs sticky; attention flags ring the dock like a
    prompt? (PR 4)
14. Env hook for shells too, or sessions only? `allowedTools` contribution? (PR 5)
15. Plugin management in a Settings section with inline `settings` surfaces, vs a global
    Plugins panel surface. (PR 3)
16. Dedicated `WatchSurface` stream vs multiplexing over EventService. (PR 2)
17. Jenkins credentials in the Keychain via `security` vs a 0600 file. (example plugin)
18. Remote install source and update channel; `plugin.*` vs `plugins.*` namespace. (later)
19. Host-filled option lists (projects, threads) for selects. (PR 3)
20. Plugin-raised toasts outside a reply; tab-strip dots for background failures. (PR 3)
21. Log no-wrap option. (PR 3)

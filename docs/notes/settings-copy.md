# Settings descriptions: plainer copy

Every settings description (fields, sections, pages) was rewritten to lead with what the
setting does, in one or two short sentences, with implementation detail dropped
(`claude -p`, `git fetch --prune`, the daemon, upstreams). The source of truth is
`internal/store/settings/schema.go`; the e2e mock (`gui/frontend/mock/settings.ts`) and
the GUI-only Skills and Plugins pages (`guiPages.ts`) were updated to match.

Decisions
- Option labels are referenced by their visible names ("For Prefix and slug: …"), not the
  file values ("Prefix mode").
- Behaviour that only matters at the edge (untracked files and auto pull, the exact
  origin/<name> resolution for Branch from origin) was cut; the notes for those features
  still record it.
- Group descriptions only appear as comments in the TOML file and were left alone.

Gotchas
- `TestEmberDefaults` and one settings e2e assertion pin description prefixes; both were
  updated. The e2e `not.toContainText` on the effort description still guards that only the
  first field of a row shows its description.

# Step notes stay text

`docs/notes/` was 103 MB: 3 MB of markdown and 100 MB of PNG screenshots (310 files),
copied into every worktree. The markdown is the part that is not derivable from the code
(decisions, gotchas, rejected options). The screenshots duplicate what the PR bodies
already show.

## Decisions

* No new screenshots under `docs/notes/`. `.gitignore` blocks `docs/notes/**/*.png` and
  CLAUDE.md says where they go instead: the PR body, served from a shots branch or the
  PR's own commits, as every UI PR already does.
* The 93 PNGs that no note referenced are deleted. PR bodies link screenshots by shots
  branch or commit SHA, never by `main`, so nothing on GitHub breaks.
* The 217 PNGs that notes still reference stay; rewriting history is not worth it now
  that the per-worktree copies are gone (see `ghostty-vt-shared-cache.md`).

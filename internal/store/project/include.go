package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// A project's include patterns: the git-ignored files its file search lists too, on top
// of the files.include_ignored setting's (docs/notes/file-search-1-includes.md). Stored
// in project_include_ignored, one row per project that has any; the row goes with the
// project (ON DELETE CASCADE).

// CleanIncludes is fsx.CleanIncludePatterns with the store's error: ErrInvalidArgument
// with the same message.
func CleanIncludes(patterns []string) ([]string, error) {
	out, err := fsx.CleanIncludePatterns(patterns)
	if errors.Is(err, fsx.ErrInvalidArgument) {
		// Both sentinels read "invalid argument": keep the message, swap the sentinel.
		return nil, fmt.Errorf("%w%s", ErrInvalidArgument, strings.TrimPrefix(err.Error(), fsx.ErrInvalidArgument.Error()))
	}
	return out, err
}

// SetIncludeIgnored implements Store.
func (g *Git) SetIncludeIgnored(ctx context.Context, id string, patterns []string) (Project, error) {
	patterns, err := CleanIncludes(patterns)
	if err != nil {
		return Project{}, err
	}
	if len(patterns) == 0 {
		patterns = nil
	}
	// One write at a time, so the stored row and the meta cannot cross.
	g.renameMu.Lock()
	defer g.renameMu.Unlock()
	st := g.project(id)
	if st == nil {
		return Project{}, fmt.Errorf("%w: project %q", ErrNotFound, id)
	}
	if !slices.Equal(st.meta.Load().IncludeIgnored, patterns) {
		if err := g.storeIncludes(ctx, id, patterns); err != nil {
			return Project{}, err
		}
		g.mu.Lock()
		if g.projects[id] != st { // unregistered meanwhile (the cascade took the row)
			g.mu.Unlock()
			return Project{}, fmt.Errorf("%w: project %q", ErrNotFound, id)
		}
		next := *st.meta.Load()
		next.IncludeIgnored = patterns
		st.meta.Store(&next) // reconcile keeps them (keptIncludesLocked)
		g.mu.Unlock()
		g.log.Info("project include patterns set", "id", id, "patterns", len(patterns))
		g.commit(projectUpdated(id))
	}
	r, ok := g.Snapshot().Project(id)
	if !ok {
		return Project{}, fmt.Errorf("%w: project %q", ErrNotFound, id)
	}
	return r, nil
}

// storeIncludes writes id's row, or deletes it for no patterns. A project row that is
// gone (unregistered) is ErrNotFound: the foreign key refuses the insert.
func (g *Git) storeIncludes(ctx context.Context, id string, patterns []string) error {
	if len(patterns) == 0 {
		if _, err := g.db.ExecContext(ctx, `DELETE FROM project_include_ignored WHERE project_id = ?`, id); err != nil {
			return fmt.Errorf("project: include patterns of %s: %w", id, err)
		}
		return nil
	}
	data, err := json.Marshal(patterns)
	if err != nil {
		return fmt.Errorf("project: include patterns of %s: %w", id, err)
	}
	res, err := g.db.ExecContext(ctx, `INSERT INTO project_include_ignored (project_id, patterns)
		SELECT id, ? FROM projects WHERE id = ?
		ON CONFLICT (project_id) DO UPDATE SET patterns = excluded.patterns`, string(data), id)
	if err != nil {
		return fmt.Errorf("project: include patterns of %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: project %q", ErrNotFound, id)
	}
	return nil
}

// loadIncludes reads every project's patterns. A row that does not decode is logged and
// skipped: the project searches with the setting's patterns alone.
func (g *Git) loadIncludes(ctx context.Context) (map[string][]string, error) {
	rows, err := g.db.QueryContext(ctx, `SELECT project_id, patterns FROM project_include_ignored`)
	if err != nil {
		return nil, fmt.Errorf("project: load include patterns: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string][]string{}
	for rows.Next() {
		var id, data string
		if err := rows.Scan(&id, &data); err != nil {
			return nil, fmt.Errorf("project: load include patterns: %w", err)
		}
		var ps []string
		if err := json.Unmarshal([]byte(data), &ps); err != nil {
			g.log.Warn("include patterns do not decode; ignoring them", "project", id, "err", err)
			continue
		}
		out[id] = ps
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("project: load include patterns: %w", err)
	}
	return out, nil
}

// keptIncludesLocked is the patterns reconcile stores for a project whose metadata it
// read as prev: the current ones, which a SetIncludeIgnored since may have changed. g.mu
// is held.
func keptIncludesLocked(st *projectState, prev *projectMeta) []string {
	if cur := st.meta.Load(); cur != prev {
		return cur.IncludeIgnored
	}
	return prev.IncludeIgnored
}

package layout

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"time"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// Persistence for layout_spaces, layout_threads and layout_meta (migration 0061): one row
// per space (its position is its index in State.Spaces) and per thread with a ThreadState;
// meta holds rev, current_space and default_space.

const (
	metaRev          = "rev"
	metaCurrentSpace = "current_space"
	metaDefaultSpace = "default_space"
	// metaLegacyImport is "" until the first-load import ran, then "done:<unix ms>".
	metaLegacyImport = "legacy_import"
	// metaWindowTabs is, until the import, the JSON list of the thread tabs a window's
	// command opened (window.go); absent when there are none.
	metaWindowTabs = "legacy_window_tabs"
)

// marks are the import's own keys of layout_meta.
type marks struct {
	// imported is metaLegacyImport's value.
	imported string
	// windowTabs is metaWindowTabs' list.
	windowTabs []string
}

// stored is what the tables hold, decoded as far as it decodes.
type stored struct {
	state *core.State
	rev   uint64
	marks
	// fresh: no row in any of the tables (a new database).
	fresh bool
	// repairs are the documents that did not decode, kept as empty ones.
	repairs []string
}

// load reads the tables. A document that does not decode is replaced by an empty one and
// noted in repairs; only a database error fails.
func load(ctx context.Context, db *sql.DB) (stored, error) {
	out := stored{state: &core.State{V: core.Version}}
	rows, err := db.QueryContext(ctx, `SELECT id, name, doc FROM layout_spaces ORDER BY position, id`)
	if err != nil {
		return out, fmt.Errorf("layout: load spaces: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, name, doc string
		if err := rows.Scan(&id, &name, &doc); err != nil {
			return out, fmt.Errorf("layout: load spaces: %w", err)
		}
		sp, err := core.DecodeSpaceDoc(id, name, []byte(doc))
		if err != nil {
			out.repairs = append(out.repairs, fmt.Sprintf("space %s: %v; its panes are dropped", id, err))
			sp = &core.Space{ID: id, Name: name}
		}
		out.state.Spaces = append(out.state.Spaces, sp)
	}
	if err := rows.Err(); err != nil {
		return out, fmt.Errorf("layout: load spaces: %w", err)
	}
	rowsSeen := len(out.state.Spaces)

	trows, err := db.QueryContext(ctx, `SELECT thread_id, space_id, doc FROM layout_threads`)
	if err != nil {
		return out, fmt.Errorf("layout: load threads: %w", err)
	}
	defer func() { _ = trows.Close() }()
	for trows.Next() {
		var id, space, doc string
		if err := trows.Scan(&id, &space, &doc); err != nil {
			return out, fmt.Errorf("layout: load threads: %w", err)
		}
		ts, err := core.DecodeThreadDoc(space, []byte(doc))
		if err != nil {
			out.repairs = append(out.repairs, fmt.Sprintf("thread %s: %v; its stored tabs are dropped", id, err))
			ts = &core.ThreadState{Space: space}
		}
		if out.state.Threads == nil {
			out.state.Threads = map[string]*core.ThreadState{}
		}
		out.state.Threads[id] = ts
		rowsSeen++
	}
	if err := trows.Err(); err != nil {
		return out, fmt.Errorf("layout: load threads: %w", err)
	}

	mrows, err := db.QueryContext(ctx, `SELECT key, value FROM layout_meta`)
	if err != nil {
		return out, fmt.Errorf("layout: load meta: %w", err)
	}
	defer func() { _ = mrows.Close() }()
	for mrows.Next() {
		var k, v string
		if err := mrows.Scan(&k, &v); err != nil {
			return out, fmt.Errorf("layout: load meta: %w", err)
		}
		rowsSeen++
		switch k {
		case metaRev:
			n, err := strconv.ParseUint(v, 10, 64)
			if err != nil {
				out.repairs = append(out.repairs, fmt.Sprintf("rev %q: %v; now 0", v, err))
			}
			out.rev = n
		case metaCurrentSpace:
			out.state.CurrentSpace = v
		case metaDefaultSpace:
			out.state.DefaultSpace = v
		case metaLegacyImport:
			out.imported = v
		case metaWindowTabs:
			if err := json.Unmarshal([]byte(v), &out.windowTabs); err != nil {
				out.windowTabs = nil
				out.repairs = append(out.repairs, fmt.Sprintf("%s %q: %v; dropped", metaWindowTabs, v, err))
			}
		}
	}
	if err := mrows.Err(); err != nil {
		return out, fmt.Errorf("layout: load meta: %w", err)
	}
	out.fresh = rowsSeen == 0
	return out, nil
}

// save writes what changed from prev (what the tables hold) to next, rev, and the import's
// marks (the import mark when it is set; the window tabs, or none), in one transaction. A nil
// prev rewrites every row.
func save(ctx context.Context, db *sql.DB, prev, next *core.State, rev uint64, mk marks, now time.Time) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("layout: save: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	ms := now.UnixMilli()
	if prev == nil {
		for _, q := range []string{`DELETE FROM layout_spaces`, `DELETE FROM layout_threads`} {
			if _, err = tx.ExecContext(ctx, q); err != nil {
				return fmt.Errorf("layout: save: %w", err)
			}
		}
		prev = &core.State{}
	}
	for i, sp := range next.Spaces {
		pi := spaceIndex(prev, sp.ID)
		if pi == i && reflect.DeepEqual(prev.Spaces[pi], sp) {
			continue
		}
		doc, err := core.EncodeSpaceDoc(sp)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO layout_spaces (id, name, position, doc, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, position = excluded.position, doc = excluded.doc, updated_at = excluded.updated_at`,
			sp.ID, sp.Name, i, string(doc), ms); err != nil {
			return fmt.Errorf("layout: save space %s: %w", sp.ID, err)
		}
	}
	for _, sp := range prev.Spaces {
		if next.Space(sp.ID) == nil {
			if _, err = tx.ExecContext(ctx, `DELETE FROM layout_spaces WHERE id = ?`, sp.ID); err != nil {
				return fmt.Errorf("layout: delete space %s: %w", sp.ID, err)
			}
		}
	}
	for id, ts := range next.Threads {
		if reflect.DeepEqual(prev.Threads[id], ts) {
			continue
		}
		doc, err := core.EncodeThreadDoc(ts)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO layout_threads (thread_id, space_id, doc, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (thread_id) DO UPDATE SET space_id = excluded.space_id, doc = excluded.doc, updated_at = excluded.updated_at`,
			id, ts.Space, string(doc), ms); err != nil {
			return fmt.Errorf("layout: save thread %s: %w", id, err)
		}
	}
	for id := range prev.Threads {
		if _, ok := next.Threads[id]; !ok {
			if _, err = tx.ExecContext(ctx, `DELETE FROM layout_threads WHERE thread_id = ?`, id); err != nil {
				return fmt.Errorf("layout: delete thread %s: %w", id, err)
			}
		}
	}
	meta := map[string]string{
		metaRev:          strconv.FormatUint(rev, 10),
		metaCurrentSpace: next.CurrentSpace,
		metaDefaultSpace: next.DefaultSpace,
	}
	if mk.imported != "" {
		meta[metaLegacyImport] = mk.imported
	}
	if len(mk.windowTabs) > 0 {
		b, err := json.Marshal(mk.windowTabs)
		if err != nil {
			return fmt.Errorf("layout: save %s: %w", metaWindowTabs, err)
		}
		meta[metaWindowTabs] = string(b)
	} else if _, err = tx.ExecContext(ctx, `DELETE FROM layout_meta WHERE key = ?`, metaWindowTabs); err != nil {
		return fmt.Errorf("layout: save %s: %w", metaWindowTabs, err)
	}
	for k, v := range meta {
		if _, err = tx.ExecContext(ctx, `INSERT INTO layout_meta (key, value) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value`, k, v); err != nil {
			return fmt.Errorf("layout: save %s: %w", k, err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("layout: save: %w", err)
	}
	return nil
}

func spaceIndex(st *core.State, id string) int {
	for i, sp := range st.Spaces {
		if sp.ID == id {
			return i
		}
	}
	return -1
}

package layout

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// rows is every row of the layout tables, for comparing before and after.
func rows(t *testing.T, db *sql.DB) string {
	t.Helper()
	var b strings.Builder
	for _, q := range []string{
		`SELECT id, name, position, doc FROM layout_spaces ORDER BY id`,
		`SELECT thread_id, space_id, doc FROM layout_threads ORDER BY thread_id`,
		`SELECT key, value FROM layout_meta ORDER BY key`,
	} {
		r, err := db.Query(q)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := r.Columns()
		for r.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := r.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			fmt.Fprintln(&b, vals...)
		}
		_ = r.Close()
	}
	return b.String()
}

// A layout a newer build wrote (a document of a newer version, a tab or node this build does
// not know) is left as it is on disk: the store shows what it understands and saves nothing,
// so going back to the newer build finds its spaces, panes and remembered sets. Before, the
// store dropped what it did not understand and rewrote the rows.
func TestANewerBuildsLayoutIsNotWrittenOver(t *testing.T) {
	const good = `'{"v":1,"root":{"t":"pane","id":"p-1","tabs":[{"id":"t-1","kind":"prs"}],"active":"t-1"},"focus":"p-1"}'`
	tests := []struct {
		name string
		rows []string
	}{
		{"space doc of a newer version", []string{
			`INSERT INTO layout_spaces VALUES ('sp-a', 'Main', 0, ` + good + `, 1), ('sp-b', 'Two', 1, '{"v":2,"root":{"t":"pane","id":"p-2","tabs":[]}}', 1)`,
		}},
		{"thread doc of a newer version", []string{
			`INSERT INTO layout_spaces VALUES ('sp-a', 'Main', 0, ` + good + `, 1)`,
			`INSERT INTO layout_threads VALUES ('s-1', 'sp-a', '{"v":2,"remembered":{"tabs":[]}}', 1)`,
		}},
		{"a tab of a kind this build does not know", []string{
			`INSERT INTO layout_spaces VALUES ('sp-a', 'Main', 0, '{"v":1,"root":{"t":"pane","id":"p-1","tabs":[{"id":"t-1","kind":"prs"},{"id":"t-2","kind":"notebook","params":{"path":"/a"}}],"active":"t-2"},"focus":"p-1"}', 1)`,
		}},
		{"a remembered tab of a kind this build does not know", []string{
			`INSERT INTO layout_spaces VALUES ('sp-a', 'Main', 0, ` + good + `, 1)`,
			`INSERT INTO layout_threads VALUES ('s-1', 'sp-a', '{"v":1,"remembered":{"pane":"p-1","tabs":[{"tab":{"id":"t-9","kind":"notebook","thread":"s-1"},"pane":"p-1","index":0}]}}', 1)`,
		}},
		{"a node of a type this build does not know", []string{
			`INSERT INTO layout_spaces VALUES ('sp-a', 'Main', 0, '{"v":1,"root":{"t":"stack","id":"k-1","kids":[{"t":"pane","id":"p-1","tabs":[{"id":"t-1","kind":"prs"}],"active":"t-1"}]},"focus":"p-1"}', 1)`,
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := dbtest.Open(t)
			for _, q := range append(tt.rows, `INSERT INTO layout_meta VALUES ('rev', '7'), ('current_space', 'sp-a'), ('default_space', 'sp-a')`) {
				if _, err := db.Exec(q); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			before := rows(t, db)
			var log bytes.Buffer
			m := open(t, db, nil, &log)
			if len(m.Snapshot().Newer) == 0 {
				t.Fatalf("Newer is empty; log:\n%s", log.String())
			}
			if err := core.Check(m.Snapshot().State); err != nil {
				t.Fatalf("the state shown is not in normal form: %v", err)
			}
			if !strings.Contains(log.String(), "a newer build wrote the stored layout") {
				t.Errorf("not logged:\n%s", log.String())
			}
			// It works in memory, and writes nothing: not a change, not the focus, not on close.
			sp := apply(t, m, &core.NewSpace{Name: "Mine", Switch: true}).Result.Space
			apply(t, m, &core.OpenSurface{Space: sp, Tab: file("/x"), Focus: true})
			if err := m.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			if after := rows(t, db); after != before {
				t.Errorf("the rows changed:\nbefore\n%s\nafter\n%s", before, after)
			}
			m2 := open(t, db, nil, nil)
			if len(m2.Snapshot().Newer) == 0 || m2.Snapshot().State.Space(sp) != nil {
				t.Errorf("reopened: newer %v, space %s %v", m2.Snapshot().Newer, sp, m2.Snapshot().State.Space(sp))
			}
		})
	}
}

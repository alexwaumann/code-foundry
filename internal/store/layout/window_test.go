package layout

import (
	"context"
	"database/sql"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// A thread tab a window's command opens before the import is kept in layout_meta, survives a
// restart, and the import closes it: the first load is empty. The CLI's own open is not kept.
// After the import nothing is kept and the key is gone.
func TestWindowTabsBeforeTheImport(t *testing.T) {
	ctx := context.Background()
	db := dbtest.Open(t)
	m := open(t, db, nil, nil)
	window := FromWindow(ctx)
	c, err := m.Apply(window, &core.OpenThread{Thread: "s-1", Focus: true}, ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got := metaValue(t, db, metaWindowTabs); got != `["`+c.Result.Tab+`"]` {
		t.Fatalf("%s = %s", metaWindowTabs, got)
	}
	if err := m.Close(ctx); err != nil {
		t.Fatal(err)
	}

	m = open(t, db, nil, nil)
	if len(m.windowTabs) != 1 || m.windowTabs[0] != c.Result.Tab {
		t.Fatalf("after a restart %v", m.windowTabs)
	}
	ic, err := m.ImportLegacy(ctx, core.LegacyInput{Threads: []core.LegacyThread{{ID: "s-1"}}}, ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if m.Snapshot().State.Spaces[0].Root != nil || len(ic.Result.Removed) != 1 {
		t.Fatalf("after the import: %+v, removed %v", m.Snapshot().State.Spaces[0].Root, ic.Result.Removed)
	}
	if n := metaCount(t, db, metaWindowTabs); n != 0 {
		t.Errorf("%s still stored", metaWindowTabs)
	}
	// After the import a window's open is the user's arrangement: nothing is kept.
	if _, err := m.Apply(window, &core.OpenThread{Thread: "s-1", Focus: true}, ApplyOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(m.windowTabs) != 0 || metaCount(t, db, metaWindowTabs) != 0 {
		t.Errorf("kept after the import: %v", m.windowTabs)
	}
}

// The CLI focusing a tab a window opened changes nothing in the layout (it has the focus
// already) but makes it the user's: the list is written without it.
func TestWindowTabsTheCLIArranges(t *testing.T) {
	ctx := context.Background()
	db := dbtest.Open(t)
	m := open(t, db, nil, nil)
	c, err := m.Apply(FromWindow(ctx), &core.OpenThread{Thread: "s-1", Focus: true}, ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply(ctx, &core.FocusTab{Tab: c.Result.Tab}, ApplyOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(m.windowTabs) != 0 || metaCount(t, db, metaWindowTabs) != 0 {
		t.Errorf("still kept: %v", m.windowTabs)
	}
	ic, err := m.ImportLegacy(ctx, core.LegacyInput{Threads: []core.LegacyThread{{ID: "s-1"}}}, ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if m.Snapshot().State.Spaces[0].Root == nil || len(ic.Result.Removed) != 0 {
		t.Errorf("the import closed the CLI's arrangement")
	}
}

func metaCount(t *testing.T, db *sql.DB, key string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM layout_meta WHERE key = ?`, key).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

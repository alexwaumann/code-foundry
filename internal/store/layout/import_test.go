package layout

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

func legacyInput() core.LegacyInput {
	return core.LegacyInput{
		Panel: []byte(`{"version":6,"state":{"byKey":{"thread:s-1":{"open":true,"groups":[{"tabs":[
			{"id":"mcp","kind":"mcp","title":"MCP","params":{}}],"activeTabId":"mcp"}]}}}}`),
		Bottom:  []byte(`{"version":1,"state":{"byKey":{"thread:s-1":{"open":true,"height":250}}}}`),
		Threads: []core.LegacyThread{{ID: "s-1"}},
		Terminals: []core.LegacyTerminal{
			{ID: "t-a", Labels: map[string]string{"kind": "shell", "thread": "s-1"}, StartedAt: time.Unix(1, 0)},
			{ID: "t-b", Labels: map[string]string{"kind": "shell", "thread": "s-1"}, StartedAt: time.Unix(2, 0)},
		},
	}
}

func TestImportLegacyOnce(t *testing.T) {
	db := dbtest.Open(t)
	b := bus.New()
	events := bus.Subscribe[Event](b, 8)
	defer events.Close()
	m := open(t, db, b, nil)
	ctx := context.Background()
	if m.Snapshot().LegacyImported {
		t.Fatal("a new database is imported already")
	}
	c, err := m.ImportLegacy(ctx, legacyInput(), ApplyOptions{ClientID: "w-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !c.Imported || c.Rev != 1 || c.Result.Quick["s-1"] != "t-a" {
		t.Fatalf("commit %+v", c)
	}
	ev := <-events.C()
	if ev.Rev != 1 || ev.Op != ImportOp || ev.ClientID != "w-1" || !ev.Delta.LegacyImported || len(ev.Delta.Threads) != 1 {
		t.Errorf("event %+v", ev)
	}
	if len(ev.Result.Closed)+len(ev.Result.Ended) != 0 {
		t.Errorf("the import's event asks the glue to end terminals: %+v", ev.Result)
	}
	snap := m.Snapshot()
	ts := snap.State.Threads["s-1"]
	if !snap.LegacyImported || ts == nil || len(ts.Remembered.Tabs) != 2 || ts.Quick == nil || !ts.Quick.Open || ts.Quick.Height != 250 {
		t.Fatalf("snapshot %+v, thread %+v", snap, ts)
	}
	if v := metaValue(t, db, metaLegacyImport); !strings.HasPrefix(v, "done:") {
		t.Errorf("legacy_import %q", v)
	}

	// A second call changes nothing and publishes nothing.
	c2, err := m.ImportLegacy(ctx, legacyInput(), ApplyOptions{})
	if err != nil || c2.Imported || c2.Rev != 1 {
		t.Fatalf("second import %+v, %v", c2, err)
	}
	if m.Snapshot() != snap {
		t.Error("the second import changed the snapshot")
	}
	select {
	case ev := <-events.C():
		t.Errorf("second import published %+v", ev)
	default:
	}

	// The mark survives a restart, and later commits carry it.
	if err := m.Close(ctx); err != nil {
		t.Fatal(err)
	}
	m2 := open(t, db, b, nil)
	if !m2.Snapshot().LegacyImported || m2.Snapshot().Rev != 1 {
		t.Fatalf("reopened %+v", m2.Snapshot())
	}
	if c3, err := m2.ImportLegacy(ctx, legacyInput(), ApplyOptions{}); err != nil || c3.Imported {
		t.Fatalf("import after a restart %+v, %v", c3, err)
	}
	apply(t, m2, &core.NewSpace{Name: "Two"})
	if ev := <-events.C(); !ev.Delta.LegacyImported {
		t.Errorf("a later delta lost the mark: %+v", ev.Delta)
	}
}

func TestImportLegacyFreshInstallIsACommit(t *testing.T) {
	db := dbtest.Open(t)
	m := open(t, db, nil, nil)
	before := m.Snapshot().State
	c, err := m.ImportLegacy(context.Background(), core.LegacyInput{}, ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	snap := m.Snapshot()
	if !c.Imported || c.Rev != 1 || !snap.LegacyImported || len(snap.State.Spaces) != 1 || snap.State.Spaces[0].Root != nil || len(snap.State.Threads) != 0 {
		t.Fatalf("commit %+v snapshot %+v", c, snap)
	}
	if !Unchanged(before, snap.State) {
		t.Error("a fresh install's import changed the layout")
	}
}

func TestImportLegacyWritesWaitingFocus(t *testing.T) {
	db := dbtest.Open(t)
	m := open(t, db, nil, nil)
	ctx := context.Background()
	apply(t, m, &core.NewSpace{Name: "Two"})
	apply(t, m, &core.SwitchSpace{Space: "sp-n2"}) // focus-only: waits
	if _, err := m.ImportLegacy(ctx, core.LegacyInput{}, ApplyOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := metaValue(t, db, metaCurrentSpace); got != "sp-n2" {
		t.Errorf("current_space %q after the import's write", got)
	}
	if got := metaValue(t, db, metaRev); got != "3" {
		t.Errorf("rev %q", got)
	}
}

func TestImportLegacyAfterClose(t *testing.T) {
	m := open(t, dbtest.Open(t), nil, nil)
	_ = m.Close(context.Background())
	if _, err := m.ImportLegacy(context.Background(), core.LegacyInput{}, ApplyOptions{}); err != ErrClosed {
		t.Errorf("err %v, want ErrClosed", err)
	}
}

package layout

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// open is New on db with the test case ids, a long focus delay (tests flush by hand) and
// the log in buf when given.
func open(t *testing.T, db *sql.DB, b *bus.Bus, buf *bytes.Buffer) *Manager {
	t.Helper()
	opts := Options{DB: db, Bus: b, IDs: &core.SeqIDs{}, FocusDelay: time.Hour}
	opts.Log = slog.New(slog.DiscardHandler)
	if buf != nil {
		opts.Log = slog.New(slog.NewTextHandler(buf, nil))
	}
	m, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close(context.Background()) })
	return m
}

func apply(t *testing.T, m Store, op core.Op) Commit {
	t.Helper()
	c, err := m.Apply(context.Background(), op, ApplyOptions{})
	if err != nil {
		t.Fatalf("%s: %v", op.OpName(), err)
	}
	return c
}

func file(path string) *core.Tab {
	return &core.Tab{Kind: "file", Params: map[string]string{"path": path}}
}

func metaValue(t *testing.T, db *sql.DB, key string) string {
	t.Helper()
	var v string
	if err := db.QueryRow(`SELECT value FROM layout_meta WHERE key = ?`, key).Scan(&v); err != nil {
		t.Fatalf("meta %s: %v", key, err)
	}
	return v
}

func TestNewDatabaseGetsOneSpace(t *testing.T) {
	db := dbtest.Open(t)
	var log bytes.Buffer
	m := open(t, db, nil, &log)
	snap := m.Snapshot()
	if snap.Rev != 0 || len(snap.State.Spaces) != 1 || snap.State.Spaces[0].Name != FirstSpaceName || snap.State.Spaces[0].Root != nil {
		t.Fatalf("snapshot %+v; want rev 0 and one empty space %q", snap, FirstSpaceName)
	}
	sp := snap.State.Spaces[0].ID
	if snap.State.CurrentSpace != sp || snap.State.DefaultSpace != sp {
		t.Errorf("current %q default %q; want %q", snap.State.CurrentSpace, snap.State.DefaultSpace, sp)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM layout_spaces WHERE id = ? AND name = ? AND position = 0`, sp, FirstSpaceName).Scan(&n); err != nil || n != 1 {
		t.Errorf("space row: %d, %v", n, err)
	}
	if got := metaValue(t, db, metaDefaultSpace); got != sp {
		t.Errorf("default_space %q; want %q", got, sp)
	}
	if bytes.Contains(log.Bytes(), []byte("level=WARN")) {
		t.Errorf("a new database logged a warning:\n%s", log.String())
	}
	// Opening again finds the same space, unchanged.
	if err := m.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	m2 := open(t, db, nil, nil)
	if got := m2.Snapshot(); got.Rev != 0 || !reflect.DeepEqual(got.State, snap.State) {
		t.Errorf("reopened: %+v; want %+v", got.State, snap.State)
	}
}

func TestApplyPersistsAndReloads(t *testing.T) {
	db := dbtest.Open(t)
	m := open(t, db, nil, nil)
	apply(t, m, &core.AddTab{Tab: file("/r/a.go"), Focus: true})
	c := apply(t, m, &core.SplitPane{Pane: "p-n1", Edge: core.Right, Tab: &core.Tab{Kind: "prs"}, Frac: 0.4})
	if c.Result.Pane == "" || c.Result.Tab == "" {
		t.Fatalf("split result %+v", c.Result)
	}
	apply(t, m, &core.NewSpace{Name: "Review"})
	c = apply(t, m, &core.RenameSpace{Space: "sp-n2", Name: "Later"})
	if c.Rev != 4 || !c.Changed {
		t.Fatalf("commit %+v; want rev 4", c)
	}
	want := m.Snapshot()
	if err := m.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := metaValue(t, db, metaRev); got != "4" {
		t.Errorf("rev on disk %s; want 4", got)
	}
	m2 := open(t, db, nil, nil)
	got := m2.Snapshot()
	if got.Rev != 4 || !reflect.DeepEqual(got.State, want.State) {
		t.Errorf("reloaded rev %d %+v; want rev 4 %+v", got.Rev, got.State, want.State)
	}
	// Revs go on from the stored one.
	if c := apply(t, m2, &core.SwitchSpace{Space: "sp-n2"}); c.Rev != 5 {
		t.Errorf("next rev %d; want 5", c.Rev)
	}
}

func TestOneEventPerCommit(t *testing.T) {
	db := dbtest.Open(t)
	b := bus.New()
	sub := bus.Subscribe[Event](b, 16)
	defer sub.Close()
	m := open(t, db, b, nil)
	ctx := context.Background()

	c, err := m.Apply(ctx, &core.NewSpace{Name: "Two", Switch: true}, ApplyOptions{ClientID: "win-1"})
	if err != nil {
		t.Fatal(err)
	}
	ev := <-sub.C()
	if ev.Rev != 1 || c.Rev != 1 || ev.ClientID != "win-1" {
		t.Fatalf("event rev %d client %q, commit %d; want 1, win-1, 1", ev.Rev, ev.ClientID, c.Rev)
	}
	d := ev.Delta
	if len(d.Spaces) != 1 || d.Spaces[0].ID != c.Result.Space || len(d.Order) != 2 || d.CurrentSpace != c.Result.Space || d.DefaultSpace == "" {
		t.Errorf("delta %+v; want the new space only, both in order, the new one current", d)
	}

	// An op that changes nothing is no commit.
	c, err = m.Apply(ctx, &core.SwitchSpace{Space: c.Result.Space}, ApplyOptions{})
	if err != nil || c.Changed || c.Rev != 1 {
		t.Errorf("no-op: %+v, %v; want unchanged at rev 1", c, err)
	}
	// A refused op changes nothing either.
	if _, err := m.Apply(ctx, &core.CloseTab{Tab: "t-gone"}, ApplyOptions{}); !errors.Is(err, core.ErrNotFound) {
		t.Errorf("close of a missing tab: %v; want not found", err)
	}
	if _, err := m.Apply(ctx, &core.RemoveSpace{Space: "sp-n1", To: "sp-n1"}, ApplyOptions{}); !errors.Is(err, core.ErrInvalidArgument) {
		t.Errorf("remove into itself: %v; want invalid argument", err)
	}
	if m.Snapshot().Rev != 1 {
		t.Errorf("rev %d after refusals; want 1", m.Snapshot().Rev)
	}
	c = apply(t, m, &core.RenameSpace{Space: "sp-n1", Name: "2"})
	if ev := <-sub.C(); ev.Rev != 2 || c.Rev != 2 {
		t.Errorf("next event rev %d; want 2", ev.Rev)
	}
	select {
	case ev := <-sub.C():
		t.Errorf("an extra event: %+v", ev)
	default:
	}
}

// Every delta applied in order to the first snapshot gives the last snapshot: what a
// client holds after the layout source's snapshot and its live events.
func TestDeltasRebuildTheSnapshot(t *testing.T) {
	db := dbtest.Open(t)
	b := bus.New()
	sub := bus.Subscribe[Event](b, 64)
	defer sub.Close()
	m := open(t, db, b, nil)
	client := m.Snapshot().State.Clone()

	ops := []core.Op{
		&core.AddTab{Tab: file("/a"), Focus: true},
		&core.AddTab{Tab: file("/b")},
		&core.SplitPane{Pane: "p-n1", Edge: core.Bottom, Tab: &core.Tab{Kind: "prs"}, Focus: true},
		&core.NewSpace{Name: "Two"},
		&core.MoveTab{Tab: "t-n2", Space: "sp-n2"},
		&core.FocusTab{Tab: "t-n1"},
		&core.ReorderSpaces{Order: []string{"sp-n2", "sp-n1"}},
		&core.CloseTab{Tab: "t-n3"},
		&core.RemoveSpace{Space: "sp-n2"},
	}
	for _, op := range ops {
		c := apply(t, m, op)
		ev := <-sub.C()
		if ev.Rev != c.Rev {
			t.Fatalf("%s: event rev %d, commit %d", op.OpName(), ev.Rev, c.Rev)
		}
		client = applyDelta(client, ev.Delta)
		if !reflect.DeepEqual(client, m.Snapshot().State) {
			t.Fatalf("after %s the client holds\n%+v\nwant\n%+v", op.OpName(), client, m.Snapshot().State)
		}
	}
}

// applyDelta is what a client does with a delta.
func applyDelta(st *core.State, d Delta) *core.State {
	byID := map[string]*core.Space{}
	for _, sp := range st.Spaces {
		byID[sp.ID] = sp
	}
	for _, sp := range d.Spaces {
		byID[sp.ID] = sp
	}
	out := &core.State{V: st.V, CurrentSpace: d.CurrentSpace, DefaultSpace: d.DefaultSpace}
	for _, id := range d.Order {
		out.Spaces = append(out.Spaces, byID[id])
	}
	for id, ts := range st.Threads {
		if out.Threads == nil {
			out.Threads = map[string]*core.ThreadState{}
		}
		out.Threads[id] = ts
	}
	for _, e := range d.Threads {
		if out.Threads == nil {
			out.Threads = map[string]*core.ThreadState{}
		}
		out.Threads[e.ID] = e.State
	}
	for _, id := range d.RemovedThreads {
		delete(out.Threads, id)
	}
	return out
}

func TestFocusIsWrittenLater(t *testing.T) {
	db := dbtest.Open(t)
	m := open(t, db, nil, nil)
	apply(t, m, &core.AddTab{Tab: file("/a"), Focus: true})
	apply(t, m, &core.SplitPane{Pane: "p-n1", Edge: core.Right, Tab: file("/b"), Focus: true})
	if got := metaValue(t, db, metaRev); got != "2" {
		t.Fatalf("rev on disk %s; want 2 (structural changes are written at once)", got)
	}

	c := apply(t, m, &core.FocusPane{Pane: "p-n1"})
	if c.Rev != 3 || m.Snapshot().State.Spaces[0].Focus != "p-n1" {
		t.Fatalf("focus commit %+v", c)
	}
	if got := metaValue(t, db, metaRev); got != "2" {
		t.Errorf("rev on disk %s right after a focus change; want 2 (written later)", got)
	}
	m.mu.Lock()
	armed := m.timer != nil
	m.mu.Unlock()
	if !armed {
		t.Fatal("no write is coming for the focus change")
	}
	m.flushLater() // what the timer runs
	if got := metaValue(t, db, metaRev); got != "3" {
		t.Errorf("rev on disk %s after the write; want 3", got)
	}

	// A focus change waiting is written with the next structural change.
	apply(t, m, &core.FocusPane{Pane: "p-n2"})
	apply(t, m, &core.NewSpace{})
	if got := metaValue(t, db, metaRev); got != "5" {
		t.Errorf("rev on disk %s; want 5", got)
	}
	m.mu.Lock()
	armed = m.timer != nil
	m.mu.Unlock()
	if armed {
		t.Error("a write is still coming after a structural change wrote everything")
	}

	// Close writes a focus change still waiting.
	apply(t, m, &core.FocusPane{Pane: "p-n1"})
	want := m.Snapshot()
	if err := m.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply(context.Background(), &core.NewSpace{}, ApplyOptions{}); !errors.Is(err, ErrClosed) {
		t.Errorf("Apply after Close: %v; want ErrClosed", err)
	}
	m2 := open(t, db, nil, nil)
	if got := m2.Snapshot(); got.Rev != 6 || !reflect.DeepEqual(got.State, want.State) {
		t.Errorf("reloaded rev %d focus %q; want rev 6 focus p-n1", got.Rev, got.State.Spaces[0].Focus)
	}
}

// With a short delay the timer itself writes the focus change.
func TestFocusTimerWrites(t *testing.T) {
	db := dbtest.Open(t)
	m, err := New(context.Background(), Options{DB: db, IDs: &core.SeqIDs{}, FocusDelay: time.Millisecond, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m.Close(context.Background()) }()
	apply(t, m, &core.AddTab{Tab: file("/a"), Focus: true})
	apply(t, m, &core.AddTab{Tab: file("/b"), Focus: true})
	apply(t, m, &core.FocusTab{Tab: "t-n1"})
	deadline := time.Now().Add(30 * time.Second)
	for metaValue(t, db, metaRev) != "3" {
		if time.Now().After(deadline) {
			t.Fatal("the focus change was never written")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCorruptRowsAreRepaired(t *testing.T) {
	tests := []struct {
		name string
		rows []string
		// check the repaired state
		check func(t *testing.T, st *core.State)
	}{
		{
			name: "space doc that is not JSON",
			rows: []string{
				`INSERT INTO layout_spaces VALUES ('sp-a', 'Main', 0, '{not json', 1)`,
				`INSERT INTO layout_spaces VALUES ('sp-b', 'Two', 1, '{"v":1,"root":{"t":"pane","id":"p-1","tabs":[{"id":"t-1","kind":"prs"}],"active":"t-1"},"focus":"p-1"}', 1)`,
				`INSERT INTO layout_meta VALUES ('rev', '7'), ('current_space', 'sp-b'), ('default_space', 'sp-a')`,
			},
			check: func(t *testing.T, st *core.State) {
				if st.Space("sp-a") == nil || st.Space("sp-a").Root != nil || st.Space("sp-b").Root == nil {
					t.Errorf("spaces %+v; want sp-a kept empty, sp-b kept whole", st.Spaces)
				}
			},
		},
		{
			name: "thread doc that is not JSON, and one in a space that is gone",
			rows: []string{
				`INSERT INTO layout_spaces VALUES ('sp-a', 'Main', 0, '{"v":1}', 1)`,
				`INSERT INTO layout_threads VALUES ('s-1', 'sp-a', '[]', 1), ('s-2', 'sp-gone', '{"v":1,"quick":{"open":true}}', 1)`,
				`INSERT INTO layout_meta VALUES ('rev', 'many')`,
			},
			check: func(t *testing.T, st *core.State) {
				if ts := st.Threads["s-1"]; ts == nil || ts.Space != "sp-a" {
					t.Errorf("s-1: %+v; want kept in sp-a with nothing stored", ts)
				}
				if ts := st.Threads["s-2"]; ts == nil || ts.Space != "sp-a" || ts.Quick == nil || !ts.Quick.Open {
					t.Errorf("s-2: %+v; want moved to sp-a with its quick terminal", ts)
				}
			},
		},
		{
			name: "a tree out of normal form with a duplicate surface",
			rows: []string{
				`INSERT INTO layout_spaces VALUES ('sp-a', 'Main', 0, '{"v":1,"root":{"t":"split","id":"s-1","dir":"row","kids":[{"t":"pane","id":"p-1","tabs":[{"id":"t-1","kind":"prs"}],"active":"t-1"},{"t":"pane","id":"p-2","tabs":[{"id":"t-2","kind":"prs"},{"id":"t-3","kind":"file"}],"active":"t-2"}],"sizes":[1,1]},"focus":"p-9","mru":["t-9"]}', 1)`,
			},
			check: func(t *testing.T, st *core.State) {
				sp := st.Spaces[0]
				if !sp.Root.IsPane() || sp.Root.ID != "p-1" || sp.Focus != "p-1" || sp.MRU != nil {
					t.Errorf("space %+v root %+v; want the one pane p-1 left, focused", sp, sp.Root)
				}
			},
		},
		{
			name: "no space but threads and meta",
			rows: []string{
				`INSERT INTO layout_threads VALUES ('s-1', 'sp-a', '{"v":1}', 1)`,
				`INSERT INTO layout_meta VALUES ('current_space', 'sp-a')`,
			},
			check: func(t *testing.T, st *core.State) {
				if len(st.Spaces) != 1 || st.Threads["s-1"].Space != st.Spaces[0].ID {
					t.Errorf("state %+v; want one new space holding s-1", st)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := dbtest.Open(t)
			for _, q := range tt.rows {
				if _, err := db.Exec(q); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			var log bytes.Buffer
			m := open(t, db, nil, &log)
			st := m.Snapshot().State
			if err := core.Check(st); err != nil {
				t.Fatalf("repaired state is not in normal form: %v", err)
			}
			tt.check(t, st)
			if !bytes.Contains(log.Bytes(), []byte("repaired the stored layout")) {
				t.Errorf("no repair logged:\n%s", log.String())
			}
			// The repair was written: opening again repairs nothing and finds the same state.
			if err := m.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			log.Reset()
			m2 := open(t, db, nil, &log)
			if !reflect.DeepEqual(m2.Snapshot().State, st) {
				t.Errorf("reopened %+v; want %+v", m2.Snapshot().State, st)
			}
			if log.Len() > 0 {
				t.Errorf("reopening logged:\n%s", log.String())
			}
			// And the store works.
			apply(t, m2, &core.NewSpace{})
		})
	}
}

// Applies from many goroutines are ordered: revs are 1..n with no gap or repeat, and the
// bus carries them in that order.
func TestConcurrentAppliesAreSerialised(t *testing.T) {
	db := dbtest.Open(t)
	b := bus.New()
	const n = 24
	sub := bus.Subscribe[Event](b, n)
	defer sub.Close()
	m := open(t, db, b, nil)
	var wg sync.WaitGroup
	revs := make(chan uint64, n)
	for i := range n {
		wg.Go(func() {
			c, err := m.Apply(context.Background(), &core.NewSpace{Name: "s" + strconv.Itoa(i)}, ApplyOptions{})
			if err != nil {
				t.Error(err)
				return
			}
			revs <- c.Rev
		})
	}
	wg.Wait()
	close(revs)
	seen := map[uint64]bool{}
	for r := range revs {
		if seen[r] || r < 1 || r > n {
			t.Errorf("rev %d repeated or out of range", r)
		}
		seen[r] = true
	}
	for want := uint64(1); want <= n; want++ {
		if ev := <-sub.C(); ev.Rev != want {
			t.Fatalf("event %d has rev %d", want, ev.Rev)
		}
	}
	if got := len(m.Snapshot().State.Spaces); got != n+1 {
		t.Errorf("%d spaces; want %d", got, n+1)
	}
}

func TestViewport(t *testing.T) {
	m := open(t, dbtest.Open(t), nil, nil)
	if got := m.Viewport(); got != DefaultViewport {
		t.Errorf("viewport %+v before any; want the default", got)
	}
	for _, v := range []Viewport{{0, 800}, {800, -1}, {1e7, 800}} {
		if err := m.SetViewport("w", v); !errors.Is(err, core.ErrInvalidArgument) {
			t.Errorf("SetViewport(%+v): %v; want invalid argument", v, err)
		}
	}
	if err := m.SetViewport("w", Viewport{1440.5, 900}); err != nil {
		t.Fatal(err)
	}
	if got := m.Viewport(); got != (Viewport{1440.5, 900}) {
		t.Errorf("viewport %+v", got)
	}
}

// The space the user is in is remembered: the app reopens in it (shell-model.md, State).
// A switch is focus-only, so it reaches the disk within FocusDelay or at Close.
func TestReopensInTheCurrentSpace(t *testing.T) {
	db := dbtest.Open(t)
	m := open(t, db, nil, nil)
	two := apply(t, m, &core.NewSpace{Name: "Two"}).Result.Space
	apply(t, m, &core.SwitchSpace{Space: two})
	if got := metaValue(t, db, metaCurrentSpace); got == two {
		t.Fatalf("current space written at once; want it written later")
	}
	if err := m.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	m2 := open(t, db, nil, nil)
	if got := m2.Snapshot().State.CurrentSpace; got != two {
		t.Errorf("reopened in %q; want %q", got, two)
	}
	// Removing the current space leaves the user in the space its threads moved to, and that
	// is where the app reopens.
	apply(t, m2, &core.RemoveSpace{Space: two})
	main := m2.Snapshot().State.Spaces[0].ID
	if err := m2.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := open(t, db, nil, nil).Snapshot().State.CurrentSpace; got != main {
		t.Errorf("reopened in %q after removing the current space; want %q", got, main)
	}
}

// layout.smart_swap (Options.SmartSwap) is read at every op: with it on, focusing thread b
// switches the pane beside it from a's diff to b's; with it off nothing else changes.
func TestSmartSwapSetting(t *testing.T) {
	for _, tc := range []struct {
		name string
		on   bool
		want string // the side pane's active tab after b is focused: "b" or "a"
	}{
		{"on", true, "b"},
		{"off", false, "a"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			on := true
			opts := Options{DB: dbtest.Open(t), IDs: &core.SeqIDs{}, FocusDelay: time.Hour, Log: slog.New(slog.DiscardHandler),
				SmartSwap: func() bool { return on }}
			m, err := New(context.Background(), opts)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = m.Close(context.Background()) })
			diff := func(thread string) *core.Tab {
				return &core.Tab{Kind: "diff", Thread: thread, Params: map[string]string{"project": "pj", "worktree": thread}}
			}
			a := apply(t, m, &core.OpenThread{Thread: "th-a", Focus: true}).Result
			b := apply(t, m, &core.OpenThread{Thread: "th-b", Focus: true}).Result
			side := apply(t, m, &core.SplitPane{Pane: a.Pane, Edge: "right", Tab: diff("th-b"), Focus: true}).Result
			da := apply(t, m, &core.OpenSurface{Pane: side.Pane, Tab: diff("th-a"), Focus: true}).Result
			apply(t, m, &core.FocusTab{Tab: a.Tab})
			on = tc.on
			apply(t, m, &core.FocusTab{Tab: b.Tab})
			_, p, _ := m.Snapshot().State.FindTab(da.Tab)
			got := map[string]string{side.Tab: "b", da.Tab: "a"}[p.Active]
			if got != tc.want {
				t.Errorf("side pane shows %s's diff; want %s's", got, tc.want)
			}
		})
	}
}

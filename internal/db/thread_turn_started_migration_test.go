package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0059 gives every thread the start of its latest turn (turn_started_at, unix
// ms), read from its items by the thread store's rule (lastTurn): the first top-level user
// message Claude read after the turn before it ended, in the log's order (a placed message
// sits after the item it was read at). 0 for a thread without one.
func TestThreadTurnStartedMigration(t *testing.T) {
	type item struct {
		ord     int
		kind    string
		parent  string
		created int64
		data    string
	}
	user := func(ord int, at int64) item {
		return item{ord: ord, kind: "user_message", created: at, data: `{"text":"hi"}`}
	}
	end := func(ord int, at int64) item { return item{ord: ord, kind: "turn_end", created: at, data: `{}`} }
	text := func(ord int, at int64) item {
		return item{ord: ord, kind: "assistant_text", created: at, data: `{"text":"ok"}`}
	}
	tests := []struct {
		name  string
		items []item
		want  int64
	}{
		{"no items", nil, 0},
		{"one ended turn", []item{user(1, 10), text(2, 20), end(3, 30)}, 10},
		{"a follow-up in progress", []item{user(1, 10), end(2, 30), user(3, 40)}, 40},
		{"two ended turns", []item{user(1, 10), end(2, 20), user(3, 30), end(4, 40)}, 30},
		{"a steer mid-turn is no new turn", []item{user(1, 10), user(2, 20), end(3, 30)}, 10},
		{"a message still queued is not read", []item{user(1, 10), end(2, 30), {ord: 3, kind: "user_message", created: 40, data: `{"queued":true}`}}, 10},
		{"a message placed before the turn end", []item{user(1, 10), text(2, 20), end(3, 30), {ord: 4, kind: "user_message", created: 25, data: `{"placed_after":2}`}}, 10},
		{"a message placed after the turn end", []item{user(1, 10), end(2, 30), text(3, 35), {ord: 4, kind: "user_message", created: 33, data: `{"placed_after":3}`}}, 33},
		{"a subagent's prompt", []item{user(1, 10), end(2, 30), {ord: 3, kind: "user_message", parent: "toolu_1", created: 40, data: `{}`}}, 10},
		{"a turn end before any message", []item{end(1, 5), user(2, 10)}, 10},
	}
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 59 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, tt := range tests {
		if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, project_id, worktree_path, created_at, state) VALUES (?, 'web', '/wt', 1, 4)`, tt.name); err != nil {
			t.Fatal(err)
		}
		for _, it := range tt.items {
			if _, err := db.ExecContext(ctx, `INSERT INTO thread_items (thread_id, ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, tt.name, it.ord, tt.name+"-"+string(rune('a'+it.ord)), it.kind, it.parent, it.created, it.created, it.data); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got int64
			if err := db.QueryRowContext(ctx, `SELECT turn_started_at FROM threads WHERE id = ?`, tt.name).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("turn_started_at = %d, want %d", got, tt.want)
			}
		})
	}
}

package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The Todo tab through the host's row acts: a tick moves a task to Done (and back), a
// move puts it under its new upper neighbour, an add lands last of the open tasks, an
// edit renames it, and a title another task has is refused.
func TestTodoRows(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	h := plugintest.Start(t, plugin(), plugintest.Options{Name: "hello",
		Granted:      pluginsdk.Permissions{Secrets: true, Events: []string{"threads"}, ThreadStatus: true, SessionEnv: true, Threads: true, Terminals: true, Commands: []string{"thread.send"}},
		Capabilities: []string{"threads", "terminals"}})
	if err := h.OpenSurface(ctx, inst, "demo", pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	h.WaitFor(5*time.Second, func(h *plugintest.Host) bool { return h.Version(inst) >= 1 })
	if err := h.Act(ctx, pluginsdk.SurfaceAct{Instance: inst, Kind: pluginsdk.ActTab, Key: "todo"}); err != nil {
		t.Fatal(err)
	}
	// titles is "open | done".
	titles := func() string {
		t.Helper()
		v := view(t, h)
		if len(v.Nodes) != 3 || v.Nodes[1].List == nil || v.Nodes[2].Section == nil {
			t.Fatalf("nodes %+v", v.Nodes)
		}
		var open, done []string
		for _, r := range v.Nodes[1].List.Rows {
			open = append(open, strings.TrimPrefix(r.Key, "todo-"))
		}
		for _, r := range v.Nodes[2].Section.Children[0].List.Rows {
			if !r.Checked {
				t.Errorf("done row %s is not checked", r.Key)
			}
			done = append(done, strings.TrimPrefix(r.Key, "todo-"))
		}
		return strings.Join(open, " ") + " | " + strings.Join(done, " ")
	}
	if got := titles(); got != "1 2 3 4 5 | 6 7" {
		t.Fatalf("first view %q", got)
	}
	l := view(t, h).Nodes[1].List
	if !l.Checkable || !l.Reorderable || l.Add == nil || !l.Rows[0].Editable {
		t.Fatalf("the open list %+v", l)
	}
	steps := []struct {
		name string
		do   func() error
		want string
	}{
		{"tick", func() error { return h.Check(ctx, inst, "todo-2", true) }, "1 3 4 5 | 2 6 7"},
		{"untick", func() error { return h.Check(ctx, inst, "todo-6", false) }, "1 3 4 5 6 | 2 7"},
		{"move to the top", func() error { return h.Move(ctx, inst, "todo-5", "") }, "5 1 3 4 6 | 2 7"},
		{"move under another", func() error { return h.Move(ctx, inst, "todo-1", "todo-4") }, "5 3 4 1 6 | 2 7"},
		{"add", func() error { return h.AddRow(ctx, inst, "todo-open", "Water the plants") }, "5 3 4 1 6 8 | 2 7"},
		{"edit", func() error { return h.EditRow(ctx, inst, "todo-8", "Water the ferns") }, "5 3 4 1 6 8 | 2 7"},
	}
	for _, s := range steps {
		if err := s.do(); err != nil {
			t.Fatalf("%s: %v", s.name, err)
		}
		if got := titles(); got != s.want {
			t.Fatalf("%s: %q, want %q", s.name, got, s.want)
		}
	}
	if r := view(t, h).Nodes[1].List.Rows[5]; r.Title != "Water the ferns" {
		t.Errorf("the edited row %+v", r)
	}
	for _, err := range []error{
		h.AddRow(ctx, inst, "todo-open", "water the FERNS"),
		h.EditRow(ctx, inst, "todo-1", "Water the ferns"),
	} {
		if err == nil || !strings.Contains(err.Error(), "is already on the list") {
			t.Errorf("a taken title: %v", err)
		}
	}
	if err := (ui.View{Nodes: todoNodes(newTodo())}).Validate(); err != nil {
		t.Fatal(err)
	}
}

// A move under a task that is not there (or under itself) is refused and loses nothing.
func TestTodoRefusedMoveKeepsTheTask(t *testing.T) {
	for _, after := range []string{"todo-9", "todo-2"} {
		s := newTodo()
		err := s.act(pluginsdk.SurfaceAct{Kind: pluginsdk.ActMove, Key: "todo-2", Value: after})
		if err == nil || len(s.items) != 7 || s.items[1].key != "todo-2" {
			t.Errorf("move under %s: %v, %d tasks, second %s", after, err, len(s.items), s.items[1].key)
		}
	}
}

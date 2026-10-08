package terminaltest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
)

func TestFakeLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f := New(nil)
	events, _ := f.Watch(ctx)

	term, err := f.Create(ctx, terminal.Spec{Argv: []string{"claude"}, Labels: map[string]string{"session": "s1"}})
	if err != nil {
		t.Fatal(err)
	}
	if ev := <-events; ev.Updated == nil || ev.Updated.ID != term.ID {
		t.Fatalf("watch create = %+v", ev)
	}
	_ = f.Emit(term.ID, []byte("before "))
	ch, err := f.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ev := <-ch; ev.Snapshot == nil || string(ev.Snapshot.Data) != "before " {
		t.Fatalf("snapshot = %+v", ev)
	}
	_ = f.Emit(term.ID, []byte("after"))
	if ev := <-ch; string(ev.Output) != "after" {
		t.Fatalf("output = %+v", ev)
	}
	if err := f.Write(ctx, term.ID, []byte("hi")); err != nil || string(f.Written(term.ID)) != "hi" {
		t.Fatalf("Write: %v, written %q", err, f.Written(term.ID))
	}
	if err := f.Remove(ctx, term.ID); !errors.Is(err, terminal.ErrRunning) {
		t.Fatalf("Remove running = %v", err)
	}
	if err := f.Kill(ctx, term.ID); err != nil {
		t.Fatal(err)
	}
	if ev := <-ch; ev.Exited == nil || ev.Exited.Code != 129 {
		t.Fatalf("exit = %+v", ev)
	}
	if err := f.Remove(ctx, term.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := <-ch; ok {
		t.Fatal("attach channel open after Remove")
	}
	if _, err := f.Get(ctx, term.ID); !errors.Is(err, terminal.ErrNotFound) {
		t.Fatalf("Get after Remove = %v", err)
	}
}

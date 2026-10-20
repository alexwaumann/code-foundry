package api

import (
	"context"
	"slices"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadReseed(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-1", State: thread.StateConnected, Status: thread.StatusIdle, Epoch: 1, ContextTokens: 9000})
	fake.Put(thread.Thread{ID: "s-2", State: thread.StateConnected, Status: thread.StatusBusy})
	res, err := c.Reseed(ctx, connect.NewRequest(&v1.ReseedThreadRequest{Id: "s-1", SystemPromptAppend: "be brief", AddDirs: []string{"/m"}, Prefix: "memory"}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetThread(); !res.Msg.GetStopped() || s.GetEpoch() != 2 || !s.GetSeedPending() || s.GetReseedPending() || s.GetContextTokens() != 0 {
		t.Errorf("Reseed idle = %v", res.Msg)
	}
	res, err = c.Reseed(ctx, connect.NewRequest(&v1.ReseedThreadRequest{Id: "s-2"}))
	if err != nil || res.Msg.GetStopped() || !res.Msg.GetThread().GetReseedPending() || res.Msg.GetThread().GetSeedPending() || res.Msg.GetThread().GetEpoch() != 2 {
		t.Errorf("Reseed busy = %v, %v", res.Msg, err)
	}
	if _, err := c.Reseed(ctx, connect.NewRequest(&v1.ReseedThreadRequest{Id: "s-nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown = %v", err)
	}
	if calls := fake.Calls(); !slices.Contains(calls, "Reseed s-1 prompt=8 dirs=/m prefix=6") {
		t.Errorf("calls = %q", calls)
	}
}

func TestThreadResident(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	r, _, err := fake.EnsureResident(ctx, "ember", thread.ResidentOptions{Cwd: "/home/residents/ember", DisplayName: "Ember"})
	if err != nil {
		t.Fatal(err)
	}
	fake.Put(thread.Thread{ID: "s-user", State: thread.StateDisconnected})
	got, err := c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: r.ID}))
	if err != nil {
		t.Fatal(err)
	}
	if s := got.Msg.GetThread(); s.GetKind() != v1.ThreadKind_THREAD_KIND_RESIDENT || s.GetResidentName() != "ember" || s.GetEpoch() != 1 || s.GetName() != "Ember" {
		t.Errorf("Get = %v", s)
	}
	ids := func(f *v1.ThreadFilter) []string {
		res, err := c.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: f}))
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, s := range res.Msg.GetThreads() {
			out = append(out, s.GetId())
		}
		slices.Sort(out)
		return out
	}
	if got := ids(&v1.ThreadFilter{}); !slices.Equal(got, []string{"s-user"}) {
		t.Errorf("filtered List = %v", got)
	}
	if got := ids(&v1.ThreadFilter{IncludeResident: true}); len(got) != 2 {
		t.Errorf("List with residents = %v", got)
	}
	// Unfiltered (the GUI's) lists every thread.
	if got := ids(nil); len(got) != 2 {
		t.Errorf("unfiltered List = %v", got)
	}
	for _, call := range []func() error{
		func() error {
			_, err := c.Archive(ctx, connect.NewRequest(&v1.ArchiveThreadRequest{Id: r.ID, Archived: true}))
			return err
		},
		func() error {
			_, err := c.Remove(ctx, connect.NewRequest(&v1.RemoveThreadRequest{Id: r.ID}))
			return err
		},
		func() error { _, err := c.Fork(ctx, connect.NewRequest(&v1.ForkThreadRequest{Id: r.ID})); return err },
	} {
		if err := call(); connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Errorf("err = %v, want failed precondition", err)
		}
	}
}

package api

import (
	"context"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadSidebar(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	no := false
	fake.Put(thread.Thread{ID: "s-1", Name: "Parent", State: thread.StateConnected, CreatedAt: time.Unix(1, 0)})
	fake.Put(thread.Thread{ID: "s-2", State: thread.StateConnected, CreatedBy: "s-1", CreatedAt: time.Unix(2, 0)})
	fake.Put(thread.Thread{ID: "s-3", State: thread.StateConnected, CreatedBy: "s-1", SidebarOverride: &no, CreatedAt: time.Unix(3, 0)})

	get := func(id string) *v1.Thread {
		t.Helper()
		res, err := c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg.GetThread()
	}
	// Unset maps to unset (follow the setting), an override to its value.
	if p := get("s-1"); p.InSidebar != nil {
		t.Errorf("the user's thread: in_sidebar = %v, want unset", p.GetInSidebar())
	}
	if p := get("s-2"); p.InSidebar != nil {
		t.Errorf("a child without an override: in_sidebar = %v, want unset", p.GetInSidebar())
	}
	if p := get("s-3"); p.InSidebar == nil || p.GetInSidebar() {
		t.Errorf("a hidden child: in_sidebar = %v, want false", p.InSidebar)
	}

	res, err := c.SetSidebar(ctx, connect.NewRequest(&v1.SetThreadSidebarRequest{Id: "s-2", Shown: true}))
	if err != nil || res.Msg.GetThread().InSidebar == nil || !res.Msg.GetThread().GetInSidebar() {
		t.Fatalf("SetSidebar = %v, %v", res, err)
	}
	if _, err := c.SetSidebar(ctx, connect.NewRequest(&v1.SetThreadSidebarRequest{Id: "s-1", Shown: true})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("SetSidebar on the user's thread: %v, want invalid argument", err)
	}
	if _, err := c.SetSidebar(ctx, connect.NewRequest(&v1.SetThreadSidebarRequest{Id: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("SetSidebar on an unknown thread: %v, want not found", err)
	}

	yes := true
	cr, err := c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{ProjectId: "r1", CreatedBy: "s-1", InSidebar: &yes}))
	if err != nil || cr.Msg.GetThread().InSidebar == nil || !cr.Msg.GetThread().GetInSidebar() {
		t.Fatalf("Create(in_sidebar) = %v, %v", cr, err)
	}
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{ProjectId: "r1", InSidebar: &yes})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("Create(in_sidebar) without a creator: %v, want invalid argument", err)
	}

	// The archive cascade's list: s-3 only (s-2 is shown now, the new one too), with depths.
	list, err := c.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{ArchiveCascadeOf: "s-1"}}))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, p := range list.Msg.GetThreads() {
		got = append(got, p.GetId())
		if p.GetDepth() != 1 || p.Depth == nil {
			t.Errorf("%s: depth %v, want 1", p.GetId(), p.Depth)
		}
	}
	if !slices.Equal(got, []string{"s-3"}) {
		t.Errorf("List(archive_cascade_of) = %v, want [s-3]", got)
	}
	if list.Msg.GetTotals().GetThreads() != 1 {
		t.Errorf("totals = %v, want 1 thread", list.Msg.GetTotals())
	}

	want := []string{"SetSidebar s-2 true", "SetSidebar s-1 true", "SetSidebar nope false"}
	if calls := fake.Calls(); len(calls) < len(want) || !slices.Equal(calls[:len(want)], want) {
		t.Errorf("calls = %q, want %q first", calls, want)
	}
}

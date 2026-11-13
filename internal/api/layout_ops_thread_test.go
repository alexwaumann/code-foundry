package api

import (
	"context"
	"slices"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/layout"
)

// The thread ops through the service: a thread opens in place of the lone composer, its
// diff is placed by the rules in the reported viewport, closing it keeps the diff and
// reopening brings it back.
func TestLayoutThreadOps(t *testing.T) {
	f, cl, _ := layoutServer(t)
	ctx := context.Background()
	must := func(op *v1.LayoutOp) *v1.ApplyLayoutResponse {
		t.Helper()
		res, err := applyLayout(ctx, cl, op)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenSurface{OpenSurface: &v1.OpenSurfaceOp{Tab: &v1.LayoutTab{Kind: "compose"}, Focus: true}}})
	res := must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenThread{OpenThread: &v1.OpenThreadOp{ThreadId: "s-1", Focus: true}}})
	if res.GetRule() != "compose" || len(res.GetClosed()) != 1 || res.GetClosed()[0].GetKind() != "compose" {
		t.Fatalf("open_thread = %v", res)
	}
	threadPane := res.GetPaneId()

	// 600px wide: no room beside the thread (rule 5 needs 480px left), so rule 6.
	if err := f.SetViewport("win-1", layout.Viewport{Width: 600, Height: 800}); err != nil {
		t.Fatal(err)
	}
	diff := &v1.LayoutTab{Kind: "diff", ThreadId: "s-1", Params: map[string]string{"project": "pj-1", "worktree": "/w"}}
	res = must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenSurface{OpenSurface: &v1.OpenSurfaceOp{Tab: diff}}})
	if res.GetRule() != "6" || res.GetPaneId() != threadPane {
		t.Fatalf("open_surface at 600px = %v", res)
	}
	must(&v1.LayoutOp{Op: &v1.LayoutOp_CloseTab{CloseTab: &v1.CloseTabOp{TabId: res.GetTabId()}}})
	// Wide again: rule 5, a pane beside the thread.
	if err := f.SetViewport("win-1", layout.Viewport{Width: 1600, Height: 900}); err != nil {
		t.Fatal(err)
	}
	res = must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenSurface{OpenSurface: &v1.OpenSurfaceOp{Tab: diff}}})
	if res.GetRule() != "5" || res.GetPaneId() == threadPane {
		t.Fatalf("open_surface at 1600px = %v", res)
	}
	diffTab := res.GetTabId()

	res = must(&v1.LayoutOp{Op: &v1.LayoutOp_CloseThread{CloseThread: &v1.CloseThreadOp{ThreadId: "s-1"}}})
	if len(res.GetKept()) != 1 || res.GetKept()[0].GetId() != diffTab {
		t.Fatalf("close_thread = %v", res)
	}
	res = must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenThread{OpenThread: &v1.OpenThreadOp{ThreadId: "s-1", Focus: true}}})
	if !slices.Contains(append(res.GetBackTabIds(), res.GetPlacedTabIds()...), diffTab) {
		t.Fatalf("reopen = %v; want %s back", res, diffTab)
	}

	// Another space, then move the thread there with its diff.
	sp := must(&v1.LayoutOp{Op: &v1.LayoutOp_NewSpace{NewSpace: &v1.NewSpaceOp{Name: "Two"}}}).GetSpaceId()
	res = must(&v1.LayoutOp{Op: &v1.LayoutOp_MoveThread{MoveThread: &v1.MoveThreadOp{ThreadId: "s-1", SpaceId: sp}}})
	if res.GetSpaceId() != sp {
		t.Fatalf("move_thread = %v", res)
	}
	if _, _, tb := f.Snapshot().State.FindTab(diffTab); tb == nil {
		t.Fatalf("the diff did not move with its thread")
	}

	res = must(&v1.LayoutOp{Op: &v1.LayoutOp_SnoozeThread{SnoozeThread: &v1.SnoozeThreadOp{ThreadId: "s-1"}}})
	if len(res.GetKept()) != 1 {
		t.Fatalf("snooze_thread = %v", res)
	}
	must(&v1.LayoutOp{Op: &v1.LayoutOp_ArchiveThread{ArchiveThread: &v1.ArchiveThreadOp{ThreadId: "s-1"}}})
	if _, ok := f.Snapshot().State.Threads["s-1"]; ok {
		t.Error("archive kept the thread's layout")
	}
}

// Drafts through the service: the composer becomes a draft, the space lists it, and
// discarding it reports its id.
func TestLayoutDraftOps(t *testing.T) {
	_, cl, _ := layoutServer(t)
	ctx := context.Background()
	res, err := applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_NewThread{NewThread: &v1.NewThreadOp{Params: map[string]string{"project": "pj-1"}, Focus: true}}})
	if err != nil {
		t.Fatal(err)
	}
	res, err = applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_StartDraft{StartDraft: &v1.StartDraftOp{TabId: res.GetTabId(), DraftId: "d-mine", Label: "Fix the"}}})
	if err != nil || res.GetDraftId() != "d-mine" {
		t.Fatalf("start_draft = %v, %v", res, err)
	}
	if _, err := applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_LabelDraft{LabelDraft: &v1.LabelDraftOp{DraftId: "d-mine", Label: "Fix the login"}}}); err != nil {
		t.Fatal(err)
	}
	got, err := cl.Get(ctx, connect.NewRequest(&v1.GetLayoutRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	drafts := got.Msg.GetLayout().GetSpaces()[0].GetDrafts()
	if len(drafts) != 1 || drafts[0].GetLabel() != "Fix the login" || drafts[0].GetParams()["project"] != "pj-1" {
		t.Fatalf("drafts = %v", drafts)
	}
	for _, op := range []*v1.LayoutOp{
		{Op: &v1.LayoutOp_OpenDraft{OpenDraft: &v1.OpenDraftOp{DraftId: "d-mine", Focus: true}}},
		{Op: &v1.LayoutOp_ClearDraft{ClearDraft: &v1.ClearDraftOp{DraftId: "d-mine"}}},
	} {
		if res, err := applyLayout(ctx, cl, op); err != nil || res.GetDraftId() != "d-mine" {
			t.Fatalf("%v = %v, %v", op, res, err)
		}
	}
	if _, err := applyLayout(ctx, cl, &v1.LayoutOp{Op: &v1.LayoutOp_DiscardDraft{DiscardDraft: &v1.DiscardDraftOp{DraftId: "d-mine"}}}); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("discard a cleared draft: %v", err)
	}
}

// open_thread carries a drop's place: an index in a pane's strip, and an edge (of a pane, or
// of the whole pane area).
func TestLayoutOpenThreadAtAPlace(t *testing.T) {
	f, cl, _ := layoutServer(t)
	ctx := context.Background()
	must := func(op *v1.LayoutOp) *v1.ApplyLayoutResponse {
		t.Helper()
		res, err := applyLayout(ctx, cl, op)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	pane := must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenSurface{OpenSurface: &v1.OpenSurfaceOp{Tab: &v1.LayoutTab{Kind: "prs"}, Focus: true}}}).GetPaneId()
	must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenSurface{OpenSurface: &v1.OpenSurfaceOp{Tab: &v1.LayoutTab{Kind: "projects"}, PaneId: pane, Focus: true}}})
	first := int32(0)
	res := must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenThread{OpenThread: &v1.OpenThreadOp{ThreadId: "s-1", PaneId: pane, Index: &first}}})
	if _, p := f.Snapshot().State.FindPane(pane); p.Tabs[0].ID != res.GetTabId() {
		t.Fatalf("index 0: %v", p.Tabs)
	}
	res = must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenThread{OpenThread: &v1.OpenThreadOp{ThreadId: "s-2", PaneId: pane, Edge: v1.LayoutEdge_LAYOUT_EDGE_RIGHT}}})
	if res.GetRule() != "edge" || res.GetPaneId() == pane {
		t.Fatalf("edge: %v", res)
	}
}

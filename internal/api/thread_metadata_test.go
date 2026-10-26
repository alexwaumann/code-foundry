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

func TestThreadMetadataMapping(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	fake.Put(thread.Thread{ID: "s-1", Name: "Parent", State: thread.StateConnected})
	fake.Put(thread.Thread{ID: "s-2", State: thread.StateConnected, CreatedBy: "s-1", CreatedByName: "Parent", Brief: "say hi",
		Labels: []string{"a", "b"}, BudgetUSD: 5, BudgetHitUSD: 5,
		Report: thread.Report{Status: thread.ReportBlocked, Summary: "need a key", Data: `{"n":1}`, At: at}})
	got, err := c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "s-2"}))
	if err != nil {
		t.Fatal(err)
	}
	p := got.Msg.GetThread()
	if p.GetCreatedBy() != "s-1" || p.GetCreatedByName() != "Parent" || p.GetBrief() != "say hi" ||
		!slices.Equal(p.GetLabels(), []string{"a", "b"}) || p.GetBudgetUsd() != 5 ||
		p.GetReportStatus() != v1.ThreadReportStatus_THREAD_REPORT_STATUS_BLOCKED || p.GetReportSummary() != "need a key" ||
		p.GetReportData() != `{"n":1}` || !p.GetReportAt().AsTime().Equal(at) {
		t.Errorf("mapping = %v", p)
	}
	// Nothing set: no report time.
	got, _ = c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "s-1"}))
	if p := got.Msg.GetThread(); p.GetReportAt() != nil || p.GetLabels() != nil || p.GetReportStatus() != v1.ThreadReportStatus_THREAD_REPORT_STATUS_UNSPECIFIED {
		t.Errorf("empty mapping = %v", p)
	}

	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{ProjectId: "r1", CreatedBy: "s-1", Brief: " b ",
		Labels: []string{"Y", "x"}, BudgetUsd: 1.5}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetThread(); s.GetCreatedBy() != "s-1" || s.GetCreatedByName() != "Parent" || s.GetBrief() != "b" ||
		!slices.Equal(s.GetLabels(), []string{"x", "y"}) || s.GetBudgetUsd() != 1.5 {
		t.Errorf("Create = %v", s)
	}
	for _, req := range []*v1.CreateThreadRequest{
		{ProjectId: "r1", CreatedBy: "s-nope"},
		{ProjectId: "r1", Labels: []string{"no way"}},
		{ProjectId: "r1", BudgetUsd: -1},
	} {
		if _, err := c.Create(ctx, connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("Create(%v) = %v, want invalid argument", req, err)
		}
	}
}

func TestThreadLabelReportBudget(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-1", State: thread.StateConnected, Labels: []string{"test"}})

	lab, err := c.Label(ctx, connect.NewRequest(&v1.LabelThreadRequest{Id: "s-1", Add: []string{"x"}, Remove: []string{"test"}}))
	if err != nil || !slices.Equal(lab.Msg.GetThread().GetLabels(), []string{"x"}) {
		t.Fatalf("Label = %v, %v", lab, err)
	}
	// A kanban page moves a card: remove every column's label, add the new column's.
	move, err := c.Label(ctx, connect.NewRequest(&v1.LabelThreadRequest{Id: "s-1",
		Add: []string{"kanban/review"}, Remove: []string{"kanban/todo", "kanban/review", "kanban/done"}}))
	if err != nil || !slices.Equal(move.Msg.GetThread().GetLabels(), []string{"kanban/review", "x"}) {
		t.Fatalf("Label move = %v, %v", move, err)
	}
	if _, err := c.Label(ctx, connect.NewRequest(&v1.LabelThreadRequest{Id: "nope", Clear: true})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown: %v", err)
	}

	rep, err := c.Report(ctx, connect.NewRequest(&v1.ReportThreadRequest{Id: "s-1", Status: v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE,
		Summary: "all good", Data: `{"n": 1}`}))
	if p := rep.Msg.GetThread(); err != nil || p.GetReportStatus() != v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE ||
		p.GetReportSummary() != "all good" || p.GetReportData() != `{"n":1}` || p.GetReportAt() == nil {
		t.Fatalf("Report = %v, %v", rep, err)
	}
	for _, req := range []*v1.ReportThreadRequest{
		{Id: "s-1"},
		{Id: "s-1", Status: v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE, Data: "[1]"},
	} {
		if _, err := c.Report(ctx, connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("Report(%v) = %v", req, err)
		}
	}

	b, err := c.SetBudget(ctx, connect.NewRequest(&v1.SetThreadBudgetRequest{Id: "s-1", BudgetUsd: 0.25}))
	if err != nil || b.Msg.GetThread().GetBudgetUsd() != 0.25 {
		t.Fatalf("SetBudget = %v, %v", b, err)
	}
	if _, err := c.SetBudget(ctx, connect.NewRequest(&v1.SetThreadBudgetRequest{Id: "s-1", BudgetUsd: -1})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("negative: %v", err)
	}
	want := []string{"Label s-1 add=x remove=test clear=false", "Label s-1 add=kanban/review remove=kanban/todo,kanban/review,kanban/done clear=false", "Label nope add= remove= clear=true",
		"Report s-1 done all good", "Report s-1 none ", "Report s-1 done ", "SetBudget s-1 0.25", "SetBudget s-1 -1"}
	if got := fake.Calls(); !slices.Equal(got, want) {
		t.Errorf("calls = %q, want %q", got, want)
	}
}

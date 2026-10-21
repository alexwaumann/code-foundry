package api

import (
	"context"
	"slices"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Thread metadata for agent-created threads: the mapping of created_by, brief, labels,
// the report and the budget, and the Label, Report and SetBudget handlers
// (docs/notes/agents-2-metadata.md). The store validates; the store's commit
// publishes the thread on the thread list.

// metadataToProto sets s's metadata on p.
func metadataToProto(s thread.Thread, p *v1.Thread) {
	p.CreatedBy, p.CreatedByName, p.Brief = s.CreatedBy, s.CreatedByName, s.Brief
	p.Labels = slices.Clone(s.Labels)
	p.ReportStatus = v1.ThreadReportStatus(s.Report.Status)
	p.ReportSummary, p.ReportData = s.Report.Summary, s.Report.Data
	if !s.Report.At.IsZero() {
		p.ReportAt = timestamppb.New(s.Report.At)
	}
	p.BudgetUsd = s.BudgetUSD
}

// Label adds and removes a thread's labels.
func (h *Thread) Label(ctx context.Context, req *connect.Request[v1.LabelThreadRequest]) (*connect.Response[v1.LabelThreadResponse], error) {
	m := req.Msg
	s, err := h.store.Label(ctx, m.GetId(), m.GetAdd(), m.GetRemove(), m.GetClear())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.LabelThreadResponse{Thread: threadToProto(s)}), nil
}

// Report records a thread's report, replacing the previous one.
func (h *Thread) Report(ctx context.Context, req *connect.Request[v1.ReportThreadRequest]) (*connect.Response[v1.ReportThreadResponse], error) {
	m := req.Msg
	s, err := h.store.Report(ctx, m.GetId(), thread.Report{
		Status: thread.ReportStatus(m.GetStatus()), Summary: m.GetSummary(), Data: m.GetData(),
	})
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ReportThreadResponse{Thread: threadToProto(s), SummaryCutFrom: int32(thread.ReportSummaryCut(m.GetSummary()))}), nil
}

// SetBudget sets a thread's spending limit.
func (h *Thread) SetBudget(ctx context.Context, req *connect.Request[v1.SetThreadBudgetRequest]) (*connect.Response[v1.SetThreadBudgetResponse], error) {
	s, err := h.store.SetBudget(ctx, req.Msg.GetId(), req.Msg.GetBudgetUsd())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SetThreadBudgetResponse{Thread: threadToProto(s)}), nil
}

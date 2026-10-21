package commandtest

import (
	"context"
	"slices"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// current is Current (default: a CONNECTED thread) with id, a copy.
func (s *Thread) current(id string) *v1.Thread {
	cur := &v1.Thread{State: v1.ThreadState_THREAD_STATE_CONNECTED}
	if s.Current != nil {
		cur = proto.CloneOf(s.Current)
	}
	cur.Id = id
	return cur
}

// Label returns Current with the labels edited: clear, then remove, then add (sorted,
// deduplicated; no validation).
func (s *Thread) Label(_ context.Context, r *connect.Request[v1.LabelThreadRequest]) (*connect.Response[v1.LabelThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	var labels []string
	if !r.Msg.GetClear() {
		labels = slices.DeleteFunc(slices.Clone(cur.GetLabels()), func(l string) bool { return slices.Contains(r.Msg.GetRemove(), l) })
	}
	labels = append(labels, r.Msg.GetAdd()...)
	slices.Sort(labels)
	cur.Labels = slices.Compact(labels)
	return connect.NewResponse(&v1.LabelThreadResponse{Thread: cur}), nil
}

// Report returns Current with the report set, report_at at unix ms 1; a summary over
// 1000 characters is cut like the store's (thread.CutReportSummary, without the trim).
func (s *Thread) Report(_ context.Context, r *connect.Request[v1.ReportThreadRequest]) (*connect.Response[v1.ReportThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	summary, cutFrom := []rune(r.Msg.GetSummary()), 0
	if len(summary) > 1000 {
		summary, cutFrom = append(summary[:999:999], '…'), len(summary)
	}
	cur.ReportStatus, cur.ReportSummary, cur.ReportData = r.Msg.GetStatus(), string(summary), r.Msg.GetData()
	cur.ReportAt = timestamppb.New(time.UnixMilli(1))
	return connect.NewResponse(&v1.ReportThreadResponse{Thread: cur, SummaryCutFrom: int32(cutFrom)}), nil
}

// SetBudget returns Current with the budget set.
func (s *Thread) SetBudget(_ context.Context, r *connect.Request[v1.SetThreadBudgetRequest]) (*connect.Response[v1.SetThreadBudgetResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	cur.BudgetUsd = r.Msg.GetBudgetUsd()
	return connect.NewResponse(&v1.SetThreadBudgetResponse{Thread: cur}), nil
}

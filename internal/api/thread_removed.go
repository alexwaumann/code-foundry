package api

import (
	"errors"
	"slices"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Removed threads (docs/notes/removed-thread-signal.md): the store keeps a tombstone of
// a removed thread for a day. A look-up of its id is NOT_FOUND carrying a RemovedThread
// detail, Wait answers with it, and List adds the matching ones on include_removed.

// removedToProto maps a tombstone.
func removedToProto(r thread.RemovedThread) *v1.RemovedThread {
	p := &v1.RemovedThread{
		Id: r.ID, Name: r.Name, CreatedBy: r.CreatedBy, Labels: slices.Clone(r.Labels), ProjectId: r.ProjectID,
		ReportStatus: v1.ThreadReportStatus(r.Report.Status), ReportSummary: r.Report.Summary, ReportData: r.Report.Data,
	}
	if !r.RemovedAt.IsZero() {
		p.RemovedAt = timestamppb.New(r.RemovedAt)
	}
	if !r.Report.At.IsZero() {
		p.ReportAt = timestamppb.New(r.Report.At)
	}
	return p
}

// removedError is err as NOT_FOUND with its RemovedThread detail, when it is a
// *thread.RemovedError; nil otherwise.
func removedError(err error) *connect.Error {
	var re *thread.RemovedError
	if !errors.As(err, &re) {
		return nil
	}
	ce := connect.NewError(connect.CodeNotFound, err)
	if d, derr := connect.NewErrorDetail(removedToProto(re.Thread)); derr == nil {
		ce.AddDetail(d)
	}
	return ce
}

// removedResponse is Wait's answer for a removed thread id; nil when the store does not
// remember it.
func (h *Thread) removedResponse(id string) *connect.Response[v1.WaitThreadResponse] {
	r, ok := h.store.Removed(id)
	if !ok {
		return nil
	}
	return connect.NewResponse(&v1.WaitThreadResponse{Removed: removedToProto(r)})
}

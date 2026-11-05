package api

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// setupToProto is Thread.setup: the steps, without what the daemon keeps to run it again.
func setupToProto(s *thread.Setup) *v1.ThreadSetup {
	if s == nil {
		return nil
	}
	p := &v1.ThreadSetup{Phase: v1.ThreadSetupPhase(s.Phase), StartedAt: setupTime(s.StartedAt), EndedAt: setupTime(s.EndedAt), Error: s.Error, Background: s.Background}
	for _, st := range s.Steps {
		p.Steps = append(p.Steps, &v1.ThreadSetupStep{
			Kind: v1.ThreadSetupStepKind(st.Kind), ProjectId: st.ProjectID, ProjectName: st.ProjectName, Ref: st.Ref, Branch: st.Branch,
			Status: v1.ThreadSetupStepStatus(st.Status), StartedAt: setupTime(st.StartedAt), EndedAt: setupTime(st.EndedAt),
			Error: st.Error, Warning: st.Warning, RefAt: setupTime(st.RefAt),
		})
	}
	return p
}

// setupTime is t on the wire; unset when zero.
func setupTime(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}

// RetrySetup runs a failed or cancelled setup again.
func (h *Thread) RetrySetup(ctx context.Context, req *connect.Request[v1.RetryThreadSetupRequest]) (*connect.Response[v1.RetryThreadSetupResponse], error) {
	s, err := h.store.RetrySetup(ctx, req.Msg.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RetryThreadSetupResponse{Thread: threadToProto(s)}), nil
}

// CancelSetup stops a running setup and removes what it made.
func (h *Thread) CancelSetup(ctx context.Context, req *connect.Request[v1.CancelThreadSetupRequest]) (*connect.Response[v1.CancelThreadSetupResponse], error) {
	s, kept, err := h.store.CancelSetup(ctx, req.Msg.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.CancelThreadSetupResponse{Thread: threadToProto(s), KeptWorktrees: kept}), nil
}

// DiscardSetup undoes a send whose setup did not finish.
func (h *Thread) DiscardSetup(ctx context.Context, req *connect.Request[v1.DiscardThreadSetupRequest]) (*connect.Response[v1.DiscardThreadSetupResponse], error) {
	d, err := h.store.DiscardSetup(ctx, req.Msg.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	res := &v1.DiscardThreadSetupResponse{DraftJson: d.DraftJSON, Error: d.Error, KeptWorktrees: d.Kept}
	if d.First != nil {
		res.First = setupMessageToProto(*d.First)
	}
	for _, q := range d.Queued {
		res.Queued = append(res.Queued, setupMessageToProto(q))
	}
	return connect.NewResponse(res), nil
}

func setupMessageToProto(m thread.SetupMessage) *v1.ThreadSetupMessage {
	return &v1.ThreadSetupMessage{Text: m.Text, ComposerText: m.ComposerText, Attachments: m.Attachments}
}

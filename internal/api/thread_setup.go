package api

import (
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// setupToProto is Thread.setup: the steps, without what the daemon keeps to run it again.
func setupToProto(s *thread.Setup) *v1.ThreadSetup {
	if s == nil {
		return nil
	}
	p := &v1.ThreadSetup{Phase: v1.ThreadSetupPhase(s.Phase), StartedAt: setupTime(s.StartedAt), EndedAt: setupTime(s.EndedAt), Error: s.Error}
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

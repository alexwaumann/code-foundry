package api

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/durationpb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestSetupToProto(t *testing.T) {
	at := time.UnixMilli(1000)
	tests := []struct {
		name string
		in   *thread.Setup
		want func(*v1.ThreadSetup) bool
	}{
		{"none", nil, func(p *v1.ThreadSetup) bool { return p == nil }},
		{"a step, its times and what stays in the daemon", &thread.Setup{
			Phase: thread.SetupFailed, StartedAt: at, Error: "no",
			Steps: []thread.SetupStep{{Kind: thread.SetupStepFetch, ProjectID: "r1", ProjectName: "web", Ref: "origin/main", Status: thread.SetupStepWarning,
				StartedAt: at, Warning: "Could not reach origin", Error: "fatal", RefAt: at}},
			Request: &thread.SetupRequest{DraftJSON: "{}"},
		}, func(p *v1.ThreadSetup) bool {
			s := p.GetSteps()[0]
			return p.GetPhase() == v1.ThreadSetupPhase_THREAD_SETUP_PHASE_FAILED && p.GetError() == "no" && p.GetEndedAt() == nil &&
				s.GetKind() == v1.ThreadSetupStepKind_THREAD_SETUP_STEP_KIND_FETCH && s.GetStatus() == v1.ThreadSetupStepStatus_THREAD_SETUP_STEP_STATUS_WARNING &&
				s.GetRef() == "origin/main" && s.GetProjectName() == "web" && s.GetWarning() != "" && s.GetError() == "fatal" &&
				s.GetRefAt().AsTime().Equal(at) && s.GetEndedAt() == nil
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := setupToProto(tt.in); !tt.want(got) {
				t.Errorf("setupToProto = %+v", got)
			}
		})
	}
}

// The Go enums mirror the proto's: the mapping is a cast.
func TestSetupEnumsMirrorTheProto(t *testing.T) {
	if int32(thread.SetupCancelled) != int32(v1.ThreadSetupPhase_THREAD_SETUP_PHASE_CANCELLED) ||
		int32(thread.SetupStepStart) != int32(v1.ThreadSetupStepKind_THREAD_SETUP_STEP_KIND_START) ||
		int32(thread.SetupStepFailed) != int32(v1.ThreadSetupStepStatus_THREAD_SETUP_STEP_STATUS_FAILED) {
		t.Error("the enums drifted")
	}
}

func TestCreateBackgroundSetupReply(t *testing.T) {
	tests := []struct {
		name       string
		background bool
		wantHints  int
	}{{"waited for", false, 1}, {"background: nothing is known yet", true, 0}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newThreadServer(t)
			fake.SetHints("web @ main is also open in other")
			res, err := c.Create(context.Background(), connect.NewRequest(&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt", BackgroundSetup: tt.background, DraftJson: "{}"}))
			if err != nil {
				t.Fatal(err)
			}
			if got := len(res.Msg.GetHints()); got != tt.wantHints {
				t.Errorf("hints %q", res.Msg.GetHints())
			}
		})
	}
}

// A failed setup settles a wait: its message's turn ended (Manager.failSetup), which
// counts as a reaction. A running one does not.
func TestWaitOnASetup(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "busy", State: thread.StateStarting, Status: thread.StatusBusy, StatusReason: thread.ReasonSettingUp,
		Setup: &thread.Setup{Phase: thread.SetupRunning}})
	fake.PutItems("busy", thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "go"})
	fake.Put(thread.Thread{ID: "failed", State: thread.StateDisconnected, Status: thread.StatusError, StatusReason: thread.ReasonSetupFailed,
		Setup: &thread.Setup{Phase: thread.SetupFailed, Error: "git says no"}})
	fake.PutItems("failed", thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "go"},
		thread.Item{ID: "t1", Kind: thread.KindTurnEnd, Turn: &thread.TurnEnd{Interrupted: true}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := c.Wait(ctx, connect.NewRequest(&v1.WaitThreadRequest{Id: "failed", Timeout: durationpb.New(2 * time.Second)}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetTimedOut() || res.Msg.GetThread().GetSetup().GetError() != "git says no" {
		t.Errorf("wait on a failed setup: %+v", res.Msg)
	}
	res, err = c.Wait(ctx, connect.NewRequest(&v1.WaitThreadRequest{Id: "busy", Timeout: durationpb.New(100 * time.Millisecond)}))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Msg.GetTimedOut() {
		t.Errorf("a wait settled on a thread in setup: %+v", res.Msg)
	}
}

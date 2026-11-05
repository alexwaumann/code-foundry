package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func TestThreadSetupCommands(t *testing.T) {
	tests := []struct {
		name, verb, wantCall string
		prep                 func(*threadtest.Fake)
		wantMsg              []string
	}{
		{name: "retry", verb: "thread.setup.retry", wantCall: "RetrySetup s1", wantMsg: []string{"trying the setup of thread"}},
		{name: "cancel", verb: "thread.setup.cancel", wantCall: "CancelSetup s1", wantMsg: []string{"cancelled the setup of thread"}},
		{name: "cancel keeping work", verb: "thread.setup.cancel", wantCall: "CancelSetup s1",
			prep:    func(f *threadtest.Fake) { f.KeptWorktrees = []string{"/w/a"} },
			wantMsg: []string{"kept for the work in them: /w/a"}},
		{name: "discard", verb: "thread.setup.discard", wantCall: "DiscardSetup s1", wantMsg: []string{"discarded thread s1"}},
		{name: "discard with messages", verb: "thread.setup.discard", wantCall: "DiscardSetup s1",
			prep: func(f *threadtest.Fake) {
				f.SetupDraft = thread.SetupDraft{Queued: []thread.SetupMessage{{Text: "a"}, {Text: "b"}}}
			},
			wantMsg: []string{"2 queued messages"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := bus.New()
			fake := threadtest.New(b)
			reg := command.NewRegistry()
			if err := command.RegisterThreadLifecycle(reg, api.NewThread(fake, b), &commandtest.Emitter{}); err != nil {
				t.Fatal(err)
			}
			fake.Put(thread.Thread{ID: "s1", Name: "fix"})
			if tt.prep != nil {
				tt.prep(fake)
			}
			res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s1"}, tt.verb, nil)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Contains(fake.Calls(), tt.wantCall) {
				t.Errorf("calls %q", fake.Calls())
			}
			for _, want := range tt.wantMsg {
				if !strings.Contains(res.Message, want) {
					t.Errorf("message %q", res.Message)
				}
			}
		})
	}
}

package api

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A thread checkout carries the git operation in progress with git's step counters (the
// thread info card shows "rebase 2/5"); a checkout the project does not list has no status.
func TestCheckoutsToProtoOperation(t *testing.T) {
	tests := []struct {
		name               string
		c                  thread.Checkout
		wantStatus         bool
		op                 string
		wantStep, wantLast int32
	}{
		{name: "rebase with steps", wantStatus: true, op: project.OpRebase, wantStep: 2, wantLast: 5,
			c: thread.Checkout{Git: true, Listed: true, Status: project.Status{Operation: project.OpRebase, OperationStep: 2, OperationTotal: 5}}},
		{name: "merge has no steps", wantStatus: true, op: project.OpMerge,
			c: thread.Checkout{Git: true, Listed: true, Status: project.Status{Operation: project.OpMerge}}},
		{name: "not listed", c: thread.Checkout{Git: true, Status: project.Status{Operation: project.OpRebase, OperationStep: 1, OperationTotal: 2}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := checkoutsToProto(thread.ThreadCheckouts{Checkouts: []thread.Checkout{tt.c}})
			st := res.GetCheckouts()[0].GetStatus()
			if (st != nil) != tt.wantStatus {
				t.Fatalf("status %v, want present %v", st, tt.wantStatus)
			}
			if st.GetOperation() != tt.op || st.GetOperationStep() != tt.wantStep || st.GetOperationTotal() != tt.wantLast {
				t.Errorf("operation %q %d/%d, want %q %d/%d", st.GetOperation(), st.GetOperationStep(), st.GetOperationTotal(), tt.op, tt.wantStep, tt.wantLast)
			}
		})
	}
}

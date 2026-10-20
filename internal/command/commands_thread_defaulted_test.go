package command_test

import (
	"context"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.new marks a model or effort the settings' default filled in as defaulted, so a
// resident's worker defaults may replace it; an explicit one is not.
func TestThreadNewDefaultedModel(t *testing.T) {
	tests := []struct {
		name                string
		args                map[string]string
		wantModel, wantEff  string
		modelDef, effortDef bool
	}{
		{"both from the settings", map[string]string{}, "claude-sonnet-5[1m]", "medium", true, true},
		{"explicit model", map[string]string{"model": "claude-haiku-5-5[1m]"}, "claude-haiku-5-5[1m]", "medium", false, true},
		{"both explicit", map[string]string{"model": "claude-haiku-5-5[1m]", "effort": "low"}, "claude-haiku-5-5[1m]", "low", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			reg.SetOverrides(command.Overrides{ArgDefaults: map[string]map[string]string{
				"thread.new": {"model": "claude-sonnet-5[1m]", "effort": "medium"},
			}})
			args := map[string]string{"project": "r1"}
			for k, v := range tt.args {
				args[k] = v
			}
			if _, err := reg.Invoke(context.Background(), command.Context{}, "thread.new", args); err != nil {
				t.Fatal(err)
			}
			reqs := b.Requests()
			if len(reqs) != 1 {
				t.Fatalf("requests = %v", reqs)
			}
			r, ok := reqs[0].(*v1.CreateThreadRequest)
			if !ok {
				t.Fatalf("request = %T", reqs[0])
			}
			if r.GetModel() != tt.wantModel || r.GetEffort() != tt.wantEff || r.GetModelDefaulted() != tt.modelDef || r.GetEffortDefaulted() != tt.effortDef {
				t.Errorf("request = %v", r)
			}
		})
	}
}

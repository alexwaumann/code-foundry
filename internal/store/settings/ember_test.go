package settings

import (
	"strings"
	"testing"
)

func TestEmberDefaults(t *testing.T) {
	d := Defaults().Ember
	want := Ember{
		Enabled: false, Model: "claude-opus-4-8[1m]", Effort: "high",
		WorkerModels: "claude-opus-4-7[1m],claude-opus-4-8[1m]", WorkerEffort: "high",
		EpochContextTokens: 400000, EpochMaxHours: 24,
	}
	if d != want {
		t.Errorf("Defaults().Ember = %+v, want %+v", d, want)
	}
	if f := field(t, KeyEmberEnabled); f.Page != PageEmber || !strings.HasPrefix(f.Description, "Experimental: ") {
		t.Errorf("enabled field = %+v", f)
	}
	if f := field(t, KeyEmberEpochTokens); f.Min != 20000 {
		t.Errorf("epoch tokens min = %d", f.Min)
	}
}

func TestEmberWorkerModels(t *testing.T) {
	tests := []struct {
		raw, want, issue string
	}{
		{raw: "claude-haiku-5-5[1m]", want: "claude-haiku-5-5[1m]"},
		{raw: "claude-opus-4-8[1m], claude-sonnet-5[1m]", want: "claude-opus-4-8[1m], claude-sonnet-5[1m]"},
		{raw: "claude-opus-4-8", want: "claude-opus-4-7[1m],claude-opus-4-8[1m]", issue: `unknown model "claude-opus-4-8"`},
		{raw: "claude-opus-4-8[1m],claude-opus-4-8[1m]", want: "claude-opus-4-7[1m],claude-opus-4-8[1m]", issue: "listed twice"},
		{raw: " , ", want: "claude-opus-4-7[1m],claude-opus-4-8[1m]", issue: "at least one"},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			r := resolve(map[string]string{KeyEmberWorkerModels: tt.raw}, nil)
			if got := r.settings.Ember.WorkerModels; got != tt.want {
				t.Errorf("value = %q, want %q", got, tt.want)
			}
			var issue string
			for _, is := range r.issues {
				if is.Key == KeyEmberWorkerModels {
					issue = is.Message
				}
			}
			if (tt.issue == "") != (issue == "") || !strings.Contains(issue, tt.issue) {
				t.Errorf("issue = %q, want %q", issue, tt.issue)
			}
		})
	}
	if got := SplitList(" a, ,b ,"); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("SplitList = %q", got)
	}
}

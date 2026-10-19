package thread

import "testing"

// The daemon's "request answered" line names the decision as thread.respond does.
func TestDecisionWord(t *testing.T) {
	tests := []struct {
		d    Decision
		want string
	}{
		{Decision{Allow: true}, "allow"},
		{Decision{Allow: true, ForSession: true}, "allow-session"},
		{Decision{Allow: true, Answers: map[string]string{"Which?": "A"}}, "answer"},
		{Decision{Message: "no", Interrupt: true}, "deny"},
	}
	for _, tt := range tests {
		if got := tt.d.word(); got != tt.want {
			t.Errorf("%+v.word() = %q, want %q", tt.d, got, tt.want)
		}
	}
}

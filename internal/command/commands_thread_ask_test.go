package command_test

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread ask's reply tells the thread how the answer reaches it and not to wait for it
// with tool calls; a repeated question sends nothing and says only that.
func TestThreadAskReply(t *testing.T) {
	tests := []struct {
		name     string
		repeated bool
		want     []string
		wantNot  []string
	}{
		{name: "asked", want: []string{"asked thread Lead (s-lead); keep working on your assumption", command.AskAnswerRule}},
		{name: "asked again", repeated: true, want: []string{"you just asked thread Lead (s-lead) that; nothing was sent"}, wantNot: []string{command.AskAnswerRule}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current, b.AskRepeated = &v1.Thread{Id: "s-lead", Name: "Lead"}, tt.repeated
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.ask", map[string]string{"id": "s-w", "question": "Which?", "assuming": "the first"})
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tt.want {
				if !strings.Contains(res.Message, want) {
					t.Errorf("message %q lacks %q", res.Message, want)
				}
			}
			for _, not := range tt.wantNot {
				if strings.Contains(res.Message, not) {
					t.Errorf("message %q has %q", res.Message, not)
				}
			}
		})
	}
}

// The help and the rule itself say both halves: where the answer arrives, and not to wait
// for it with tool calls.
func TestThreadAskHelp(t *testing.T) {
	reg, _, _ := newLifecycleRegistry(t)
	c, ok := reg.Get("thread.ask")
	if !ok {
		t.Fatal("thread.ask is not registered")
	}
	if !strings.Contains(c.Description, command.AskAnswerRule) {
		t.Errorf("description %q", c.Description)
	}
	for _, want := range []string{"as a new turn once yours has ended", "sleep, a timer or polling", "end your turn"} {
		if !strings.Contains(command.AskAnswerRule, want) {
			t.Errorf("rule %q lacks %q", command.AskAnswerRule, want)
		}
	}
}

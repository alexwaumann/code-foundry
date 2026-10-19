package command_test

import (
	"context"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// thread read marks a message Claude has not read yet (docs/notes/orch-queued-placement.md),
// a wake too; once read the mark goes.
func TestThreadReadQueued(t *testing.T) {
	tests := []struct {
		name string
		item thread.Item
		want string
	}{
		{"queued message", thread.Item{ID: "u2", Kind: thread.KindUserMessage, Text: "status?", Queued: true}, "#2 you: status? (queued)"},
		{"queued wake", thread.Item{ID: "w", Kind: thread.KindUserMessage, Text: "wake", Origin: thread.OriginWake, WakeTitle: "Thread s2 is idle: finished.", Queued: true},
			"#2 wake: Thread s2 is idle: finished. (queued)"},
		{"read message", thread.Item{ID: "u2", Kind: thread.KindUserMessage, Text: "status?"}, "#2 you: status?"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			fake.PutItems("s1", thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "go"}, tt.item)
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.read", map[string]string{"id": "s1", "last": "1"})
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Errorf("read = %q, want %q", res.Message, tt.want)
			}
		})
	}
}

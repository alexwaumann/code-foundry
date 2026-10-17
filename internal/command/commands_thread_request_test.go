package command_test

import (
	"context"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.new --request-id sends the key; a reused thread prints so, focuses nothing and
// answers the thread as JSON, as the first time.
func TestThreadNewRequestID(t *testing.T) {
	for _, reused := range []bool{false, true} {
		reg, b, e := newLifecycleRegistry(t)
		b.Reused = reused
		res, err := reg.Invoke(context.Background(), command.Context{}, "thread.new",
			map[string]string{"project": "r1", "request-id": "k1", "name": "fix"})
		if err != nil {
			t.Fatal(err)
		}
		reqs := b.Requests()
		want := &v1.CreateThreadRequest{ProjectId: "r1", Name: "fix", RequestId: "k1", PermissionMode: v1.PermissionMode_PERMISSION_MODE_AUTO}
		if len(reqs) != 1 || !proto.Equal(reqs[0], want) {
			t.Errorf("requests = %v", reqs)
		}
		wantMsg, wantIntents := "created thread fix (s1) in ", 1
		if reused {
			wantMsg, wantIntents = "thread fix (s1) in  was created earlier for request id k1; nothing new started", 0
		}
		if res.Message != wantMsg || len(e.Intents()) != wantIntents {
			t.Errorf("reused %v: message %q, %d intents", reused, res.Message, len(e.Intents()))
		}
		if s, ok := res.JSON.(*v1.Thread); !ok || s.GetId() != "s1" {
			t.Errorf("JSON = %v", res.JSON)
		}
	}
}

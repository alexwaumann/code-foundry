package api

import (
	"context"
	"maps"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// SetPageStorage sets and removes (no value) a key and answers the storage after;
// PageStorage reads it back; the store's errors map to codes.
func TestPageStorage(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	fake.Put(thread.Thread{ID: "s-1"})
	h := NewThread(fake, b)
	ctx := context.Background()
	set := func(key string, value *string) (map[string]string, error) {
		res, err := h.SetPageStorage(ctx, connect.NewRequest(&v1.SetPageStorageRequest{ThreadId: "s-1", Key: key, Value: value}))
		if err != nil {
			return nil, err
		}
		return res.Msg.GetValues(), nil
	}
	if got, err := set("a", proto.String(`{"n":1}`)); err != nil || !maps.Equal(got, map[string]string{"a": `{"n":1}`}) {
		t.Fatalf("set a = %v, %v", got, err)
	}
	if got, err := set("b", proto.String(`2`)); err != nil || len(got) != 2 {
		t.Fatalf("set b = %v, %v", got, err)
	}
	if got, err := set("a", nil); err != nil || !maps.Equal(got, map[string]string{"b": "2"}) {
		t.Fatalf("remove a = %v, %v", got, err)
	}
	res, err := h.PageStorage(ctx, connect.NewRequest(&v1.PageStorageRequest{ThreadId: "s-1"}))
	if err != nil || !maps.Equal(res.Msg.GetValues(), map[string]string{"b": "2"}) {
		t.Fatalf("PageStorage = %v, %v", res, err)
	}
	if _, err := set("c", proto.String("{oops")); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("not JSON: %v, want InvalidArgument", err)
	}
	if _, err := h.PageStorage(ctx, connect.NewRequest(&v1.PageStorageRequest{ThreadId: "s-9"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown thread: %v, want NotFound", err)
	}
}

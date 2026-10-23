package api

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// ShowTheme carries the card to the store and back: the file through FromProto and
// ToProto unchanged, applied and previous as sent.
func TestShowTheme(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	fake.Put(thread.Thread{ID: "s-1"})
	h := NewThread(fake, b)
	f, ok := theme.Curated("nord")
	if !ok {
		t.Fatal("no nord")
	}
	f.ID, f.Name, f.From = "nord-warmer", "Nord, warmer", "nord"
	f.Overrides = map[string]string{"--cf-sidebar-row-selected": "#3b4252"}
	want := &v1.ThemeItem{Theme: theme.ToProto(f, ""), Applied: true, Previous: "github-dark", PreviousGone: true}
	res, err := h.ShowTheme(context.Background(), connect.NewRequest(&v1.ShowThreadThemeRequest{ThreadId: "s-1", Theme: want}))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Msg.GetItem().GetTheme(); !proto.Equal(got, want) {
		t.Errorf("item theme = %v, want %v", got, want)
	}
	if _, err := h.ShowTheme(context.Background(), connect.NewRequest(&v1.ShowThreadThemeRequest{ThreadId: "s-9", Theme: want})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown thread: %v, want NotFound", err)
	}
}

package command_test

import (
	"context"
	"errors"
	"testing"

	"github.com/awaumann/code-foundry/internal/command"
	"github.com/awaumann/code-foundry/internal/command/commandtest"
)

func TestViewPullRequestsEmitsShowView(t *testing.T) {
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1}
	if err := command.RegisterView(reg, emit, func(context.Context, string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(context.Background(), command.Context{}, "view.pullrequests", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Message != "" || res.JSON != (command.EmitResult{Delivered: 1}) {
		t.Errorf("result = %+v, want no message and delivered 1", res)
	}
	got := emit.Intents()
	if len(got) != 1 || got[0].GetShowView().GetName() != command.ViewPullRequests {
		t.Errorf("intents = %v, want one ShowView %q", got, command.ViewPullRequests)
	}
}

func TestViewOpenURL(t *testing.T) {
	tests := []struct {
		url     string
		wantErr error // nil: opened
	}{
		{"https://github.com/o/r/pull/1", nil},
		{"http://localhost:8080/x", nil},
		{"file:///etc/passwd", command.ErrInvalidArgs},
		{"javascript:alert(1)", command.ErrInvalidArgs},
		{"github.com/o/r", command.ErrInvalidArgs},
		{"https://", command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			var opened []string
			reg := command.NewRegistry()
			if err := command.RegisterView(reg, &commandtest.Emitter{}, func(_ context.Context, u string) error {
				opened = append(opened, u)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(context.Background(), command.Context{}, "view.open.url", map[string]string{"url": tt.url})
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) || len(opened) != 0 {
					t.Errorf("err = %v, opened = %v; want %v and nothing opened", err, opened, tt.wantErr)
				}
				return
			}
			if err != nil || len(opened) != 1 || opened[0] != tt.url {
				t.Errorf("err = %v, opened = %v; want %q", err, opened, tt.url)
			}
		})
	}
}

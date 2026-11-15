package api

import (
	"context"
	"slices"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

func TestSetIncludeIgnored(t *testing.T) {
	fake := projecttest.New(nil)
	fake.Put(project.Project{ID: "p", Name: "proj", Path: "/src/proj", Git: true})
	h := NewProject(fake, bus.New())
	ctx := context.Background()
	tests := []struct {
		name string
		req  *v1.SetIncludeIgnoredRequest
		want []string
		code connect.Code
	}{
		{name: "set", req: &v1.SetIncludeIgnoredRequest{Id: "p", Patterns: []string{" dist/ ", ".env*", "dist/"}}, want: []string{"dist/", ".env*"}},
		{name: "cleared", req: &v1.SetIncludeIgnoredRequest{Id: "p"}, want: nil},
		{name: "invalid", req: &v1.SetIncludeIgnoredRequest{Id: "p", Patterns: []string{"!x"}}, code: connect.CodeInvalidArgument},
		{name: "unknown", req: &v1.SetIncludeIgnoredRequest{Id: "nope", Patterns: []string{"x"}}, code: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := h.SetIncludeIgnored(ctx, connect.NewRequest(tt.req))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Fatalf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil || !slices.Equal(res.Msg.GetProject().GetIncludeIgnored(), tt.want) {
				t.Fatalf("= %v, %v; want %q", res, err, tt.want)
			}
		})
	}
}

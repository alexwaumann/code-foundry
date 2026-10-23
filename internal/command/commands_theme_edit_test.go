package command_test

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

func TestThemeEdit(t *testing.T) {
	themes := usertheme.New(usertheme.Options{Dir: filepath.Join(t.TempDir(), "themes"), Log: slog.New(slog.DiscardHandler)})
	themes.Load()
	f, _ := theme.Curated("github-dark")
	f.ID, f.Name, f.Pair, f.From = "ocean-dusk", "Ocean Dusk", "", "github-dark"
	if _, err := themes.Save(f); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		uctx    command.Context
		args    map[string]string
		view    string
		msg     string
		wantErr string
	}{
		{name: "from the CLI", args: map[string]string{"theme": "ocean-dusk"}, view: "themes.edit.ocean-dusk", msg: "editing ocean-dusk in the Themes page (windows=2)"},
		{name: "from the GUI the page is the feedback", uctx: command.Context{ActiveView: "themes"}, args: map[string]string{"theme": "ocean-dusk"}, view: "themes.edit.ocean-dusk"},
		{name: "a curated theme is not one of yours", args: map[string]string{"theme": "nord"}, wantErr: `argument "theme": want one of ocean-dusk`},
		{name: "no theme", wantErr: `"theme"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 2, OpenWindows: 2}
			if err := command.RegisterThemeEdit(reg, emit, themes); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.uctx, "theme.edit", tt.args)
			if tt.wantErr != "" {
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want invalid args %q", err, tt.wantErr)
				}
				if len(emit.Intents()) != 0 {
					t.Fatal("emitted for a refused call")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.msg {
				t.Errorf("message = %q, want %q", res.Message, tt.msg)
			}
			if in := emit.Intents(); len(in) != 1 || in[0].GetShowView().GetName() != tt.view {
				t.Fatalf("intents = %v, want ShowView %q", in, tt.view)
			}
		})
	}
	// The palette's pick list is the user's themes, read again at every List.
	reg := command.NewRegistry()
	if err := command.RegisterThemeEdit(reg, &commandtest.Emitter{}, themes); err != nil {
		t.Fatal(err)
	}
	c, _ := reg.Get("theme.edit")
	if got := c.Args[0].EnumFunc(); !slices.Equal(got, []string{"ocean-dusk"}) {
		t.Errorf("enum = %v", got)
	}
	// Without a themes store the verb says so.
	reg = command.NewRegistry()
	if err := command.RegisterThemeEdit(reg, &commandtest.Emitter{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Invoke(context.Background(), command.Context{}, "theme.edit", map[string]string{"theme": "x"}); connect.CodeOf(err) != connect.CodeUnimplemented && !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("no store: %v", err)
	}
}

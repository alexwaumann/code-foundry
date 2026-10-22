package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestThemePickShowsThemesPage(t *testing.T) {
	tests := []struct {
		name    string
		args    map[string]string
		view    string
		wantErr string
	}{
		{name: "no slot edits the one in use", view: command.ViewThemes},
		{name: "dark slot", args: map[string]string{"slot": "dark"}, view: "themes.dark"},
		{name: "light slot", args: map[string]string{"slot": "light"}, view: "themes.light"},
		{name: "unknown slot", args: map[string]string{"slot": "sepia"}, wantErr: `argument "slot": want one of dark, light`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 2, OpenWindows: 2}
			if err := command.RegisterThemePick(reg, emit); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, "theme.pick", tt.args)
			if tt.wantErr != "" {
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want invalid args %q", err, tt.wantErr)
				}
				if n := len(emit.Intents()); n != 0 {
					t.Fatalf("emitted %d intents for a refused call", n)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != "windows=2" {
				t.Errorf("message = %q, want windows=2 (from the CLI)", res.Message)
			}
			if got, ok := res.JSON.(command.EmitResult); !ok || got != (command.EmitResult{Windows: 2, Receivers: 2}) {
				t.Errorf("json = %#v, want 2 windows and receivers", res.JSON)
			}
			intents := emit.Intents()
			if len(intents) != 1 || intents[0].GetShowView().GetName() != tt.view {
				t.Fatalf("intents = %v, want one ShowView %q", intents, tt.view)
			}
		})
	}
}

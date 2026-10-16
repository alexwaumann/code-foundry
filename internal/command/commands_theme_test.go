package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
)

func TestThemeCommands(t *testing.T) {
	store, err := settingstest.New(context.Background(), t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	reg := command.NewRegistry()
	if err := command.RegisterTheme(reg, api.NewSettings(store)); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		cmd      string
		args     map[string]string
		wantMsg  []string // substrings of the message
		wantJSON string   // substring of the JSON
		wantErr  string   // substring of the error
	}{
		{name: "list marks the defaults", cmd: "theme.list",
			wantMsg:  []string{"scheme: system (appearance.theme)", "dark themes (appearance.theme_dark):\n* github-dark ", "  dracula ", "light themes (appearance.theme_light):\n* github-light "},
			wantJSON: `"scheme":"system","dark":"github-dark","light":"github-light"`},
		{name: "set dark", cmd: "theme.set-dark", args: map[string]string{"theme": "dracula"},
			wantMsg: []string{"dark theme = Dracula (dracula)"}, wantJSON: `{"key":"appearance.theme_dark","id":"dracula","name":"Dracula","scheme":"dark"}`},
		{name: "set light", cmd: "theme.set-light", args: map[string]string{"theme": "rose-pine-dawn"},
			wantMsg: []string{"light theme = Rosé Pine Dawn (rose-pine-dawn)"}},
		{name: "list follows", cmd: "theme.list", wantMsg: []string{"* dracula ", "* rose-pine-dawn ", "  github-dark "},
			wantJSON: `{"id":"dracula","name":"Dracula","scheme":"dark","selected":true}`},
		{name: "light id in the dark slot", cmd: "theme.set-dark", args: map[string]string{"theme": "catppuccin-latte"},
			wantErr: `argument "theme": want one of github-dark, catppuccin-mocha, graphite-dark`},
		{name: "unknown id", cmd: "theme.set-light", args: map[string]string{"theme": "sepia"}, wantErr: `got "sepia"`},
		{name: "missing id", cmd: "theme.set-dark", wantErr: `missing required argument "theme"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			if tt.wantErr != "" {
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want invalid args %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.wantMsg {
				if !strings.Contains(res.Message, w) {
					t.Errorf("message lacks %q:\n%s", w, res.Message)
				}
			}
			js, _ := json.Marshal(res.JSON)
			if !strings.Contains(string(js), tt.wantJSON) {
				t.Errorf("json = %s, want %s", js, tt.wantJSON)
			}
		})
	}
	// A theme for the scheme not in use says how to see it.
	if _, err := store.Update(context.Background(), map[string]string{"appearance.theme": "light"}); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(context.Background(), command.Context{}, "theme.set-dark", map[string]string{"theme": "nord"})
	if err != nil || !strings.Contains(res.Message, "the scheme is light, so it shows after `code-foundry settings set appearance.theme dark`") {
		t.Fatalf("message = %q, %v", res.Message, err)
	}
}

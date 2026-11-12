package command_test

import (
	"context"
	"maps"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// pane.fullscreen is window state: one ShowView with the mode and the pane, nothing else.
func TestPaneFullscreen(t *testing.T) {
	app := command.Context{ActiveView: "thread", ActiveThreadID: "s1"}
	cli := command.Context{Origin: command.OriginCLI}
	inThread := command.Context{Origin: command.OriginCLI, ActiveThreadID: "s-me0000000001"}
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		want    map[string]string
		wantErr bool
	}{
		{name: "the app toggles the focused pane", ctx: app, want: map[string]string{"mode": "toggle"}},
		{name: "the CLI turns it on for a pane", ctx: cli, args: map[string]string{"on": "true", "pane": "p-aaaaaaaa"}, want: map[string]string{"mode": "on", "pane": "p-aaaaaaaa"}},
		{name: "off", ctx: cli, args: map[string]string{"off": "true"}, want: map[string]string{"mode": "off"}},
		{name: "on and off together", ctx: cli, args: map[string]string{"on": "true", "off": "true"}, wantErr: true},
		{name: "a pane with off", ctx: cli, args: map[string]string{"off": "true", "pane": "p-aaaaaaaa"}, wantErr: true},
		{name: "from inside a thread it never takes the view unasked", ctx: inThread, wantErr: true},
		{name: "from inside a thread with --focus", ctx: inThread, args: map[string]string{"focus": "true"}, want: map[string]string{"mode": "toggle"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
			if err := command.RegisterView(reg, command.ViewDeps{Emitter: emit, Thread: &commandtest.Thread{}}); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(context.Background(), tt.ctx, "pane.fullscreen", tt.args)
			if tt.wantErr {
				if err == nil {
					t.Fatal("want an error")
				}
				if len(emit.Intents()) != 0 {
					t.Errorf("a refusal emitted %v", emit.Intents())
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := emit.Intents()
			if len(got) != 1 || got[0].GetShowView().GetName() != command.ViewPaneFullscreen {
				t.Fatalf("intents = %v, want one ShowView %q", got, command.ViewPaneFullscreen)
			}
			if params := got[0].GetShowView().GetParams(); !maps.Equal(params, tt.want) {
				t.Errorf("params = %v, want %v", params, tt.want)
			}
		})
	}
}

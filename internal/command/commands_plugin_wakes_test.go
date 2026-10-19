package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestPluginWakes(t *testing.T) {
	b := &commandtest.Plugin{Plugins: []*v1.Plugin{
		{Name: "gh", DisplayName: "GitHub", Version: "0.1.0", State: v1.PluginState_PLUGIN_STATE_RUNNING, Enabled: true, Permissions: &v1.PluginPermissions{},
			Wakes: []*v1.PluginWake{{Name: "checks-done", Title: "Checks done", Description: "Every check on the head completed.", Scope: "pr",
				SubscribeLine: "code-foundry thread subscribe --plugin gh/checks-done",
				Args: []*v1.PluginWakeArg{
					{Name: "pr", Type: "string", Required: true, Context: "pr", Description: "owner/name#123"},
					{Name: "conclusion", Type: "enum", EnumValues: []string{"success", "failure"}},
				}}}},
		{Name: "hello", Version: "0.1.0", State: v1.PluginState_PLUGIN_STATE_DISABLED, Permissions: &v1.PluginPermissions{},
			Wakes: []*v1.PluginWake{{Name: "tick", Title: "Tick", Scope: "global", SubscribeLine: "code-foundry thread subscribe --plugin hello/tick",
				Args: []*v1.PluginWakeArg{{Name: "every", Type: "duration", DefaultValue: "10s", Description: "How often"}}}}},
		{Name: "quiet", Version: "1.0.0", State: v1.PluginState_PLUGIN_STATE_RUNNING, Enabled: true, Permissions: &v1.PluginPermissions{}},
	}}
	reg := command.NewRegistry()
	if err := command.RegisterPlugin(reg, b); err != nil {
		t.Fatal(err)
	}
	invoke := func(args map[string]string) (command.Result, error) {
		return reg.Invoke(context.Background(), command.Context{}, "plugin.wakes", args)
	}
	res, err := invoke(nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "gh/checks-done — Checks done (scope pr)\n" +
		"  Every check on the head completed.\n" +
		"  --arg pr=… (string, required, default this thread's pull request): owner/name#123\n" +
		"  --arg conclusion=… (enum success|failure)\n" +
		"  code-foundry thread subscribe --plugin gh/checks-done\n" +
		"\n" +
		"hello/tick — Tick (scope global) [plugin disabled: enable it to subscribe]\n" +
		"  --arg every=… (duration, default 10s): How often\n" +
		"  code-foundry thread subscribe --plugin hello/tick"
	if res.Message != want {
		t.Errorf("message =\n%s\nwant\n%s", res.Message, want)
	}
	js, err := res.EncodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Sources []command.WakeSourceJSON `json:"sources"`
	}
	if err := json.Unmarshal([]byte(js), &out); err != nil || len(out.Sources) != 2 || out.Sources[0].Target != "gh/checks-done" ||
		out.Sources[0].Args[0].Context != "pr" || out.Sources[1].Enabled || out.Sources[1].State != "disabled" {
		t.Errorf("json = %s (%v)", js, err)
	}

	if res, err := invoke(map[string]string{"name": "hello"}); err != nil || strings.Contains(res.Message, "gh/") || !strings.HasPrefix(res.Message, "hello/tick") {
		t.Errorf("hello = %q, %v", res.Message, err)
	}
	if res, err := invoke(map[string]string{"name": "quiet"}); err != nil || res.Message != "plugin quiet declares no wake sources" {
		t.Errorf("quiet = %q, %v", res.Message, err)
	}
	if _, err := invoke(map[string]string{"name": "nope"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("nope = %v", err)
	}
	list, err := reg.Invoke(context.Background(), command.Context{}, "plugin.list", nil)
	if err != nil || !strings.Contains(list.Message, " checks-done ") || !strings.Contains(list.Message, " tick ") {
		t.Errorf("plugin list =\n%s\n%v", list.Message, err)
	}
	empty := &commandtest.Plugin{}
	reg = command.NewRegistry()
	if err := command.RegisterPlugin(reg, empty); err != nil {
		t.Fatal(err)
	}
	if res, err := reg.Invoke(context.Background(), command.Context{}, "plugin.wakes", nil); err != nil || res.Message != "no plugin declares wake sources" {
		t.Errorf("none = %q, %v", res.Message, err)
	}
}

package api

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// pluginWakesToProto maps a manifest's wake sources (docs/notes/plugins-wake-sources.md),
// with each one's shortest subscribe line.
func pluginWakesToProto(name string, wakes []pluginsdk.WakeSpec) []*v1.PluginWake {
	var out []*v1.PluginWake
	for _, w := range wakes {
		pw := &v1.PluginWake{Name: w.Name, Title: w.Title, Description: w.Description, Scope: w.ScopeOr(),
			SubscribeLine: plugin.WakeSubscribeLine(name, w)}
		for _, a := range w.Args {
			pw.Args = append(pw.Args, &v1.PluginWakeArg{Name: a.Name, Type: a.TypeOr(), Description: a.Description, Required: a.Required,
				EnumValues: a.Enum, DefaultValue: a.Default, Context: a.Context})
		}
		out = append(out, pw)
	}
	return out
}

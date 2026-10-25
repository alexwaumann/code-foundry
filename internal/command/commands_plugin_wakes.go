package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// plugin.wakes (docs/notes/plugins-wake-sources.md): the plugins' wake sources, the
// events a thread subscribes to with `thread subscribe --plugin <plugin>/<source>`,
// with their args and the line that subscribes.

// WakeSourceJSON is one wake source in plugin.wakes --json.
type WakeSourceJSON struct {
	Plugin      string        `json:"plugin"`
	DisplayName string        `json:"displayName"`
	Enabled     bool          `json:"enabled"`
	State       string        `json:"state"`
	Target      string        `json:"target"`
	Name        string        `json:"name"`
	Title       string        `json:"title"`
	Description string        `json:"description,omitempty"`
	Scope       string        `json:"scope"`
	Args        []WakeArgJSON `json:"args"`
	Subscribe   string        `json:"subscribe"`
}

// WakeArgJSON is one arg of a wake source in plugin.wakes --json.
type WakeArgJSON struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Description string   `json:"description,omitempty"`
	Required    bool     `json:"required,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	Default     string   `json:"default,omitempty"`
	Context     string   `json:"context,omitempty"`
}

func pluginWakesCmd(b PluginBackend) Command {
	return Command{
		Name:     "plugin.wakes",
		ReadOnly: true,
		Title:    "List Plugin Wake Sources",
		Description: "List the plugins' wake sources: events a thread waits for with `code-foundry thread subscribe --plugin <plugin>/<source>` " +
			"instead of polling. Each with its args (which default from the subscribing thread: its id, pull request or project), " +
			"its scope and the line that subscribes.",
		Category:     "Plugin",
		NoKeybinding: true,
		Args:         []ArgSpec{{Name: "name", Type: String, Positional: true, Description: "Only this plugin's (default: every plugin's)"}},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.List(ctx, connect.NewRequest(&v1.ListPluginsRequest{}))
			if err != nil {
				return Result{}, err
			}
			name := strings.TrimSpace(a.String("name"))
			found := name == ""
			out := struct {
				Sources []WakeSourceJSON `json:"sources"`
			}{Sources: []WakeSourceJSON{}}
			for _, p := range res.Msg.GetPlugins() {
				if name != "" && p.GetName() != name {
					continue
				}
				found = true
				for _, w := range p.GetWakes() {
					out.Sources = append(out.Sources, wakeSourceJSON(p, w))
				}
			}
			switch {
			case !found:
				return Result{}, InvalidArg("name", "no plugin %q (code-foundry plugin list)", name)
			case len(out.Sources) == 0 && name != "":
				return Result{Message: "plugin " + name + " declares no wake sources", JSON: out}, nil
			case len(out.Sources) == 0:
				return Result{Message: "no plugin declares wake sources", JSON: out}, nil
			}
			return Result{Message: formatWakeSources(out.Sources), JSON: out}, nil
		},
	}
}

func wakeSourceJSON(p *v1.Plugin, w *v1.PluginWake) WakeSourceJSON {
	s := WakeSourceJSON{Plugin: p.GetName(), DisplayName: p.GetDisplayName(), Enabled: p.GetEnabled(), State: pluginState(p.GetState()),
		Target: p.GetName() + "/" + w.GetName(), Name: w.GetName(), Title: w.GetTitle(), Description: w.GetDescription(),
		Scope: w.GetScope(), Args: []WakeArgJSON{}, Subscribe: w.GetSubscribeLine()}
	for _, a := range w.GetArgs() {
		s.Args = append(s.Args, WakeArgJSON{Name: a.GetName(), Type: a.GetType(), Description: a.GetDescription(), Required: a.GetRequired(),
			Enum: a.GetEnumValues(), Default: a.GetDefaultValue(), Context: a.GetContext()})
	}
	return s
}

// wakeContextWords says what a context arg defaults to.
var wakeContextWords = map[string]string{
	"thread":  "this thread's id",
	"pr":      "this thread's pull request",
	"project": "this thread's project",
}

// formatWakeSources is plugin.wakes' text: per source a heading, its description, its
// args and the subscribe line.
func formatWakeSources(sources []WakeSourceJSON) string {
	var sb strings.Builder
	for i, s := range sources {
		if i > 0 {
			sb.WriteString("\n")
		}
		fmt.Fprintf(&sb, "%s — %s (scope %s)", s.Target, s.Title, s.Scope)
		if !s.Enabled {
			fmt.Fprintf(&sb, " [plugin %s: enable it to subscribe]", s.State)
		}
		sb.WriteString("\n")
		if s.Description != "" {
			fmt.Fprintf(&sb, "  %s\n", s.Description)
		}
		for _, a := range s.Args {
			var notes []string
			typ := a.Type
			if len(a.Enum) > 0 {
				typ += " " + strings.Join(a.Enum, "|")
			}
			notes = append(notes, typ)
			if a.Required {
				notes = append(notes, "required")
			}
			if w, ok := wakeContextWords[a.Context]; ok {
				notes = append(notes, "default "+w)
			} else if a.Default != "" {
				notes = append(notes, "default "+a.Default)
			}
			line := fmt.Sprintf("  --arg %s=… (%s)", a.Name, strings.Join(notes, ", "))
			if a.Description != "" {
				line += ": " + a.Description
			}
			sb.WriteString(line + "\n")
		}
		fmt.Fprintf(&sb, "  %s\n", s.Subscribe)
	}
	return strings.TrimRight(sb.String(), "\n")
}

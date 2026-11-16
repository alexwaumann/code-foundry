package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// plugin.removals (docs/notes/plugin-flag-retirement.md): the plugin SDK's removal list
// as this daemon's SDK has it (pluginsdk.Removals): every call on its way out, its
// stage, since when, and what replaces it. For a person ("what is marked for removal and
// since when") and for an agent checking a plugin's code against it (--json).

// RemovalsView is plugin.removals' JSON.
type RemovalsView struct {
	Removals []pluginsdk.Removal `json:"removals"`
}

// RegisterPluginRemovals registers plugin.removals.
func RegisterPluginRemovals(r *Registry) error {
	return r.Register(Command{
		Name:      "plugin.removals",
		NoPalette: true,
		ReadOnly:  true,
		Title:     "Show Plugin SDK Removals",
		Description: "Print the plugin SDK calls on their way out: each one's stage (deprecated: still works; retired: " +
			"does nothing and logs a warning), the day it got there, the protocol method, what replaces it and how to move.",
		Category:     "Plugin",
		NoKeybinding: true,
		Run: func(context.Context, Context, Args) (Result, error) {
			rs := pluginsdk.Removals
			if rs == nil {
				rs = []pluginsdk.Removal{}
			}
			return Result{Message: formatRemovals(rs), JSON: RemovalsView{Removals: rs}}, nil
		},
	})
}

// formatRemovals is the list, an entry a block: the call, its stage and since when,
// what replaces it, the move and what else it covers.
func formatRemovals(rs []pluginsdk.Removal) string {
	if len(rs) == 0 {
		return "nothing in the plugin SDK is marked for removal"
	}
	blocks := make([]string, len(rs))
	for i, r := range rs {
		head := r.Symbol()
		if r.Method != "" {
			head += " (" + r.Method + ")"
		}
		lines := []string{fmt.Sprintf("%s: %s since %s", head, r.Stage, r.Since())}
		if r.Stage == pluginsdk.StageRetired {
			lines = append(lines, "  deprecated "+r.Deprecated+"; does nothing now")
		}
		lines = append(lines, "  use: "+r.Replacement, "  move: "+r.Hint)
		if len(r.Symbols) > 1 {
			lines = append(lines, "  also: "+strings.Join(r.Symbols[1:], ", "))
		}
		blocks[i] = strings.Join(lines, "\n")
	}
	return strings.Join(blocks, "\n\n")
}

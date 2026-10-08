package settings

import (
	"fmt"
	"slices"
	"strings"

	"github.com/awaumann/code-foundry/internal/command"
)

func isKeybindingKey(k string) bool { return strings.HasPrefix(k, keybindingKeyPrefix) }

// resolveKeybindings validates the keybinding overrides in raw. Each must parse (see
// command.ValidateBinding) or be "none", and, once cmds is known, name a registered
// command and not collide with another command's effective chord. A rejected override
// is reported and the command keeps its default. Overrides may swap chords: A and B can
// trade defaults in one change.
//
// It returns the accepted overrides (command -> canonical chord or "none"), every
// command's effective value by settings key, and the issues.
func resolveKeybindings(raw map[string]string, cmds []CommandInfo) (map[string]string, map[string]string, []Issue) {
	var issues []Issue
	known := make(map[string]CommandInfo, len(cmds))
	for _, c := range cmds {
		known[c.Name] = c
	}
	over := map[string]string{}
	field := Field{Type: Keybinding}
	for k, v := range raw {
		if !isKeybindingKey(k) || v == "" {
			continue
		}
		name := strings.TrimPrefix(k, keybindingKeyPrefix)
		if cmds != nil {
			if _, ok := known[name]; !ok {
				issues = append(issues, Issue{k, fmt.Sprintf("unknown command %q", name)})
				continue
			}
		}
		c, err := field.parse(v)
		if err != nil {
			issues = append(issues, Issue{k, err.Error()})
			continue
		}
		over[name] = c
	}

	if cmds != nil {
		// Drop colliding overrides until none collide. Reverting one may expose its
		// default to another override, hence the loop; it ends because every pass
		// removes at least one override and defaults never collide among themselves
		// (TestKeybindingsAreUniqueAndNotReserved).
		for {
			owners := map[string][]string{} // chord -> commands
			for _, c := range cmds {
				for _, chord := range effectiveChords(c, over) {
					owners[chord] = append(owners[chord], c.Name)
				}
			}
			var drop []string
			for chord, names := range owners {
				if len(names) < 2 {
					continue
				}
				for _, n := range names {
					if _, ok := over[n]; ok {
						others := slices.DeleteFunc(slices.Clone(names), func(o string) bool { return o == n })
						issues = append(issues, Issue{KeybindingKey(n), fmt.Sprintf("%s is already bound to %s", chord, strings.Join(others, ", "))})
						drop = append(drop, n)
					}
				}
			}
			if len(drop) == 0 {
				break
			}
			for _, n := range drop {
				delete(over, n)
			}
		}
	}

	values := make(map[string]string, len(cmds)+len(over))
	for _, c := range cmds {
		v := ""
		if len(c.Keybindings) > 0 {
			v, _ = command.NormalizeChord(c.Keybindings[0])
		}
		values[KeybindingKey(c.Name)] = v
	}
	for name, c := range over {
		values[KeybindingKey(name)] = c
	}
	return over, values, dedupeIssues(issues)
}

// effectiveChords is c's canonical chords after its override, if any.
func effectiveChords(c CommandInfo, over map[string]string) []string {
	if o, ok := over[c.Name]; ok {
		if o == KeybindingNone {
			return nil
		}
		return []string{o}
	}
	out := make([]string, 0, len(c.Keybindings))
	for _, k := range c.Keybindings {
		if n, err := command.NormalizeChord(k); err == nil {
			out = append(out, n)
		}
	}
	return out
}

// KeybindingOverrides converts accepted overrides to command.Overrides.Keybindings.
func KeybindingOverrides(kb map[string]string) map[string][]string {
	out := make(map[string][]string, len(kb))
	for name, c := range kb {
		if c == KeybindingNone {
			out[name] = []string{}
		} else {
			out[name] = []string{c}
		}
	}
	return out
}

func dedupeIssues(in []Issue) []Issue {
	seen := map[Issue]bool{}
	out := in[:0]
	for _, i := range in {
		if !seen[i] {
			seen[i] = true
			out = append(out, i)
		}
	}
	return out
}

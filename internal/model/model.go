// Package model is the one list of Claude models the app offers: the composer's model
// picker, the settings page's "Default model", and session.new's --model all read it.
// Update the list here when Claude Code's models change; nothing else hardcodes them.
//
// Pricing (internal/pricing) is a different concern: it keys on the canonical ids Claude
// writes to transcripts, not on what is passed to --model.
package model

import "slices"

// Model is one choice.
type Model struct {
	// Value is passed to `claude --model`: a family alias ("opus") or a pinned id
	// ("claude-opus-4-8").
	Value string
	// Label is what the app shows.
	Label string
}

// registry is in display order: per family, the alias first, then pinned versions newest
// first. The family entries ("Opus") pass the bare alias, so Claude Code resolves whatever
// the user's default for that family is (including a managed-settings pin). Edit this list to
// add or retire models.
var registry = []Model{
	{"fable", "Fable"},
	{"opus", "Opus"},
	{"claude-opus-4-8", "Opus 4.8"},
	{"claude-opus-4-7", "Opus 4.7"},
	{"sonnet", "Sonnet"},
	{"claude-sonnet-5", "Sonnet 5"},
	{"claude-sonnet-4-6", "Sonnet 4.6"},
	{"haiku", "Haiku"},
	{"claude-haiku-4-5", "Haiku 4.5"},
}

// Default is the model for new threads when the settings do not pick one.
const Default = "opus"

// All returns the registry in display order.
func All() []Model { return slices.Clone(registry) }

// Values returns every Value in display order.
func Values() []string {
	out := make([]string, len(registry))
	for i, m := range registry {
		out[i] = m.Value
	}
	return out
}

// Labels returns every Label, parallel to Values.
func Labels() []string {
	out := make([]string, len(registry))
	for i, m := range registry {
		out[i] = m.Label
	}
	return out
}

// Known reports whether value is in the registry.
func Known(value string) bool {
	return slices.ContainsFunc(registry, func(m Model) bool { return m.Value == value })
}

// Label returns value's label, or value itself when the registry does not list it (the
// SessionService API accepts any full model name).
func Label(value string) string {
	for _, m := range registry {
		if m.Value == value {
			return m.Label
		}
	}
	return value
}

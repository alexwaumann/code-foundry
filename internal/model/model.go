// Package model is the one list of Claude models the app offers: the composer's model
// picker, the settings page's "Default model", and thread.new's --model all read it.
// Update the list here when Claude Code's models change; nothing else hardcodes them.
//
// Pricing (internal/pricing) is a different concern: it keys on the canonical ids Claude
// writes to transcripts, not on what is passed to --model.
package model

import "slices"

// Model is one choice.
type Model struct {
	// Value is passed to `claude --model`: a pinned id with the 1M context suffix
	// ("claude-opus-4-8[1m]").
	Value string
	// Label is what the app shows.
	Label string
}

// registry is in display order: per family, newest first. Every entry asks for the 1M
// context window; on models where 1M is already the default the suffix is accepted and
// changes nothing. There are no family aliases: an alias resolves to whatever the
// account's default is, which may not be the 1M variant.
//
// The 5.5 entries are listed before managed settings offer them, so they show up
// without an app update; until then picking one fails at thread start.
// claude-4.5-haiku[1m] is the id the work Bedrock setup accepts; claude-haiku-4-5 is
// refused there. Edit this list to add or retire models.
var registry = []Model{
	{"claude-opus-5-5[1m]", "Opus 5.5"},
	{"claude-opus-4-8[1m]", "Opus 4.8"},
	{"claude-opus-4-7[1m]", "Opus 4.7"},
	{"claude-sonnet-5-5[1m]", "Sonnet 5.5"},
	{"claude-sonnet-5[1m]", "Sonnet 5"},
	{"claude-sonnet-4-6[1m]", "Sonnet 4.6"},
	{"claude-haiku-5-5[1m]", "Haiku 5.5"},
	{"claude-4.5-haiku[1m]", "Haiku 4.5"},
}

// Default is the model for new threads when the settings do not pick one.
const Default = "claude-opus-4-8[1m]"

// NamingDefault is the model of the claude -p call that names a new thread when the
// settings (threads.naming_model) do not pick one. Sonnet until Haiku 5.5 is
// available everywhere the app runs.
const NamingDefault = "claude-sonnet-5[1m]"

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
// ThreadService API accepts any full model name).
func Label(value string) string {
	for _, m := range registry {
		if m.Value == value {
			return m.Label
		}
	}
	return value
}

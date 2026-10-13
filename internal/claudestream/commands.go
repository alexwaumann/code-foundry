package claudestream

// Slash commands (docs/notes/slash-commands-1-daemon.md). The initialize reply lists
// every command Claude would run for "/name": skills (user, project, plugin, bundled),
// user and project commands, and Claude's own built-ins. When the list changes during a
// session (a skill file written to a watched .claude/skills, skills discovered as the
// agent works in a subdirectory, reload_skills) Claude pushes the whole new list as
// system/commands_changed; a host replaces its copy with it.

// SlashCommand is one entry of initialize's commands (sdk.d.ts SlashCommand).
type SlashCommand struct {
	// Name is what follows "/", without the slash ("compact",
	// "anthropic-skills:deep-research").
	Name string `json:"name"`
	// Description is Claude's one-line description. A project skill's ends in
	// " (project)"; a retired built-in's starts with "(removed)" or "Renamed to".
	Description string `json:"description"`
	// ArgumentHint is the hint shown after the name ("[interval] [prompt]"); "" for none.
	ArgumentHint string `json:"argumentHint"`
	// Aliases are other names that run this command ("/cost" runs usage).
	Aliases []string `json:"aliases,omitempty"`
	// Builtin marks Claude Code's own commands (bundled skills included); false for a
	// command defined by a user, project, plugin or MCP server. When two rows share a
	// name, "/name" runs the built-in one.
	Builtin bool `json:"builtin,omitempty"`
}

// CommandsChanged is system/commands_changed: the full new command list, pushed after a
// mid-session change. It replaces the list initialize returned.
type CommandsChanged struct {
	base
	Commands []SlashCommand `json:"commands"`
}

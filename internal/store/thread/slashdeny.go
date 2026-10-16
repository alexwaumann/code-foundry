package thread

import (
	"strings"
	"unicode"
)

// The slash commands the composer does not offer (docs/notes/slash-commands-1-daemon.md).
// A deny list, not an allow list: every command Claude reports is shown unless it is
// here, so new skills, user and project commands and Claude's new built-ins appear
// without a change. Only Claude's own commands (SlashCommand.Builtin) are checked:
// skills and user, project and plugin commands are never denied, even one whose name is
// in the table. The replaced group is also guarded at send time (refusedSlashCommand):
// a message starting with "/clear" is refused with the entry's Refusal, which points at
// the app's own control.

// SlashDenyReason says why a slash command is not offered.
type SlashDenyReason string

// Slash command deny reasons.
const (
	// SlashReplaced: the app has its own control for it; a message starting with it is
	// refused (SlashDenial.Refusal).
	SlashReplaced SlashDenyReason = "replaced"
	// SlashTerminalOnly: it drives Claude's terminal interface, or means nothing to a
	// process the daemon drives over stream-json.
	SlashTerminalOnly SlashDenyReason = "terminal-only"
	// SlashRetired: Claude lists it but it was removed or renamed.
	SlashRetired SlashDenyReason = "retired"
)

// SlashDenial is why a slash command is denied.
type SlashDenial struct {
	Reason SlashDenyReason
	// Refusal (SlashReplaced only) is the error a message starting with the command
	// gets: it points at the app's replacement.
	Refusal string
}

// slashDenied is the deny table, by command name (without the slash).
var slashDenied = map[string]SlashDenial{
	// Replaced by the app's own controls.
	"model":  {SlashReplaced, "Change the model with the composer's model selector (or `thread.set-model`), not /model."},
	"effort": {SlashReplaced, "Change the effort with the composer's effort selector (or `thread.set-effort`), not /effort."},
	"fast":   {SlashReplaced, "Pick the model with the composer's model selector (or `thread.set-model`), not /fast."},
	"mcp":    {SlashReplaced, "Manage MCP servers in the MCP panel (or `thread.mcp`), not /mcp."},
	"rename": {SlashReplaced, "Rename the thread with Rename Thread (or `session.rename`), not /rename."},
	"clear":  {SlashReplaced, "Start a new thread instead of clearing this one."},

	// Terminal-only, or meaningless over stream-json.
	"color":                {Reason: SlashTerminalOnly},
	"focus":                {Reason: SlashTerminalOnly},
	"heapdump":             {Reason: SlashTerminalOnly},
	"config":               {Reason: SlashTerminalOnly},
	"output-style":         {Reason: SlashTerminalOnly},
	"debug":                {Reason: SlashTerminalOnly},
	"doctor":               {Reason: SlashTerminalOnly},
	"import":               {Reason: SlashTerminalOnly},
	"autocompact":          {Reason: SlashTerminalOnly},
	"reload-plugins":       {Reason: SlashTerminalOnly},
	"reload-skills":        {Reason: SlashTerminalOnly},
	"__remote-workflow":    {Reason: SlashTerminalOnly},
	"workflow-launch-exec": {Reason: SlashTerminalOnly},
	"auto-mode-setup":      {Reason: SlashTerminalOnly},
	"design-consent":       {Reason: SlashTerminalOnly},
	"design-revoke":        {Reason: SlashTerminalOnly},
	"usage-credits":        {Reason: SlashTerminalOnly},
	"team-onboarding":      {Reason: SlashTerminalOnly},

	// Removed or renamed; most are caught by their description (slashRetiredPrefixes).
	"agents":      {Reason: SlashRetired},
	"extra-usage": {Reason: SlashRetired},
}

// slashRetiredPrefixes mark a retired command by its description: Claude keeps listing
// removed and renamed built-ins, described "(removed) …" or "Renamed to /…".
var slashRetiredPrefixes = []string{"(removed)", "Renamed to"}

// DeniedSlashCommand reports whether the composer leaves out Claude's built-in slash
// command name (without the slash) described as description, and why. Callers check
// built-ins only (visibleSlashCommands).
func DeniedSlashCommand(name, description string) (SlashDenial, bool) {
	if d, ok := slashDenied[name]; ok {
		return d, true
	}
	for _, p := range slashRetiredPrefixes {
		if strings.HasPrefix(description, p) {
			return SlashDenial{Reason: SlashRetired}, true
		}
	}
	return SlashDenial{}, false
}

// slashReplacedAliases are Claude's aliases of the replaced commands (Claude Code
// 2.1.296): "/reset" clears as "/clear" does. Guarded like the names, unless the thread
// offers a command by that name ("/name" runs a command named so before an alias).
var slashReplacedAliases = map[string]string{"reset": "clear", "new": "clear", "name": "rename"}

// SlashRefusal is Send's error for a message that starts with a command the app
// replaces. Its text is the deny table's Refusal alone, so it can be shown as it is; it
// is an ErrInvalidArgument.
type SlashRefusal struct {
	// Command is the command as typed, without the slash; Replaces the table's name
	// for it (differs for an alias).
	Command, Replaces string
	Message           string
}

func (e *SlashRefusal) Error() string { return e.Message }

// Unwrap makes a refusal an ErrInvalidArgument.
func (e *SlashRefusal) Unwrap() error { return ErrInvalidArgument }

// leadingSlashCommand returns the command a message starts with: its first non-blank
// line's first word, when that starts with "/", without the slash. Case is kept.
func leadingSlashCommand(text string) (string, bool) {
	line, _, _ := strings.Cut(strings.TrimLeftFunc(text, unicode.IsSpace), "\n")
	word, ok := strings.CutPrefix(line, "/")
	if !ok {
		return "", false
	}
	if i := strings.IndexFunc(word, unicode.IsSpace); i >= 0 {
		word = word[:i]
	}
	return word, word != ""
}

// refusedSlashCommand refuses a message that starts with a command the app replaces
// (the deny table's SlashReplaced group, or one of its aliases that offers, the thread's
// own commands by name, does not claim). Terminal-only and retired commands go through:
// Claude answers those itself.
func refusedSlashCommand(text string, offers func(name string) bool) *SlashRefusal {
	cmd, ok := leadingSlashCommand(text)
	if !ok {
		return nil
	}
	name := cmd
	if to, alias := slashReplacedAliases[cmd]; alias && (offers == nil || !offers(cmd)) {
		name = to
	}
	if d := slashDenied[name]; d.Refusal != "" {
		return &SlashRefusal{Command: cmd, Replaces: name, Message: d.Refusal}
	}
	return nil
}

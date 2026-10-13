package session

import "strings"

// The slash commands the composer does not offer (docs/notes/slash-commands-1-daemon.md).
// A deny list, not an allow list: every command Claude reports is shown unless it is
// here, so new skills, user and project commands and Claude's new built-ins appear
// without a change. Only Claude's own commands (SlashCommand.Builtin) are checked:
// skills and user, project and plugin commands are never denied, even one whose name is
// in the table. The table is also what a send-time guard will use to refuse "/clear"
// and point at the app's own control instead.

// SlashDenyReason says why a slash command is not offered.
type SlashDenyReason string

// Slash command deny reasons.
const (
	// SlashReplaced: the app has its own control for it (Use names it).
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
	// Use is the app's replacement (SlashReplaced only): what to tell someone who typed
	// the command.
	Use string
}

// slashDenied is the deny table, by command name (without the slash).
var slashDenied = map[string]SlashDenial{
	// Replaced by the app's own controls.
	"model":  {SlashReplaced, "the composer's model picker"},
	"effort": {SlashReplaced, "the composer's effort picker"},
	"fast":   {SlashReplaced, "the composer's model picker"},
	"mcp":    {SlashReplaced, "the MCP panel"},
	"rename": {SlashReplaced, "Rename Thread"},
	"clear":  {SlashReplaced, "a new thread"},

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

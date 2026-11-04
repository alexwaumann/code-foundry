package command

import (
	"path/filepath"
	"slices"
	"strings"
)

// What a thread's agent runs without the user being asked (docs/notes/auto-approve-verbs.md).
// A managed settings file with allowManagedPermissionRulesOnly makes Claude ignore
// --allowedTools, so the daemon answers these itself when Claude asks. Three things have
// to hold, and anything else goes to the user as before:
//
//   - The line is one simple command with no shell in it (shellWords).
//   - It runs the Code Foundry CLI: `code-foundry`, or the daemon's own CLI path.
//   - The verb is classified as safe and this call is not a form that widens it
//     (agentFlagsOK). A new verb, and a plugin's, asks until it is classified.
//
// Which verbs a thread gets depends on its mode, so that decision is the thread store's
// (thread.Options.ApprovedVerb).

// cliName is the CLI's name on a thread's PATH.
const cliName = "code-foundry"

// LocalVerb is a verb the CLI answers itself, outside the registry. Every one is listed,
// so that a verb the CLI would take for itself is never resolved in the registry.
type LocalVerb struct {
	// Safe: it only prints, so an agent may run it as it may a read-only command.
	Safe bool
	// TakesWords: a word after it is its argument. Otherwise that word makes the line a
	// registry command (`daemon status` is daemon.status).
	TakesWords bool
}

// LocalVerbs are the CLI's own verbs (cmd/code-foundry's table, whose test keeps the two
// the same). daemon runs a daemon, gui opens the app and update replaces the executables.
var LocalVerbs = map[string]LocalVerb{
	"commands": {Safe: true},
	"daemon":   {},
	"events":   {Safe: true},
	"guide":    {Safe: true, TakesWords: true},
	"gui":      {},
	"help":     {Safe: true, TakesWords: true},
	"status":   {Safe: true},
	"update":   {},
	"version":  {Safe: true},
}

// IsWord reports whether s is a positional token rather than a flag.
func IsWord(s string) bool { return s != "" && !strings.HasPrefix(s, "-") }

// LeadingWords returns the positional tokens before the first flag: the words a verb can
// be named by.
func LeadingWords(args []string) []string {
	for i, a := range args {
		if !IsWord(a) {
			return args[:i]
		}
	}
	return args
}

// ResolveVerb finds the command named by the longest prefix of words, joined with dots,
// and how many words that took; has says whether a name is a command. When no prefix names
// one, a prefix naming a domain with a "show" command is that (`code-foundry usage` is
// usage.show: command names have at least two segments). The CLI resolves its verbs with
// this too, so what is approved is what runs.
func ResolveVerb(has func(string) bool, words []string) (string, int) {
	for _, suffix := range []string{"", ".show"} {
		for n := len(words); n > 0; n-- {
			if name := strings.Join(words[:n], ".") + suffix; has(name) {
				return name, n
			}
		}
	}
	return "", 0
}

// ApprovedVerb returns the verb line runs when it is a call an agent may make without
// asking, or "". cli is the daemon's own CLI path, the one absolute path that counts; ""
// has none. A registry verb comes back by its dotted name, a local verb as its word.
func (r *Registry) ApprovedVerb(line, cli string) string {
	words, ok := shellWords(line)
	if !ok || len(words) < 2 || !words[0].bare {
		return ""
	}
	if exe := words[0].text; exe != cliName && (exe != cli || !filepath.IsAbs(exe)) {
		return ""
	}
	words = words[1:]
	args := make([]string, len(words))
	for i, w := range words {
		args[i] = w.text
		if refusedWord(w.text) {
			return ""
		}
	}
	if !words[0].bare || !IsWord(args[0]) {
		return "" // --version and the like come before a verb: not worth resolving
	}
	if v, ok := LocalVerbs[args[0]]; ok && (len(args) == 1 || !IsWord(args[1]) || v.TakesWords) {
		if v.Safe {
			return args[0]
		}
		return ""
	}
	name, n := ResolveVerb(func(s string) bool { _, ok := r.Get(s); return ok }, LeadingWords(args))
	if name == "" || slices.ContainsFunc(words[:n], func(w shellWord) bool { return !w.bare }) {
		return ""
	}
	c, _ := r.Get(name)
	if !c.AgentApproved() || !agentFlagsOK(&c, args[n:]) {
		return ""
	}
	return name
}

// AgentApproved reports whether an agent may run c without asking, in a form that does
// not widen it: a read-only verb, or one marked AgentSafe. Never a verb with Confirm.
func (c *Command) AgentApproved() bool {
	return (c.ReadOnly || c.AgentSafe) && c.Confirm == ""
}

// refusedWord: a word that asks on any verb and wherever it stands, its quotes gone. --yes
// answers a confirmation for the user. @path and - make the CLI read a file or stdin into
// the value (ArgSpec.FileOrStdin), which reaches past what Claude's own checks on reading
// a file see.
func refusedWord(w string) bool {
	name, value, _ := splitFlag(w)
	return name == "yes" || sourceValue(w) || sourceValue(value)
}

func sourceValue(v string) bool { return v == "-" || strings.HasPrefix(v, "@") }

// splitFlag takes a word apart the way the flag package does: one or two dashes, a name,
// and =value. Not a flag: "".
func splitFlag(w string) (name, value string, inline bool) {
	if !strings.HasPrefix(w, "-") {
		return "", "", false
	}
	name = strings.TrimPrefix(strings.TrimPrefix(w, "-"), "-")
	name, value, inline = strings.Cut(name, "=")
	return name, value, inline
}

// agentFlagsOK checks what follows the verb: every word with a dash, wherever it stands
// (after --, or where a string flag would take it as its value), must be one of the verb's
// flags, --json or --help, and a flag marked AgentAsk must hold a value it allows. It reads
// more words as flags than the CLI does, so it can only ask more. The --context-* flags
// are not here: nothing an agent does needs them, its thread comes from its environment.
func agentFlagsOK(c *Command, rest []string) bool {
	for i, w := range rest {
		if !strings.HasPrefix(w, "-") || w == "--" {
			continue
		}
		name, value, inline := splitFlag(w)
		if name == "json" || name == "help" || name == "h" {
			continue
		}
		at := slices.IndexFunc(c.Args, func(a ArgSpec) bool { return a.Name == name })
		if at < 0 {
			return false
		}
		a := &c.Args[at]
		if !a.AgentAsk {
			continue
		}
		if !inline {
			if i+1 == len(rest) {
				return false
			}
			value = rest[i+1]
		}
		if !slices.Contains(a.AgentOK, value) {
			return false
		}
	}
	return true
}

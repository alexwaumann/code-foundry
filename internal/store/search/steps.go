package search

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A run's progress is derived from its tool calls: each Bash call that runs `code-foundry
// thread search` is a SEARCH step, `thread read` (or `thread items`) a READ step, `search
// report` no step (its hit shows instead), anything else an OTHER step. A step is made
// when its call arrives (Done false: the current step) and completed by its result.

// cliName is the CLI the run calls.
const cliName = "code-foundry"

// bashInput is the Bash tool's input.
type bashInput struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// stepOf is the step a tool call makes, and false for one that makes none (a report).
// threadName names a thread id (the snapshot's name now).
func stepOf(tool string, input json.RawMessage, threadName func(id string) string) (Step, bool) {
	var in bashInput
	_ = json.Unmarshal(input, &in)
	if tool != "Bash" {
		return Step{Kind: StepOther, Detail: tool}, true
	}
	words := cliWords(in.Command)
	if len(words) >= 2 && words[0] == "search" && words[1] == "report" {
		return Step{}, false
	}
	if len(words) >= 2 && words[0] == "thread" {
		args := parseFlags(words[2:])
		switch words[1] {
		case "search":
			return Step{Kind: StepSearch, Query: strings.Join(args.positional, " ")}, true
		case "read", "items":
			id := args.flags["id"]
			if id == "" && len(args.positional) > 0 {
				id = args.positional[0]
			}
			name := ""
			if id != "" && threadName != nil {
				name = threadName(id)
			}
			return Step{Kind: StepRead, ThreadID: id, ThreadName: name}, true
		}
	}
	detail := strings.TrimSpace(in.Description)
	if detail == "" {
		detail = clip(strings.Join(strings.Fields(in.Command), " "), 60)
	}
	return Step{Kind: StepOther, Detail: detail}, true
}

// searchTotal is thread search's "Messages: N in M threads" line.
var searchTotal = regexp.MustCompile(`(?m)^Messages: (\d+) in `)

// readOrdinal is a thread read line's "#N ".
var readOrdinal = regexp.MustCompile(`(?m)^\s*#(\d+) `)

// completeStep fills in st from its call's result.
func completeStep(st Step, result string, isError bool) Step {
	st.Done, st.Failed = true, isError
	if isError {
		return withText(st)
	}
	switch st.Kind {
	case StepSearch:
		if m := searchTotal.FindStringSubmatch(result); m != nil {
			st.Hits, _ = strconv.Atoi(m[1])
		}
	case StepRead:
		for _, m := range readOrdinal.FindAllStringSubmatch(result, -1) {
			n, err := strconv.ParseInt(m[1], 10, 64)
			if err != nil {
				continue
			}
			if st.From == 0 || n < st.From {
				st.From = n
			}
			if n > st.To {
				st.To = n
			}
		}
	}
	return withText(st)
}

// withText sets st.Text, the step in words.
func withText(st Step) Step {
	name := st.ThreadName
	if name == "" {
		name = st.ThreadID
	}
	if name == "" {
		name = "a thread"
	}
	switch {
	case st.Kind == StepSearch && !st.Done:
		st.Text = "Searching " + st.Query + "…"
	case st.Kind == StepSearch && st.Failed:
		st.Text = "Searched " + st.Query + " · failed"
	case st.Kind == StepSearch:
		st.Text = "Searched " + st.Query + " · " + plural(st.Hits, "hit")
	case st.Kind == StepRead && !st.Done:
		st.Text = "Reading " + name + "…"
	case st.Kind == StepRead && st.Failed:
		st.Text = "Read " + name + " · failed"
	case st.Kind == StepRead && st.To > 0 && st.From != st.To:
		st.Text = fmt.Sprintf("Read %s · #%d–#%d", name, st.From, st.To)
	case st.Kind == StepRead && st.To > 0:
		st.Text = fmt.Sprintf("Read %s · #%d", name, st.From)
	case st.Kind == StepRead:
		st.Text = "Read " + name
	case !st.Done:
		st.Text = st.Detail + "…"
	case st.Failed:
		st.Text = st.Detail + " · failed"
	default:
		st.Text = st.Detail
	}
	return st
}

func plural(n int, word string) string {
	switch n {
	case 0:
		return "no " + word + "s"
	case 1:
		return "1 " + word
	}
	return strconv.Itoa(n) + " " + word + "s"
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

// cliWords are the words after the first `code-foundry` of a shell command (up to the
// next operator); nil when it does not run the CLI.
func cliWords(cmd string) []string {
	words := shellWords(cmd)
	for i, w := range words {
		if w == cliName || strings.HasSuffix(w, "/"+cliName) {
			rest := words[i+1:]
			for j, x := range rest {
				if isOperator(x) {
					return rest[:j]
				}
			}
			return rest
		}
	}
	return nil
}

func isOperator(w string) bool {
	switch w {
	case "&&", "||", ";", "|", "&":
		return true
	}
	return false
}

// shellWords splits a command line roughly as a POSIX shell would: single quotes, double
// quotes with backslash escapes, backslashes outside quotes; the operators && || ; | &
// are words of their own. Enough to read the run's own commands, not a shell.
func shellWords(s string) []string {
	var out []string
	var cur strings.Builder
	in := false // a word is under way (an empty quoted word counts)
	flush := func() {
		if in {
			out = append(out, cur.String())
			cur.Reset()
			in = false
		}
	}
	r := []rune(s)
	for i := 0; i < len(r); i++ {
		c := r[i]
		switch {
		case c == '\'':
			in = true
			for i++; i < len(r) && r[i] != '\''; i++ {
				cur.WriteRune(r[i])
			}
		case c == '"':
			in = true
			for i++; i < len(r) && r[i] != '"'; i++ {
				if r[i] == '\\' && i+1 < len(r) && strings.ContainsRune(`"\$`+"`", r[i+1]) {
					i++
				}
				cur.WriteRune(r[i])
			}
		case c == '\\' && i+1 < len(r):
			in = true
			i++
			if r[i] != '\n' {
				cur.WriteRune(r[i])
			}
		case c == ' ' || c == '\t' || c == '\n':
			flush()
		case c == ';' || c == '|' || c == '&':
			flush()
			op := string(c)
			if i+1 < len(r) && (c == '|' || c == '&') && r[i+1] == c {
				op += string(c)
				i++
			}
			out = append(out, op)
		default:
			in = true
			cur.WriteRune(c)
		}
	}
	flush()
	return out
}

// cliArgs are a CLI call's positional words and --flag values.
type cliArgs struct {
	positional []string
	flags      map[string]string
}

// boolFlags are the flags of thread search and thread read that take no value.
var boolFlags = map[string]bool{"json": true, "all": true, "full": true, "yes": true}

// parseFlags reads words as the CLI does: --name value, --name=value, a bool flag alone.
func parseFlags(words []string) cliArgs {
	a := cliArgs{flags: map[string]string{}}
	for i := 0; i < len(words); i++ {
		w := words[i]
		name, ok := strings.CutPrefix(w, "--")
		if !ok || name == "" {
			a.positional = append(a.positional, w)
			continue
		}
		if k, v, eq := strings.Cut(name, "="); eq {
			a.flags[k] = v
			continue
		}
		if boolFlags[name] || i+1 >= len(words) {
			a.flags[name] = "true"
			continue
		}
		a.flags[name] = words[i+1]
		i++
	}
	return a
}

// threadNamer names thread ids from snap.
func threadNamer(snap *thread.Snapshot) func(string) string {
	return func(id string) string {
		if t, ok := snap.Thread(id); ok {
			return t.Name
		}
		return ""
	}
}

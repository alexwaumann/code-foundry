package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// fakeInitCommands reads the initialize reply's commands from a capture like
// claudestream/testdata/commands.jsonl (the fake's CF_FAKE_CLAUDE_COMMANDS); "" is none.
func fakeInitCommands(path string) (json.RawMessage, error) {
	if path == "" {
		return json.RawMessage(`[]`), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	for _, l := range strings.Split(string(data), "\n") {
		var m struct {
			Type     string `json:"type"`
			Response struct {
				Response struct {
					Commands json.RawMessage `json:"commands"`
				} `json:"response"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(l), &m) == nil && m.Type == "control_response" && m.Response.Response.Commands != nil {
			return m.Response.Response.Commands, nil
		}
	}
	return nil, fmt.Errorf("%s has no initialize reply with commands", path)
}

// fixtureCommands returns the commands fixture's initialize list and its pushes.
func fixtureCommands(t *testing.T) (init []claudestream.SlashCommand, pushes [][]claudestream.SlashCommand) {
	t.Helper()
	raw, err := fakeInitCommands(fixturePath("commands"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &init); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(fixturePath("commands"))
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if c, ok := claudestream.Parse([]byte(l)).(*claudestream.CommandsChanged); ok {
			pushes = append(pushes, c.Commands)
		}
	}
	return init, pushes
}

func names(cs []SlashCommand) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Name
	}
	return out
}

func TestDeniedSlashCommand(t *testing.T) {
	tests := []struct {
		name, description string
		reason            SlashDenyReason // "" when offered
	}{
		{"model", "Set the AI model for Claude Code", SlashReplaced},
		{"effort", "Set effort level", SlashReplaced},
		{"clear", "Start a new session", SlashReplaced},
		{"mcp", "Manage MCP servers", SlashReplaced},
		{"rename", "Rename the current conversation", SlashReplaced},
		{"fast", "Toggle fast mode", SlashReplaced},
		{"heapdump", "Dump the JS heap", SlashTerminalOnly},
		{"__remote-workflow", "Run the workflow script", SlashTerminalOnly},
		{"reload-skills", "Pick up skills added or changed on disk", SlashTerminalOnly},
		{"agents", "(removed) Ask Claude to create/manage subagents", SlashRetired},
		{"extra-usage", "Renamed to /usage-credits", SlashRetired},
		{"someday", "(removed) gone", SlashRetired},
		{"was", "Renamed to /is", SlashRetired},
		{"compact", "Free up context by summarizing the conversation so far", ""},
		{"context", "Show current context usage", ""},
		{"usage", "Show session cost", ""},
		{"design", "Grant or revoke Claude agent access to your Design projects", ""},
		{"note", "A description mentioning (removed) later", ""},
		{"", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, denied := DeniedSlashCommand(tt.name, tt.description)
			if got.Reason != tt.reason || denied != (tt.reason != "") {
				t.Errorf("DeniedSlashCommand(%q, %q) = %+v, %v; want %q", tt.name, tt.description, got, denied, tt.reason)
			}
			// Only the replaced group is refused at send time, so only it has a refusal.
			if (got.Refusal != "") != (tt.reason == SlashReplaced) {
				t.Errorf("refusal %q for a %q denial", got.Refusal, got.Reason)
			}
		})
	}
}

func TestRefusedSlashCommand(t *testing.T) {
	offered := func(names ...string) func(string) bool {
		return func(n string) bool { return slices.Contains(names, n) }
	}
	tests := []struct {
		name     string
		text     string
		offers   func(string) bool
		replaces string // "" when it goes through
		message  string
	}{
		{"clear", "/clear", nil, "clear", "Start a new thread instead of clearing this one."},
		{"model with an argument", "/model opus", nil, "model", "Change the model with the composer's model selector (or `thread.set-model`), not /model."},
		{"effort", "/effort high", nil, "effort", "Change the effort with the composer's effort selector (or `thread.set-effort`), not /effort."},
		{"fast", "/fast on", nil, "fast", "Pick the model with the composer's model selector (or `thread.set-model`), not /fast."},
		{"mcp", "/mcp reconnect github", nil, "mcp", "Manage MCP servers in the MCP panel (or `thread.mcp`), not /mcp."},
		{"rename", "/rename my thread", nil, "rename", "Rename the thread with Rename Thread (or `session.rename`), not /rename."},
		{"leading whitespace", "  \t/clear", nil, "clear", ""},
		{"leading blank lines", "\n\n  /clear\n", nil, "clear", ""},
		{"tab after the name", "/model\topus", nil, "model", ""},
		{"crlf", "/clear\r\nthen this", nil, "clear", ""},
		{"multi-line, command first", "/clear\nand start over", nil, "clear", ""},
		{"multi-line, command later", "please summarise\n/clear", nil, "", ""},
		{"a longer name is not the command", "/clearly", nil, "", ""},
		{"a skill sharing the prefix", "/model-review the diff", nil, "", ""},
		{"case-sensitive", "/Clear", nil, "", ""},
		{"not first on the line", "run /clear", nil, "", ""},
		{"a bare slash", "/", nil, "", ""},
		{"a path", "/Users/alex/notes.txt is the file", nil, "", ""},
		{"terminal-only commands go through", "/color red", nil, "", ""},
		{"retired commands go through", "/agents", nil, "", ""},
		{"kept commands go through", "/compact keep the plan", nil, "", ""},
		{"an alias of clear", "/reset", nil, "clear", "Start a new thread instead of clearing this one."},
		{"another alias of clear", "/new", offered("compact"), "clear", ""},
		{"an alias of rename", "/name better", nil, "rename", ""},
		{"an alias the thread offers as a command", "/new idea", offered("new"), "", ""},
		{"a name the thread offers is still refused", "/clear", offered("clear"), "clear", ""},
		{"empty", "", nil, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := refusedSlashCommand(tt.text, tt.offers)
			if tt.replaces == "" {
				if got != nil {
					t.Fatalf("refused %q: %+v", tt.text, got)
				}
				return
			}
			if got == nil || got.Replaces != tt.replaces {
				t.Fatalf("refusedSlashCommand(%q) = %+v, want %s", tt.text, got, tt.replaces)
			}
			if tt.message != "" && got.Error() != tt.message {
				t.Errorf("message %q", got.Error())
			}
			if !errors.Is(got, ErrInvalidArgument) {
				t.Error("not an invalid argument")
			}
		})
	}
}

func TestVisibleSlashCommands(t *testing.T) {
	b := func(name, desc string) claudestream.SlashCommand {
		return claudestream.SlashCommand{Name: name, Description: desc, Builtin: true}
	}
	u := func(name, desc string) claudestream.SlashCommand {
		return claudestream.SlashCommand{Name: name, Description: desc}
	}
	tests := []struct {
		name string
		in   []claudestream.SlashCommand
		want []string // "name:description"
	}{
		{"empty", nil, []string{}},
		{"denied built-ins go", []claudestream.SlashCommand{b("compact", "c"), b("model", "m"), b("color", "x"), b("context", "ctx")},
			[]string{"compact:c", "context:ctx"}},
		{"retired built-ins go by description", []claudestream.SlashCommand{b("old", "(removed) old"), b("was", "Renamed to /is"), b("is", "is")},
			[]string{"is:is"}},
		{"skills and user commands are never denied", []claudestream.SlashCommand{u("model", "my model skill (user)"), u("notes", "(removed) mine")},
			[]string{"model:my model skill (user)", "notes:(removed) mine"}},
		{"a shared name keeps the built-in, which /name runs", []claudestream.SlashCommand{u("verify", "mine (project)"), b("verify", "Claude's")},
			[]string{"verify:Claude's"}},
		{"a skill shadowed by a denied built-in goes with it", []claudestream.SlashCommand{u("debug", "mine (user)"), b("debug", "Claude's")},
			[]string{}},
		{"a shared name without a built-in keeps the first", []claudestream.SlashCommand{u("deploy", "project"), u("deploy", "user")},
			[]string{"deploy:project"}},
		{"Claude's order is kept", []claudestream.SlashCommand{u("zeta", "z"), b("alpha", "a"), u("plugin:mid", "m")},
			[]string{"zeta:z", "alpha:a", "plugin:mid:m"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := visibleSlashCommands(tt.in)
			if got == nil {
				t.Fatal("nil list")
			}
			var have []string
			for _, c := range got {
				have = append(have, c.Name+":"+c.Description)
			}
			if !slices.Equal(have, tt.want) && !(len(have) == 0 && len(tt.want) == 0) {
				t.Errorf("visible = %q, want %q", have, tt.want)
			}
		})
	}
}

// The real list: 68 commands from Claude Code 2.1.296, 26 of them denied (6 replaced, 18 terminal-only, 2 retired).
func TestVisibleSlashCommandsFixture(t *testing.T) {
	init, pushes := fixtureCommands(t)
	got := visibleSlashCommands(init)
	have := names(got)
	for _, keep := range []string{"compact", "context", "usage", "code-review", "ultrareview", "simplify", "security-review",
		"verify", "batch", "goal", "advisor", "loop", "schedule", "skill-doctor", "list-agents", "insights", "recap", "init",
		"deep-research", "dataviz", "anthropic-skills:deep-research", "docx", "design"} {
		if !slices.Contains(have, keep) {
			t.Errorf("%s missing", keep)
		}
	}
	for _, c := range init {
		if _, denied := DeniedSlashCommand(c.Name, c.Description); denied && slices.Contains(have, c.Name) {
			t.Errorf("%s (%q) offered", c.Name, c.Description)
		}
	}
	if len(init) != 68 || len(got) != 42 {
		t.Errorf("%d of %d offered: %q", len(got), len(init), have)
	}
	usage := got[slices.Index(have, "usage")]
	if !usage.Builtin || !slices.Equal(usage.Aliases, []string{"cost", "stats"}) {
		t.Errorf("usage = %+v", usage)
	}
	// A push replaces the list; the project skill it adds is offered first, as Claude
	// lists it.
	if after := visibleSlashCommands(pushes[1]); len(after) != 44 || after[0].Name != "alpha-probe" || !slices.Contains(names(after), "beta-probe") {
		t.Errorf("after the pushes: %q", names(after))
	}
}

// setSlashCommands publishes a change only; nil (dropped) differs from an empty list.
func TestThreadLogSlashCommands(t *testing.T) {
	b := bus.New()
	sub := bus.Subscribe[ThreadEvent](b, 16)
	defer sub.Close()
	log := newThreadLog("t1", b, time.Now, nil)
	one := []SlashCommand{{Name: "compact", Builtin: true}}
	steps := []struct {
		set     []SlashCommand
		publish bool
	}{
		{nil, false},
		{one, true},
		{[]SlashCommand{{Name: "compact", Builtin: true}}, false},
		{[]SlashCommand{{Name: "compact", Builtin: true, Aliases: []string{"c"}}}, true},
		{[]SlashCommand{}, true},
		{[]SlashCommand{}, false},
		{nil, true},
	}
	for i, s := range steps {
		before := log.snapshot().Seq
		log.setSlashCommands(s.set)
		snap := log.snapshot()
		if published := snap.Seq != before; published != s.publish {
			t.Fatalf("step %d: published %v", i, published)
		}
		if (snap.Commands == nil) != (s.set == nil) || len(snap.Commands) != len(s.set) {
			t.Fatalf("step %d: snapshot %+v", i, snap.Commands)
		}
		if !s.publish {
			continue
		}
		ev := (<-sub.C()).(SlashCommandsChanged)
		if ev.SessionID != "t1" || ev.Seq != snap.Seq || (ev.Commands == nil) != (s.set == nil) {
			t.Fatalf("step %d: event %+v", i, ev)
		}
	}
}

// A push handled before the handshake's answer wins: the answer is older.
func TestRunnerSlashCommandsOrder(t *testing.T) {
	init := []claudestream.SlashCommand{{Name: "compact", Builtin: true}}
	push := []claudestream.SlashCommand{{Name: "compact", Builtin: true}, {Name: "mine"}}
	tests := []struct {
		name    string
		closing bool
		order   []bool // pushed, in arrival order
		want    []string
	}{
		{"handshake only", false, []bool{false}, []string{"compact"}},
		{"handshake then push", false, []bool{false, true}, []string{"compact", "mine"}},
		{"push then handshake", false, []bool{true, false}, []string{"compact", "mine"}},
		{"closing", true, []bool{false, true}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := newThreadLog("t1", bus.New(), time.Now, nil)
			r := &runner{st: &streamState{log: log}, closing: tt.closing}
			for _, pushed := range tt.order {
				cs := init
				if pushed {
					cs = push
				}
				r.onSlashCommands(cs, pushed)
			}
			got := log.slashCommands()
			if !slices.Equal(names(got), tt.want) || (got == nil) != (tt.want == nil) {
				t.Errorf("commands = %q", names(got))
			}
		})
	}
}

// writeCommandsTurn writes a capture whose one turn pushes the commands fixture's last
// commands_changed, then ends.
func writeCommandsTurn(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(fixturePath("commands"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	result := `{"type":"result","subtype":"success","is_error":false,"duration_ms":10,"num_turns":1,"result":"banana","stop_reason":"end_turn","total_cost_usd":0.001,"session_id":"s"}`
	p := filepath.Join(t.TempDir(), "commands-turn.jsonl")
	if err := os.WriteFile(p, []byte(lines[len(lines)-1]+"\n"+result+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func (re *env) waitCommands(id, what string, cond func([]SlashCommand) bool) []SlashCommand {
	re.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		cs := re.items(id).Commands
		if cond(cs) {
			return cs
		}
		if time.Now().After(deadline) {
			re.t.Fatalf("timed out waiting for slash commands %s; have %q", what, names(cs))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The handshake's list is cached (filtered) and published in seq order; a
// commands_changed push replaces it; an effort restart takes the new process's list;
// the process ending drops it.
func TestRenderedSlashCommands(t *testing.T) {
	re := newFixtureEnvAt(t, writeCommandsTurn(t), []string{"CF_FAKE_CLAUDE_COMMANDS=" + fixturePath("commands")})
	sub := bus.Subscribe[ThreadEvent](re.bus, 1024)
	defer sub.Close()
	s := re.create(CreateOptions{Effort: "low"})
	re.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
	got := re.waitCommands(s.ID, "after the handshake", func(cs []SlashCommand) bool { return cs != nil })
	if len(got) != 42 || slices.Contains(names(got), "model") || !slices.Contains(names(got), "compact") {
		t.Fatalf("handshake list %q", names(got))
	}
	snap := re.items(s.ID)
	var ev *SlashCommandsChanged
	for len(sub.C()) > 0 {
		if e, ok := (<-sub.C()).(SlashCommandsChanged); ok && e.SessionID == s.ID {
			ev = &e
		}
	}
	if ev == nil || len(ev.Commands) != 42 || ev.Seq == 0 || ev.Seq > snap.Seq {
		t.Errorf("event %+v (snapshot seq %d)", ev, snap.Seq)
	}
	if cs, err := re.m.SlashCommands(re.ctx(), s.ID); err != nil || len(cs) != 42 {
		t.Errorf("SlashCommands = %d, %v", len(cs), err)
	}

	// A command the app replaces is refused: nothing reaches Claude, no item.
	sentBefore, itemsBefore := len(re.sent()), len(re.items(s.ID).Items)
	_, err := re.m.Send(re.ctx(), s.ID, Message{Text: "/clear"})
	var ref *SlashRefusal
	if !errors.As(err, &ref) || !errors.Is(err, ErrInvalidArgument) || err.Error() != "Start a new thread instead of clearing this one." {
		t.Errorf("send /clear: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if len(re.sent()) != sentBefore || len(re.items(s.ID).Items) != itemsBefore {
		t.Errorf("a refused send wrote %d lines, %d items", len(re.sent())-sentBefore, len(re.items(s.ID).Items)-itemsBefore)
	}

	// A turn in which Claude discovers skills.
	if _, err := re.m.Send(re.ctx(), s.ID, Message{Text: "read sub/notes.txt"}); err != nil {
		t.Fatal(err)
	}
	pushed := re.waitCommands(s.ID, "after the push", func(cs []SlashCommand) bool { return slices.Contains(names(cs), "beta-probe") })
	if len(pushed) != 44 || pushed[0].Name != "alpha-probe" {
		t.Errorf("pushed list %q", names(pushed))
	}

	// An effort restart: the new process's handshake is the list again.
	re.waitFor(s.ID, "idle", turnOver)
	if _, err := re.m.SetEffort(re.ctx(), s.ID, "high"); err != nil {
		t.Fatal(err)
	}
	re.waitFor(s.ID, "restarted", func(s Session) bool { return !s.EffortPending && s.Effort == "high" })
	re.waitCommands(s.ID, "after the restart", func(cs []SlashCommand) bool { return len(cs) == 42 })

	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	// Stopped: the last list stays (and is persisted; TestThreadCacheSurvivesRestart).
	re.waitFor(s.ID, "stopped", func(s Session) bool { return s.State == StateDisconnected })
	if cs, err := re.m.SlashCommands(re.ctx(), s.ID); len(cs) != 42 || err != nil {
		t.Errorf("stopped: %q, %v", names(cs), err)
	}
	if _, err := re.m.SlashCommands(re.ctx(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread: %v", err)
	}
}

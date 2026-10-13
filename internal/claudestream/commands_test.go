package claudestream

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"
)

// The commands fixture is a real run (Claude Code 2.1.296, haiku, a scratch repo): the
// initialize reply (trimmed to its commands and process fields), then two
// system/commands_changed pushes: a skill written to the repo's .claude/skills while
// idle (Claude watches the directory), and a skill in sub/.claude/skills discovered
// when the agent read a file under sub/ during a turn.
func TestCommandsFixture(t *testing.T) {
	lines := fixture(t, "commands")
	if len(lines) != 3 {
		t.Fatalf("%d lines", len(lines))
	}
	reply, ok := Parse(lines[0]).(*controlResponseLine)
	if !ok {
		t.Fatalf("line 0 is %T", Parse(lines[0]))
	}
	var ir InitializeResponse
	if err := json.Unmarshal(reply.Response.Response, &ir); err != nil {
		t.Fatal(err)
	}
	if len(ir.Commands) != 68 || ir.ClaudeCodeVersion != "2.1.296" {
		t.Fatalf("initialize: %d commands, version %q", len(ir.Commands), ir.ClaudeCodeVersion)
	}
	byName := func(cs []SlashCommand, name string) SlashCommand {
		t.Helper()
		i := slices.IndexFunc(cs, func(c SlashCommand) bool { return c.Name == name })
		if i < 0 {
			t.Fatalf("no command %q", name)
		}
		return cs[i]
	}
	if c := byName(ir.Commands, "loop"); c.ArgumentHint != "[interval] [prompt]" || !c.Builtin || !reflect.DeepEqual(c.Aliases, []string{"proactive"}) {
		t.Errorf("loop = %+v", c)
	}
	if c := byName(ir.Commands, "clear"); !reflect.DeepEqual(c.Aliases, []string{"reset", "new"}) {
		t.Errorf("clear = %+v", c)
	}
	if c := byName(ir.Commands, "agents"); c.Description[:9] != "(removed)" {
		t.Errorf("agents = %+v", c)
	}
	if c := byName(ir.Commands, "anthropic-skills:deep-research"); c.Builtin || c.Description == "" {
		t.Errorf("plugin skill = %+v", c)
	}
	if c := byName(ir.Commands, "context"); c.ArgumentHint != "" || c.Description != "Show current context usage" {
		t.Errorf("context = %+v", c)
	}

	changed := func(i int) *CommandsChanged {
		t.Helper()
		c, ok := Parse(lines[i]).(*CommandsChanged)
		if !ok {
			t.Fatalf("line %d is %T", i, Parse(lines[i]))
		}
		return c
	}
	watched := changed(1)
	if len(watched.Commands) != 69 || watched.Commands[0].Name != "alpha-probe" || watched.SessionID == "" {
		t.Errorf("watched push: %d commands, first %+v", len(watched.Commands), watched.Commands[0])
	}
	if c := watched.Commands[0]; c.Description != "Probe skill at the root (project)" || c.Builtin {
		t.Errorf("project skill = %+v", c)
	}
	found := changed(2)
	if len(found.Commands) != 70 {
		t.Errorf("discovered push: %d commands", len(found.Commands))
	}
	if c := byName(found.Commands, "beta-probe"); c.ArgumentHint != "<thing>" {
		t.Errorf("subdirectory skill = %+v", c)
	}
}

func TestParseCommandsChanged(t *testing.T) {
	tests := []struct {
		name string
		line string
		want []SlashCommand
	}{
		{"empty list", `{"type":"system","subtype":"commands_changed","commands":[]}`, []SlashCommand{}},
		{"no list", `{"type":"system","subtype":"commands_changed"}`, nil},
		{"fields", `{"type":"system","subtype":"commands_changed","commands":[{"name":"usage","description":"Show usage","argumentHint":"","aliases":["cost","stats"],"builtin":true},{"name":"mine","description":"Mine (user)","argumentHint":"<x>","extra":1}]}`,
			[]SlashCommand{
				{Name: "usage", Description: "Show usage", Aliases: []string{"cost", "stats"}, Builtin: true},
				{Name: "mine", Description: "Mine (user)", ArgumentHint: "<x>"},
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ev, ok := Parse([]byte(tt.line)).(*CommandsChanged)
			if !ok {
				t.Fatalf("parsed %T", Parse([]byte(tt.line)))
			}
			if !reflect.DeepEqual(ev.Commands, tt.want) {
				t.Errorf("commands = %#v", ev.Commands)
			}
		})
	}
}

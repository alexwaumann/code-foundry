package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func newSlashRegistry(t *testing.T) (*command.Registry, *threadtest.Fake) {
	t.Helper()
	b := bus.New()
	fake := threadtest.New(b)
	reg := command.NewRegistry()
	if err := command.RegisterSlash(reg, api.NewThread(fake, b)); err != nil {
		t.Fatal(err)
	}
	fake.Put(thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected})
	fake.PutSlashCommands("s1", []thread.SlashCommand{
		{Name: "deploy", Description: "Ship it (project)", ArgumentHint: "<env>"},
		{Name: "compact", Description: "Free up context by summarizing the conversation so far", ArgumentHint: "<optional custom summarization instructions>", Builtin: true},
		{Name: "usage", Description: "Show session cost", Aliases: []string{"cost", "stats"}, Builtin: true},
		{Name: "anthropic-skills:pdf", Description: "Use this skill whenever the user wants to do anything with PDF files.\nSecond line."},
	})
	fake.Put(thread.Thread{ID: "s2", Name: "gone", State: thread.StateDisconnected})
	return reg, fake
}

func TestSlashCommandsAvailability(t *testing.T) {
	reg, _ := newSlashRegistry(t)
	c, _ := reg.Get("thread.commands")
	for _, tt := range []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{"cli", command.Context{ActiveThreadID: "s1"}, true},
		{"gui thread", command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, true},
		{"no thread", command.Context{ActiveView: "projects"}, false},
	} {
		if got := c.Available(tt.ctx); got != tt.want {
			t.Errorf("%s: available = %v", tt.name, got)
		}
	}
}

func TestSlashCommandsCommand(t *testing.T) {
	tests := []struct {
		name     string
		id       string
		wantErr  connect.Code
		wantMsg  []string
		notMsg   []string
		wantJSON string
	}{
		{
			name: "table", id: "s1",
			wantMsg: []string{
				"4 slash commands\n",
				"NAME                   ARGS",
				"/deploy                <env>",
				"/compact               <optional custom summarization instructions>  Free up context",
				"/usage                 -                                             Show session cost",
				"/anthropic-skills:pdf  -                                             Use this skill whenever",
			},
			notMsg:   []string{"Second line", "cost, stats"},
			wantJSON: `[{"name":"deploy","description":"Ship it (project)","argumentHint":"\u003cenv\u003e","builtin":false},`,
		},
		{name: "never reported", id: "s2", wantMsg: []string{"no slash commands yet: Claude has not run in this thread"}, wantJSON: `[]`},
		{name: "unknown thread", id: "nope", wantErr: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, _ := newSlashRegistry(t)
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.commands", map[string]string{"id": tt.id})
			if tt.wantErr != 0 {
				var ce *connect.Error
				if !errors.As(err, &ce) || ce.Code() != tt.wantErr {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.wantMsg {
				if !strings.Contains(res.Message, w) {
					t.Errorf("message lacks %q:\n%s", w, res.Message)
				}
			}
			for _, w := range tt.notMsg {
				if strings.Contains(res.Message, w) {
					t.Errorf("message has %q:\n%s", w, res.Message)
				}
			}
			js, err := res.EncodeJSON()
			if err != nil || !strings.HasPrefix(js, tt.wantJSON) {
				t.Errorf("json = %s, %v", js, err)
			}
			var list []command.SlashCommandJSON
			if err := json.Unmarshal([]byte(js), &list); err != nil {
				t.Errorf("json is not a list: %v", err)
			}
		})
	}
}

func TestFormatSlashCommandsCuts(t *testing.T) {
	long := strings.Repeat("x", 150)
	out := command.FormatSlashCommands([]*v1.SlashCommand{{Name: "long", Description: long}})
	if !strings.Contains(out, strings.Repeat("x", 100)+"…") || strings.Contains(out, strings.Repeat("x", 101)) {
		t.Errorf("not cut:\n%s", out)
	}
}

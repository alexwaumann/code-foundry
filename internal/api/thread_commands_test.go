package api

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

func TestSlashCommandsToProto(t *testing.T) {
	tests := []struct {
		name string
		in   []session.SlashCommand
		want []string // name|hint|aliases|builtin
	}{
		{"none", nil, nil},
		{"empty", []session.SlashCommand{}, nil},
		{"fields", []session.SlashCommand{
			{Name: "loop", Description: "Run on an interval", ArgumentHint: "[interval] [prompt]", Aliases: []string{"proactive"}, Builtin: true},
			{Name: "mine", Description: "Mine (user)"},
		}, []string{"loop|[interval] [prompt]|[proactive]|true", "mine||[]|false"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := slashCommandsToProto(tt.in)
			var have []string
			for _, c := range got {
				have = append(have, fmt.Sprintf("%s|%s|%v|%v", c.GetName(), c.GetArgumentHint(), c.GetAliases(), c.GetBuiltin()))
			}
			if !slices.Equal(have, tt.want) {
				t.Errorf("mapped %q, want %q", have, tt.want)
			}
			for i, c := range got {
				if c.GetDescription() != tt.in[i].Description {
					t.Errorf("%s description %q", c.GetName(), c.GetDescription())
				}
			}
		})
	}
}

func TestThreadSlashCommands(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(session.Session{ID: "s1", State: session.StateConnected})
	fake.PutItems("s1", session.Item{ID: "u1", Kind: session.KindUserMessage, Text: "hi"})
	list := []session.SlashCommand{
		{Name: "compact", Description: "Free up context", ArgumentHint: "<optional custom summarization instructions>", Builtin: true},
		{Name: "deploy", Description: "Deploy it (project)"},
	}
	fake.PutSlashCommands("s1", list)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := c.SlashCommands(ctx, connect.NewRequest(&v1.SlashCommandsRequest{SessionId: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown thread: %v", err)
	}
	got, err := c.SlashCommands(ctx, connect.NewRequest(&v1.SlashCommandsRequest{SessionId: "s1"}))
	if err != nil || len(got.Msg.GetCommands()) != 2 || got.Msg.GetCommands()[1].GetName() != "deploy" {
		t.Fatalf("SlashCommands %v %v", got, err)
	}

	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchThreadRequest{SessionId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	next := func() *v1.ThreadEvent {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg()
	}
	snap := next().GetSnapshot()
	if snap.GetSeq() != 2 || len(snap.GetCommands()) != 2 || snap.GetCommands()[0].GetArgumentHint() == "" || !snap.GetCommands()[0].GetBuiltin() {
		t.Fatalf("snapshot %v", snap)
	}

	// Claude pushes a new list.
	fake.PutSlashCommands("s1", append(slices.Clone(list), session.SlashCommand{Name: "beta", Description: "Found (project)"}))
	if ev := next().GetCommands(); ev.GetSessionId() != "s1" || ev.GetSeq() != 3 || len(ev.GetCommands()) != 3 || ev.GetCommands()[2].GetName() != "beta" {
		t.Errorf("push event %v", ev)
	}
	// The process ends: an empty list.
	fake.PutSlashCommands("s1", nil)
	if ev := next().GetCommands(); ev == nil || ev.GetSeq() != 4 || len(ev.GetCommands()) != 0 {
		t.Errorf("drop event %v", ev)
	}
	none, err := c.SlashCommands(ctx, connect.NewRequest(&v1.SlashCommandsRequest{SessionId: "s1"}))
	if err != nil || len(none.Msg.GetCommands()) != 0 {
		t.Errorf("not running %v %v", none, err)
	}
}

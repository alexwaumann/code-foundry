package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadRead(t *testing.T) {
	reg, fake := newThreadRegistry(t)
	var items []thread.Item
	for i, text := range []string{"one", "two", "three", "four", "five"} {
		kind := thread.KindAssistantText
		if i%2 == 0 {
			kind = thread.KindUserMessage
		}
		items = append(items, thread.Item{ID: "i" + string(rune('1'+i)), Kind: kind, Text: text})
	}
	fake.PutItems("s1", items...)
	read := func(args map[string]string) (command.Result, error) {
		args["id"] = "s1"
		return reg.Invoke(context.Background(), command.Context{}, "thread.read", args)
	}
	tests := []struct {
		name     string
		args     map[string]string
		want     string
		wantNext string
		wantMore bool
	}{
		{name: "the last 20", args: map[string]string{}, want: "#1 you: one\n#2 claude: two\n#3 you: three\n#4 claude: four\n#5 you: five", wantNext: "i5"},
		{name: "the last 2", args: map[string]string{"last": "2"}, want: "#4 claude: four\n#5 you: five", wantNext: "i5"},
		{name: "since an ordinal, one", args: map[string]string{"since": "2", "last": "1"}, want: "#3 you: three\n(more: --since i3 reads on)", wantNext: "i3", wantMore: true},
		{name: "since its next", args: map[string]string{"since": "i3"}, want: "#4 claude: four\n#5 you: five", wantNext: "i5"},
		{name: "nothing new", args: map[string]string{"since": "i5"}, want: "(nothing after i5 yet)", wantNext: "i5"},
		{name: "a role", args: map[string]string{"role": "assistant"}, want: "#2 claude: two\n#4 claude: four", wantNext: "i4"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := read(tt.args)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Errorf("message =\n%s\nwant\n%s", res.Message, tt.want)
			}
			p, ok := res.JSON.(*v1.ThreadItemsPage)
			if !ok || p.GetNextSince() != tt.wantNext || p.GetMore() != tt.wantMore {
				t.Errorf("JSON = %v", res.JSON)
			}
		})
	}
	if _, err := read(map[string]string{"since": "nope"}); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown since: %v", err)
	}
	if _, err := read(map[string]string{"last": "-1"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("negative last: %v", err)
	}
	if c, _ := reg.Get("thread.read"); !c.NoKeybinding || !strings.Contains(c.Description, "nextSince") {
		t.Errorf("thread.read = %+v", c)
	}
}

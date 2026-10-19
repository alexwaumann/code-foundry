package api

import (
	"slices"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestPageItems(t *testing.T) {
	items := []thread.Item{
		{ID: "note-created-by", Ordinal: 1, Kind: thread.KindNote},
		{ID: "u1", Ordinal: 2, Kind: thread.KindUserMessage},
		{ID: "toolu_1", Ordinal: 3, Kind: thread.KindToolCall, Tool: &thread.ToolCall{Status: thread.ToolDone}},
		{ID: "m1/0", Ordinal: 4, Kind: thread.KindAssistantText},
		{ID: "turn-1", Ordinal: 5, Kind: thread.KindTurnEnd},
		{ID: "w1", Ordinal: 6, Kind: thread.KindUserMessage, Origin: thread.OriginWake},
		{ID: "perm-1", Ordinal: 7, Kind: thread.KindPermission},
		{ID: "m2/0", Ordinal: 8, Kind: thread.KindAssistantText, Streaming: true},
	}
	const (
		user, assistant, tool = v1.ThreadItemRole_THREAD_ITEM_ROLE_USER, v1.ThreadItemRole_THREAD_ITEM_ROLE_ASSISTANT, v1.ThreadItemRole_THREAD_ITEM_ROLE_TOOL
		note, wake            = v1.ThreadItemRole_THREAD_ITEM_ROLE_NOTE, v1.ThreadItemRole_THREAD_ITEM_ROLE_WAKE
	)
	tests := []struct {
		name     string
		q        *v1.ThreadItemsQuery
		want     []string
		wantNext string
		wantMore bool
		notFound bool
	}{
		{name: "everything, the streaming item last", q: &v1.ThreadItemsQuery{},
			want: []string{"note-created-by", "u1", "toolu_1", "m1/0", "turn-1", "w1", "perm-1", "m2/0"}, wantNext: "perm-1"},
		{name: "the last few", q: &v1.ThreadItemsQuery{Last: 3}, want: []string{"w1", "perm-1", "m2/0"}, wantNext: "perm-1"},
		{name: "since an id", q: &v1.ThreadItemsQuery{Since: "m1/0"}, want: []string{"turn-1", "w1", "perm-1", "m2/0"}, wantNext: "perm-1"},
		{name: "since an ordinal", q: &v1.ThreadItemsQuery{Since: "5"}, want: []string{"w1", "perm-1", "m2/0"}, wantNext: "perm-1"},
		{name: "since, the first few, more", q: &v1.ThreadItemsQuery{Since: "1", Last: 2}, want: []string{"u1", "toolu_1"}, wantNext: "toolu_1", wantMore: true},
		{name: "since, exactly the rest", q: &v1.ThreadItemsQuery{Since: "u1", Last: 6}, want: []string{"toolu_1", "m1/0", "turn-1", "w1", "perm-1", "m2/0"}, wantNext: "perm-1"},
		{name: "since the end", q: &v1.ThreadItemsQuery{Since: "8"}, want: nil, wantNext: "8"},
		{name: "only the streaming item keeps since", q: &v1.ThreadItemsQuery{Since: "perm-1"}, want: []string{"m2/0"}, wantNext: "perm-1"},
		{name: "role user leaves wakes out", q: &v1.ThreadItemsQuery{Role: user}, want: []string{"u1"}, wantNext: "u1"},
		{name: "role wake", q: &v1.ThreadItemsQuery{Role: wake}, want: []string{"w1"}, wantNext: "w1"},
		{name: "role assistant", q: &v1.ThreadItemsQuery{Role: assistant, Last: 1}, want: []string{"m2/0"}, wantNext: ""},
		{name: "role tool", q: &v1.ThreadItemsQuery{Role: tool}, want: []string{"toolu_1", "perm-1"}, wantNext: "perm-1"},
		{name: "role note since the start", q: &v1.ThreadItemsQuery{Role: note, Since: "0"}, want: []string{"note-created-by"}, wantNext: "note-created-by"},
		{name: "role and since: since is any item", q: &v1.ThreadItemsQuery{Role: assistant, Since: "turn-1"}, want: []string{"m2/0"}, wantNext: "turn-1"},
		{name: "an unknown since", q: &v1.ThreadItemsQuery{Since: "nope"}, notFound: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := pageItems(items, tt.q)
			if tt.notFound {
				if connect.CodeOf(err) != connect.CodeNotFound {
					t.Fatalf("err = %v, want NotFound", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, it := range p.items {
				got = append(got, it.ID)
			}
			if !slices.Equal(got, tt.want) || p.nextSince != tt.wantNext || p.more != tt.wantMore {
				t.Errorf("page = %v next %q more %v; want %v %q %v", got, p.nextSince, p.more, tt.want, tt.wantNext, tt.wantMore)
			}
		})
	}
}

// A message Claude read later than it arrived (PlacedAfter) is shown where it was read;
// pages still count by ordinal, so a since read on never skips it.
func TestPageItemsPlaced(t *testing.T) {
	items := []thread.Item{ // the log's order
		{ID: "u1", Ordinal: 1, Kind: thread.KindUserMessage},
		{ID: "m1/0", Ordinal: 2, Kind: thread.KindAssistantText},
		{ID: "toolu_1", Ordinal: 4, Kind: thread.KindToolCall, Tool: &thread.ToolCall{Status: thread.ToolDone}},
		{ID: "u2", Ordinal: 3, Kind: thread.KindUserMessage, PlacedAfter: 4},
		{ID: "m2/0", Ordinal: 5, Kind: thread.KindAssistantText},
	}
	tests := []struct {
		name     string
		q        *v1.ThreadItemsQuery
		want     []string
		wantNext string
		wantMore bool
	}{
		{name: "everything in the log's order", q: &v1.ThreadItemsQuery{}, want: []string{"u1", "m1/0", "toolu_1", "u2", "m2/0"}, wantNext: "m2/0"},
		{name: "the last two by ordinal", q: &v1.ThreadItemsQuery{Last: 2}, want: []string{"toolu_1", "m2/0"}, wantNext: "m2/0"},
		{name: "the first two after u1", q: &v1.ThreadItemsQuery{Since: "u1", Last: 2}, want: []string{"m1/0", "u2"}, wantNext: "u2", wantMore: true},
		{name: "reading on from there", q: &v1.ThreadItemsQuery{Since: "u2", Last: 2}, want: []string{"toolu_1", "m2/0"}, wantNext: "m2/0"},
		{name: "since the placed message's ordinal", q: &v1.ThreadItemsQuery{Since: "3"}, want: []string{"toolu_1", "m2/0"}, wantNext: "m2/0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := pageItems(items, tt.q)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, it := range p.items {
				got = append(got, it.ID)
			}
			if !slices.Equal(got, tt.want) || p.nextSince != tt.wantNext || p.more != tt.wantMore {
				t.Errorf("page = %v next %q more %v; want %v %q %v", got, p.nextSince, p.more, tt.want, tt.wantNext, tt.wantMore)
			}
		})
	}
	if ord, ok := lastMessage(items); !ok || ord != 3 {
		t.Errorf("lastMessage = %d %v, want 3 (the newest message, not the last in the log)", ord, ok)
	}
}

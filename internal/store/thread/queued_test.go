package thread

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Frames as Claude Code 2.1.303 writes them (probed for docs/notes/orch-queued-placement.md),
// cut to what the projection reads.
func toolUse(msg, id string) string {
	return fmt.Sprintf(`{"type":"assistant","message":{"id":%q,"model":"claude-haiku-5-5","content":[{"type":"tool_use","id":%q,"name":"Bash","input":{"command":"sleep 4"}}]},"parent_tool_use_id":null}`, msg, id)
}

func toolResult(id string) string {
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":%q,"content":"ok","is_error":false}]},"parent_tool_use_id":null}`, id)
}

func replyText(msg, text string) string {
	return fmt.Sprintf(`{"type":"assistant","message":{"id":%q,"model":"claude-haiku-5-5","content":[{"type":"text","text":%q}]},"parent_tool_use_id":null}`, msg, text)
}

func lifecycle(id, state string) string {
	return fmt.Sprintf(`{"type":"command_lifecycle","command_uuid":%q,"state":%q}`, id, state)
}

func requesting(ids ...string) string {
	return fmt.Sprintf(`{"type":"system","subtype":"status","status":"requesting","user_message_uuids":["%s"]}`, strings.Join(ids, `","`))
}

func result(queuedTurns int) string {
	return fmt.Sprintf(`{"type":"result","subtype":"success","is_error":false,"duration_ms":10,"num_turns":1,"total_cost_usd":0.001,"queued_turn_count":%d}`, queuedTurns)
}

// queuedLabel names an item for TestQueuedPlacement: a message by its id (with "*" while
// queued), a tool call by its tool_use id, text by its text, a turn end as "end".
func queuedLabel(it Item) string {
	switch it.Kind {
	case KindUserMessage:
		if it.Queued {
			return it.ID + "*"
		}
		return it.ID
	case KindToolCall:
		return it.Tool.ToolUseID
	case KindAssistantText:
		return it.Text
	case KindTurnEnd:
		return "end"
	}
	return string(it.Kind)
}

// A message that arrives while Claude works is shown queued, then moves to where Claude
// read it: after what was written while it waited, above the text that answers it.
// "send:<id>" is a message sent while Claude works (queued), "idle:<id>" one sent while it
// does not, "wake:<id>" a wake sent while it works; anything else is a stream line.
func TestQueuedPlacement(t *testing.T) {
	tests := []struct {
		name  string
		steps []string
		// want is the log in order after the steps; mid, when set, the log right after the
		// step at index midAt.
		want  []string
		midAt int
		mid   []string
		// placed: the message ids that moved (PlacedAfter set).
		placed []string
	}{
		{
			name: "arrives while Claude writes, read at the next tool call",
			steps: []string{"idle:u1", lifecycle("u1", "started"), replyText("m1", "Running it"), "send:u2",
				toolUse("m1", "A"), toolResult("A"), lifecycle("u2", "started"), replyText("m2", "answer to u2"), result(0)},
			midAt: 4, mid: []string{"u1", "Running it", "u2*", "A"},
			want:   []string{"u1", "Running it", "A", "u2", "answer to u2", "end"},
			placed: []string{"u2"},
		},
		{
			name: "arrives during a tool call, read right after it: already in place",
			steps: []string{"idle:u1", toolUse("m1", "A"), "send:u2", toolResult("A"), lifecycle("u2", "started"),
				replyText("m2", "answer to u2"), result(0)},
			midAt: 3, mid: []string{"u1", "A", "u2*"},
			want: []string{"u1", "A", "u2", "answer to u2", "end"},
		},
		{
			name: "arrives during the final reply, read when it ends: same turn",
			steps: []string{"idle:u1", toolUse("m1", "A"), toolResult("A"), "send:u2", replyText("m2", "the story"),
				lifecycle("u1", "completed"), lifecycle("u2", "started"), replyText("m3", "answer to u2"), result(0)},
			midAt: 4, mid: []string{"u1", "A", "u2*", "the story"},
			want:   []string{"u1", "A", "the story", "u2", "answer to u2", "end"},
			placed: []string{"u2"},
		},
		{
			name: "a wake is placed like a message",
			steps: []string{"idle:u1", replyText("m1", "Waiting on the child"), "wake:w1", toolUse("m1", "A"), toolResult("A"),
				lifecycle("w1", "started"), replyText("m2", "the child is done"), result(0)},
			want:   []string{"u1", "Waiting on the child", "A", "w1", "the child is done", "end"},
			placed: []string{"w1"},
		},
		{
			name: "read after the turn's result: the next turn",
			// Probed: the result says queued_turn_count 0 although u2 waits; started follows it.
			steps: []string{"idle:u1", replyText("m1", "done"), "send:u2", result(0), lifecycle("u1", "completed"), lifecycle("u2", "started"),
				replyText("m2", "answer to u2"), result(0)},
			midAt: 4, mid: []string{"u1", "done", "u2*", "end"},
			want:   []string{"u1", "done", "end", "u2", "answer to u2", "end"},
			placed: []string{"u2"},
		},
		{
			name: "two queued messages read together keep their order",
			steps: []string{"idle:u1", toolUse("m1", "A"), "send:u2", "send:u3", toolResult("A"), replyText("m1b", "still on it"),
				toolUse("m1b", "B"), toolResult("B"), lifecycle("u2", "started"), lifecycle("u3", "started"), replyText("m2", "both"), result(0)},
			want:   []string{"u1", "A", "still on it", "B", "u2", "u3", "both", "end"},
			placed: []string{"u2", "u3"},
		},
		{
			name: "the requesting status is a signal too",
			steps: []string{"idle:u1", replyText("m1", "Running it"), "send:u2", toolUse("m1", "A"), toolResult("A"),
				requesting("u1", "u2"), replyText("m2", "answer"), result(0)},
			want:   []string{"u1", "Running it", "A", "u2", "answer", "end"},
			placed: []string{"u2"},
		},
		{
			name:  "a message sent while idle is never queued",
			steps: []string{"idle:u1", lifecycle("u1", "queued"), lifecycle("u1", "started"), replyText("m1", "hi"), result(0)},
			want:  []string{"u1", "hi", "end"},
		},
		{
			name:  "cancelled: unqueued where it is",
			steps: []string{"idle:u1", replyText("m1", "Running it"), "send:u2", toolUse("m1", "A"), lifecycle("u2", "cancelled"), toolResult("A")},
			want:  []string{"u1", "Running it", "u2", "A"},
		},
		{
			name:  "no signal yet at the end of the turn: still queued",
			steps: []string{"idle:u1", replyText("m1", "Running it"), "send:u2", toolUse("m1", "A"), toolResult("A"), replyText("m2", "done"), result(0)},
			want:  []string{"u1", "Running it", "u2*", "A", "done", "end"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := newThreadLog("s", bus.New(), time.Now, nil)
			saved := map[string]Item{}
			w := itemWriter{log: log, save: func(it Item) { saved[it.ID] = it }}
			p := newProjector(w, runningTotals{known: true})
			labels := func() []string {
				var out []string
				for _, it := range log.snapshot().Items {
					out = append(out, queuedLabel(it))
				}
				return out
			}
			for i, step := range tt.steps {
				kind, id, ok := strings.Cut(step, ":")
				switch {
				case ok && kind == "send":
					w.add(Item{ID: id, Kind: KindUserMessage, Text: id, Queued: true})
				case ok && kind == "wake":
					w.add(Item{ID: id, Kind: KindUserMessage, Text: id, Origin: OriginWake, WakeTitle: "child idle", Queued: true})
				case ok && kind == "idle":
					w.add(Item{ID: id, Kind: KindUserMessage, Text: id})
				default:
					p.event(claudestream.Parse([]byte(step)))
				}
				if tt.mid != nil && i == tt.midAt {
					if got := labels(); !slices.Equal(got, tt.mid) {
						t.Errorf("after step %d: %v, want %v", i, got, tt.mid)
					}
				}
			}
			if got := labels(); !slices.Equal(got, tt.want) {
				t.Errorf("log = %v, want %v", got, tt.want)
			}
			// Placed messages keep their ordinal; what moved is persisted with its place,
			// and a log loaded from the rows has the same order.
			snap := log.snapshot().Items
			var placedIDs []string
			for _, it := range snap {
				if it.PlacedAfter > 0 {
					placedIDs = append(placedIDs, it.ID)
					if it.PlacedAfter <= it.Ordinal {
						t.Errorf("%s placed after %d, not after a newer item (ordinal %d)", it.ID, it.PlacedAfter, it.Ordinal)
					}
				}
				if it.Kind == KindUserMessage && saved[it.ID].PlacedAfter != it.PlacedAfter {
					t.Errorf("%s saved with PlacedAfter %d, have %d", it.ID, saved[it.ID].PlacedAfter, it.PlacedAfter)
				}
			}
			if !slices.Equal(placedIDs, tt.placed) {
				t.Errorf("placed = %v, want %v", placedIDs, tt.placed)
			}
			byOrd := slices.SortedFunc(slices.Values(snap), func(a, b Item) int { return int(a.Ordinal - b.Ordinal) })
			reloaded := newThreadLog("s", bus.New(), time.Now, byOrd).snapshot().Items
			if !slices.EqualFunc(reloaded, snap, func(a, b Item) bool { return a.ID == b.ID }) {
				t.Errorf("reloaded order differs from the live one")
			}
		})
	}
}

// A run that ends with a message still queued leaves it unqueued where it is: Claude
// never read it.
func TestCloseUnfinishedUnqueues(t *testing.T) {
	log := newThreadLog("s", bus.New(), time.Now, nil)
	w := itemWriter{log: log, save: func(Item) {}}
	w.add(Item{ID: "u1", Kind: KindUserMessage, Text: "go"})
	w.add(Item{ID: "u2", Kind: KindUserMessage, Text: "status?", Queued: true})
	closeUnfinished(w, "the thread's process ended")
	if it, _ := log.get("u2"); it.Queued || it.PlacedAfter != 0 {
		t.Errorf("u2 after close: queued %v placed after %d", it.Queued, it.PlacedAfter)
	}
}

// A fork renumbers the copied items in the log's order, so a placed message's place is
// its ordinal there.
func TestForkKeepsPlacedOrder(t *testing.T) {
	parent := []Item{
		{ID: "u1", Ordinal: 1, Kind: KindUserMessage},
		{ID: "A", Ordinal: 3, Kind: KindToolCall, Tool: &ToolCall{ToolUseID: "A", Status: ToolDone}},
		{ID: "u2", Ordinal: 2, Kind: KindUserMessage, PlacedAfter: 3},
		{ID: "t", Ordinal: 4, Kind: KindAssistantText},
	}
	got := forkItems(parent, "note", "Forked", time.Now())
	for i, want := range []string{"u1", "A", "u2", "t", "note"} {
		if got[i].ID != want || got[i].Ordinal != int64(i+1) || got[i].PlacedAfter != 0 {
			t.Errorf("fork item %d = %s #%d placed after %d, want %s #%d", i, got[i].ID, got[i].Ordinal, got[i].PlacedAfter, want, i+1)
		}
	}
}

// Sent while Claude works (here: waiting on a permission), a message is queued; sent
// while it does not, it is not. The capture has no frames for it, so it stays queued until
// the process ends.
func TestSendWhileWorkingIsQueued(t *testing.T) {
	re := newFixtureEnv(t, "write-allow")
	s := re.create(CreateOptions{Model: "haiku", PermissionMode: PermissionSupervised, InitialPrompt: "create hello.txt"})
	re.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	if first := re.items(s.ID).Items[0]; first.Kind != KindUserMessage || first.Queued {
		t.Errorf("first prompt %+v: queued", first)
	}
	it, err := re.m.Send(re.ctx(), s.ID, Message{Text: "status?"})
	if err != nil {
		t.Fatal(err)
	}
	if !it.Queued {
		t.Errorf("sent mid-turn: %+v not queued", it)
	}
	snap := re.items(s.ID)
	if _, err := re.m.Respond(re.ctx(), s.ID, snap.Pending[0].RequestID, Decision{Allow: true}); err != nil {
		t.Fatal(err)
	}
	re.waitFor(s.ID, "the turn's end", func(s Thread) bool { return s.Status != StatusNeedsAttention || s.StatusReason == "finished" })
	if got := re.items(s.ID).Items; !slices.ContainsFunc(got, func(x Item) bool { return x.ID == it.ID && x.Queued }) {
		t.Errorf("no signal yet, but the message is not queued: %+v", got)
	}
	if _, err := re.m.Archive(re.ctx(), s.ID, true); err != nil {
		t.Fatal(err)
	}
	re.waitItems(s.ID, "the message unqueued at the process end", func(items []Item) bool {
		i := slices.IndexFunc(items, func(x Item) bool { return x.ID == it.ID })
		return i >= 0 && !items[i].Queued
	})
}

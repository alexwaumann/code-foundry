package thread

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// testdata/forkcut holds real transcripts of Claude Code 2.1.325 (haiku, driven by the
// daemon over stream-json; clear.jsonl by claude -p over stream-json), cut down to the
// fields the cut reads, and the daemon's items of the same threads (thread items --json,
// cut down to id, kind, parent, placement; clear.items.json written by hand from the
// uuids sent and the transcripts' message ids):
//
//	two-turns  two plain turns
//	tool-call  a turn with a Bash call, then a plain turn
//	steer      a message sent mid-turn (a queued_command attachment), then a turn
//	interrupt  a turn interrupted during a tool call, then a turn
//	compact    two turns, /compact (its kept tail: turn 2's replies), two turns
//	slash      a turn, a prompt command (/greet), a local command (/cost), a turn
//	subagent   a background Agent, a turn while it reports back
//	tasknote   a background shell, a turn, the turn Claude opened for its notification
//	clear      a turn, /clear (a new session), a turn: the current transcript only

// forkFixture loads testdata/forkcut/<name>: the items in timeline order and the
// transcript's records.
func forkFixture(t *testing.T, name string) ([]Item, []cutRecord) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "forkcut", name+".items.json"))
	if err != nil {
		t.Fatal(err)
	}
	var raw []struct {
		ID          string `json:"id"`
		Kind        string `json:"kind"`
		Parent      string `json:"parent"`
		PlacedAfter int64  `json:"placedAfter"`
		Ordinal     int64  `json:"ordinal"`
		Text        string `json:"text"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	kinds := map[string]ItemKind{
		"userMessage": KindUserMessage, "thinking": KindThinking, "assistantText": KindAssistantText,
		"toolCall": KindToolCall, "turnEnd": KindTurnEnd, "note": KindNote, "compaction": KindCompaction,
		"commandOutput": KindCommandOutput,
	}
	items := make([]Item, len(raw))
	for i, r := range raw {
		k, ok := kinds[r.Kind]
		if !ok {
			t.Fatalf("%s: kind %q", name, r.Kind)
		}
		items[i] = Item{ID: r.ID, Kind: k, ParentToolUseID: r.Parent, PlacedAfter: r.PlacedAfter, Ordinal: r.Ordinal, Text: r.Text}
	}
	slices.SortStableFunc(items, itemOrder)
	f, err := os.Open(filepath.Join("testdata", "forkcut", name+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	recs, err := readCutRecords(f)
	if err != nil {
		t.Fatal(err)
	}
	return items, recs
}

func TestForkCut(t *testing.T) {
	// Cuts are written as the record uuid's first 8 digits; "" is the whole conversation.
	tests := []struct {
		fixture, at string
		busy        bool
		// drop leaves the items after the turn end out (they have not arrived yet).
		drop    bool
		want    string
		wantErr string
		// legacy is the cut of a transcript older than turnOrigin, when it differs.
		legacy *string
	}{
		{fixture: "two-turns", at: "#4", want: "8ecc4ee9"}, // turn 2's message's parent: the prompt snapshot after turn 1's reply
		{fixture: "two-turns", at: "#8", want: ""},
		{fixture: "two-turns", at: "#8", busy: true, wantErr: "the start of the turn after turn 2 is not in Claude's transcript yet"},

		{fixture: "tool-call", at: "#5", want: "8b4d5741"},
		{fixture: "tool-call", at: "#8", want: ""},

		// The steer is turn 1's (a queued_command attachment), never an opening.
		{fixture: "steer", at: "#5", want: "fca90c5e"},
		{fixture: "steer", at: "#8", want: ""},

		// The cut keeps the interrupt marker: the fork knows the turn was stopped.
		{fixture: "interrupt", at: "#4", want: "590efb6c"},
		// Items not there yet: the transcript's next opening still ends the turn.
		{fixture: "interrupt", at: "#4", drop: true, want: "590efb6c"},
		{fixture: "interrupt", at: "#8", want: ""},

		{fixture: "compact", at: "#4", wantErr: "the conversation was compacted after turn 1"},
		// Turn 2's replies are the compaction's kept tail: the boundary's logical parent.
		{fixture: "compact", at: "#8", want: "1dfa79b1"},
		{fixture: "compact", at: "#12", want: "6d1f94bd"},
		{fixture: "compact", at: "#16", want: "1407bf2a"},
		{fixture: "compact", at: "#19", want: ""},

		{fixture: "slash", at: "#4", want: "7672033f"},
		// /cost opens with its caveat (isMeta): the cut is /greet's reply before it.
		{fixture: "slash", at: "#7", want: "610281d5"},
		// A local command's turn ends with a system record.
		{fixture: "slash", at: "#10", want: "aa0d5929"},
		{fixture: "slash", at: "#13", want: ""},

		{fixture: "subagent", at: "#6", want: "eefdf89b"},
		// The agent's report came after the latest turn, unanswered: not the fork's.
		// Without turnOrigin a meta hand-back is not told from a caveat: the turn ends
		// the conversation, report and all.
		{fixture: "subagent", at: "#11", want: "b35dd424", legacy: new("")},

		{fixture: "tasknote", at: "#7", want: "b7c2f525"},
		// The next turn has no user message: its notification record opens it.
		{fixture: "tasknote", at: "#11", want: "aa3e8502"},
		{fixture: "tasknote", at: "#15", want: ""},

		{fixture: "clear", at: "turn-clear-1", wantErr: "turn 1 is not in the thread's current Claude conversation"},
		{fixture: "clear", at: "turn-clear-2", want: "2cc73932"},
		{fixture: "clear", at: "turn-clear-3", want: ""},
	}
	for _, legacy := range []bool{false, true} {
		for _, tt := range tests {
			name := tt.fixture + " " + tt.at
			if tt.busy {
				name += " busy"
			}
			if tt.drop {
				name += " before the items"
			}
			if legacy {
				name += " without turnOrigin"
				if tt.legacy != nil {
					tt.want = *tt.legacy
				}
			}
			t.Run(name, func(t *testing.T) { checkForkCut(t, tt.fixture, tt.at, tt.busy, tt.drop, legacy, tt.want, tt.wantErr) })
		}
	}
}

// checkForkCut forks fixture at at and checks the cut (want: its uuid's first digits)
// or the refusal (wantErr). drop leaves out the items after the turn end; legacy drops
// turnOrigin from the records.
func checkForkCut(t *testing.T, fixture, at string, busy, drop, legacy bool, want, wantErr string) {
	t.Helper()
	items, recs := forkFixture(t, fixture)
	if legacy {
		for i := range recs {
			recs[i].origin = ""
		}
	}
	turn, err := forkAt(items, at, busy)
	if err != nil {
		t.Fatal(err)
	}
	if drop {
		items = items[:turn.end+1]
	}
	cut, err := forkCut(items, turn, recs, busy)
	if wantErr != "" {
		if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), wantErr) {
			t.Fatalf("err = %v; want ErrFailedPrecondition with %q (cut %q)", err, wantErr, cut)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if want == "" && cut != "" || !strings.HasPrefix(cut, want) {
		t.Errorf("cut = %q; want %q…", cut, want)
	}
}

// The next opening message the transcript does not have: refused, not guessed.
func TestForkCutOpeningMissing(t *testing.T) {
	items, recs := forkFixture(t, "two-turns")
	turn, err := forkAt(items, "#4", false)
	if err != nil {
		t.Fatal(err)
	}
	// Turn 2's message never reached the transcript (Claude has not read it yet).
	recs = slices.DeleteFunc(slices.Clone(recs), func(r cutRecord) bool { return strings.HasPrefix(r.uuid, "cf2ab84e") })
	_, err = forkCut(items, turn, recs, false)
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "the start of the turn after turn 1 is not in Claude's transcript") {
		t.Fatalf("err = %v", err)
	}
	// A reseed's new session has neither turn.
	_, err = forkCut(items, turn, nil, false)
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "not in the thread's current Claude conversation") {
		t.Fatalf("err = %v", err)
	}
}

func TestForkAt(t *testing.T) {
	user := func(id string, ord int64) Item { return Item{ID: id, Ordinal: ord, Kind: KindUserMessage} }
	text := func(id string, ord int64) Item { return Item{ID: id, Ordinal: ord, Kind: KindAssistantText} }
	end := func(id string, ord int64) Item {
		return Item{ID: id, Ordinal: ord, Kind: KindTurnEnd, Turn: &TurnEnd{}}
	}
	items := []Item{
		user("u1", 1), text("m1/0", 2), end("turn-1", 3),
		{ID: "sub/0", Ordinal: 4, Kind: KindTurnEnd, ParentToolUseID: "toolu_a"},
		user("u2", 5), text("m2/0", 6), end("turn-2", 7),
		user("u3", 8), text("m3/0", 9),
	}
	tests := []struct {
		at        string
		busy      bool
		want      forkTurn
		wantErr   error
		errSubstr string
	}{
		{at: "turn-1", want: forkTurn{end: 2, n: 1, total: 2}},
		{at: "#7", want: forkTurn{end: 6, n: 2, total: 2}},
		{at: "u2", wantErr: ErrInvalidArgument, errSubstr: "#5 (user message) is not a turn end"},
		{at: "sub/0", wantErr: ErrInvalidArgument, errSubstr: "not a turn end"},
		{at: "nope", wantErr: ErrInvalidArgument, errSubstr: "the thread has no item nope"},
		{at: "7", wantErr: ErrInvalidArgument, errSubstr: "no item 7"},
		{at: "#99", wantErr: ErrInvalidArgument, errSubstr: "no item #99"},
		{at: "m3/0", busy: true, wantErr: ErrFailedPrecondition, errSubstr: "#9 is in the turn that is still running"},
		{at: "m3/0", wantErr: ErrInvalidArgument, errSubstr: "not a turn end"},
		{at: "m2/0", busy: true, wantErr: ErrInvalidArgument, errSubstr: "#6 (assistant text) is not a turn end"},
	}
	for _, tt := range tests {
		t.Run(tt.at, func(t *testing.T) {
			got, err := forkAt(items, tt.at, tt.busy)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.errSubstr) {
					t.Fatalf("err = %v; want %v with %q", err, tt.wantErr, tt.errSubstr)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("forkAt = %+v, %v; want %+v", got, err, tt.want)
			}
		})
	}
}

// A message Claude read late is placed after the item it answers (queued.go): one
// placed after the turn end is the next turn's, not the forked turn's.
func TestForkAtPlacedMessage(t *testing.T) {
	items := []Item{
		{ID: "u1", Ordinal: 1, Kind: KindUserMessage},
		{ID: "late", Ordinal: 2, Kind: KindUserMessage, PlacedAfter: 4},
		{ID: "m1/0", Ordinal: 3, Kind: KindAssistantText},
		{ID: "turn-1", Ordinal: 4, Kind: KindTurnEnd},
		{ID: "m2/0", Ordinal: 5, Kind: KindAssistantText},
		{ID: "turn-2", Ordinal: 6, Kind: KindTurnEnd},
	}
	slices.SortStableFunc(items, itemOrder)
	turn, err := forkAt(items, "turn-1", false)
	if err != nil {
		t.Fatal(err)
	}
	var kept []string
	for _, it := range items[:turn.end+1] {
		kept = append(kept, it.ID)
	}
	if want := []string{"u1", "m1/0", "turn-1"}; !slices.Equal(kept, want) {
		t.Errorf("the fork copies %v; want %v", kept, want)
	}
	// The cut is that message's parent record, as for any opening message.
	recs := []cutRecord{
		{uuid: "u1", typ: "user"},
		{uuid: "a1", parent: "u1", typ: "assistant", msgID: "m1"},
		{uuid: "late", parent: "a1", typ: "user"},
		{uuid: "a2", parent: "late", typ: "assistant", msgID: "m2"},
	}
	if cut, err := forkCut(items, turn, recs, false); err != nil || cut != "a1" {
		t.Errorf("cut = %q, %v; want a1", cut, err)
	}
}

func TestParseCutRecord(t *testing.T) {
	tests := []struct {
		line string
		want cutRecord
		ok   bool
	}{
		{`{"type":"queue-operation","operation":"enqueue"}`, cutRecord{}, false},
		{`{"type":"last-prompt","leafUuid":"x"}`, cutRecord{}, false},
		{`not json "uuid"`, cutRecord{}, false},
		{`{"type":"user","uuid":"u","parentUuid":null,"turnOrigin":"sdk","message":{"role":"user","content":"hi"}}`,
			cutRecord{uuid: "u", typ: "user", origin: "sdk"}, true},
		{`{"type":"user","uuid":"r","parentUuid":"a","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t"}]}}`,
			cutRecord{uuid: "r", parent: "a", typ: "user", toolResult: true}, true},
		{`{"type":"user","uuid":"i","parentUuid":"a","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}`,
			cutRecord{uuid: "i", parent: "a", typ: "user", interrupt: true}, true},
		{`{"type":"assistant","uuid":"a","parentUuid":"u","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking"},{"type":"tool_use","id":"toolu_1","name":"Bash"}]}}`,
			cutRecord{uuid: "a", parent: "u", typ: "assistant", msgID: "msg_1", toolUses: []string{"toolu_1"}}, true},
		{`{"type":"attachment","uuid":"q","parentUuid":"r","attachment":{"type":"queued_command","source_uuid":"s"}}`,
			cutRecord{uuid: "q", parent: "r", typ: "attachment", sourceUUID: "s"}, true},
		{`{"type":"user","uuid":"c","parentUuid":"x","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>"}}`,
			cutRecord{uuid: "c", parent: "x", typ: "user", meta: true}, true},
		{`{"type":"user","uuid":"p","parentUuid":"x","isMeta":true,"turnOrigin":"peer","message":{"role":"user","content":"Another Claude session sent a message"}}`,
			cutRecord{uuid: "p", parent: "x", typ: "user", meta: true, origin: "peer"}, true},
		{`{"type":"system","subtype":"compact_boundary","uuid":"b","parentUuid":null,"logicalParentUuid":"t","compactMetadata":{"preservedSegment":{"headUuid":"h","anchorUuid":"s","tailUuid":"t"},"preservedMessages":{"uuids":["h","t"],"allUuids":["h","t"]}}}`,
			cutRecord{uuid: "b", logicalParent: "t", typ: "system", subtype: "compact_boundary", kept: []string{"h", "t", "h", "t"}, keptHead: "h", keptTail: "t"}, true},
	}
	for _, tt := range tests {
		got, ok := parseCutRecord([]byte(tt.line))
		if ok != tt.ok || !cutRecordEqual(got, tt.want) {
			t.Errorf("parseCutRecord(%s) = %+v, %v; want %+v, %v", tt.line, got, ok, tt.want, tt.ok)
		}
	}
}

func cutRecordEqual(a, b cutRecord) bool {
	return a.uuid == b.uuid && a.parent == b.parent && a.logicalParent == b.logicalParent && a.typ == b.typ &&
		a.subtype == b.subtype && a.sidechain == b.sidechain && a.meta == b.meta && a.summary == b.summary && a.origin == b.origin &&
		a.toolResult == b.toolResult && a.interrupt == b.interrupt && a.msgID == b.msgID &&
		slices.Equal(a.toolUses, b.toolUses) && a.sourceUUID == b.sourceUUID && slices.Equal(a.kept, b.kept) &&
		a.keptHead == b.keptHead && a.keptTail == b.keptTail
}

// A compaction whose boundary names only its preserved segment keeps head..tail.
func TestForkCutKeptSegment(t *testing.T) {
	x := newCutIndex([]cutRecord{
		{uuid: "u1", typ: "user"}, {uuid: "a1", parent: "u1", typ: "assistant"},
		{uuid: "u2", parent: "a1", typ: "user"}, {uuid: "a2", parent: "u2", typ: "assistant"},
		{uuid: "b", typ: "system", subtype: "compact_boundary", logicalParent: "a2", keptHead: "u2", keptTail: "a2"},
		{uuid: "u3", parent: "b", typ: "user"},
	})
	for uuid, want := range map[string]bool{"u1": false, "a1": false, "u2": true, "a2": true, "u3": true, "b": true, "nope": false} {
		if got := x.loads(uuid); got != want {
			t.Errorf("loads(%s) = %v; want %v", uuid, got, want)
		}
	}
}

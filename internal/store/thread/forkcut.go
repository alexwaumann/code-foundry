package thread

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Forking from a turn (docs/notes/fork-from-turn.md). `thread fork --at <turn end>`
// starts a fork whose conversation is the parent's up to and including that turn:
// claude --resume <parent> --fork-session --resume-session-at <uuid>, which keeps the
// loaded transcript up to and including the record <uuid> (claude.go). The daemon does
// not store a turn's last record (a turn end item is turn-<result uuid>, and a result
// is not a transcript record), so the cut is worked out at fork time from the items and
// the transcript, all before anything is spawned: Claude refuses an unknown uuid only
// once it runs ("No message found with message.uuid of: …", exit 1).
//
// The rule: the cut is the parent of the record that opens the next turn. The next
// turn's opening is found from the items after the turn end, in timeline order: a
// user message is its own record (the daemon sends it with its item id as the uuid; a
// message Claude read mid-turn is a queued_command attachment whose source_uuid is the
// id); a turn Claude opened itself (a background task's notification) has no user
// message item, so its first reply's record is found by message id and the opening
// record is the user record before it. With nothing after the turn end in the items,
// the transcript after the turn's own records is searched for an opening record
// (a background agent's report Claude has not answered yet); with none there either,
// the turn ends the conversation and the fork takes all of it (no flag).
//
// A turn's opening record is a user record with a turnOrigin (Claude Code marks the
// first record of each model turn: "sdk", "task_notification", "peer"); a local
// command's (/compact, /cost) has none, so any top-level user record that is not a tool
// result, an interrupt marker or meta counts too. Stepping back from it skips what
// belongs to it: meta records that open nothing (a local command's caveat, a subagent's
// reminder before its hand-back), and a compaction's summary and boundary (a /compact
// opens the next turn), whose logicalParentUuid is the record before the compaction.
//
// Then the cut must be one Claude loads: in the current transcript (not before a
// /clear or a reseed, which start another session), and after the last compaction
// boundary or in that compaction's kept tail (compactMetadata.preservedMessages, or
// preservedSegment head..tail): a cut before it is refused by Claude the same way as an
// unknown uuid. Verified against Claude Code 2.1.325; the fixtures in
// testdata/forkcut are cut from real transcripts of it.

// cutRecord is what the cut needs of one transcript record (a line with a uuid).
type cutRecord struct {
	uuid, parent, logicalParent string
	typ, subtype                string
	sidechain, meta, summary    bool
	// origin is turnOrigin, set on the record that opens a turn of the model ("sdk": a
	// message; "task_notification", "peer": one Claude delivers itself, a meta record
	// when it is a subagent's hand-back). Not on a local command's records.
	origin string
	// toolResult: a user record carrying a tool_result; interrupt: Claude's
	// "[Request interrupted by user…]" marker, the end of an interrupted turn.
	toolResult, interrupt bool
	// msgID is an assistant record's message id; toolUses its tool_use ids.
	msgID    string
	toolUses []string
	// sourceUUID is a queued_command attachment's message (our item id).
	sourceUUID string
	// kept is a compaction boundary's kept tail.
	kept []string
	// keptHead, keptTail: the boundary's preservedSegment, when it lists no uuids.
	keptHead, keptTail string
}

// opens reports whether r opens a turn: a top-level user record with a turnOrigin, or
// (a transcript older than turnOrigin) one that is not a tool result, a meta record, a
// compaction summary or an interrupt marker.
func (r cutRecord) opens() bool {
	if r.typ != "user" || r.sidechain {
		return false
	}
	return r.origin != "" || !r.toolResult && !r.meta && !r.summary && !r.interrupt
}

// preamble reports whether r is a record written before a turn's opening that belongs
// to it: a meta record that opens nothing (a local command's caveat, a subagent's
// tools reminder before its hand-back) or a compaction summary.
func (r cutRecord) preamble() bool {
	return r.typ == "user" && r.origin == "" && (r.meta || r.summary)
}

func (r cutRecord) boundary() bool { return r.typ == "system" && r.subtype == "compact_boundary" }

// cutLine is the JSON of a transcript line, as far as the cut reads it.
type cutLine struct {
	UUID              string  `json:"uuid"`
	ParentUUID        *string `json:"parentUuid"`
	LogicalParentUUID string  `json:"logicalParentUuid"`
	Type              string  `json:"type"`
	Subtype           string  `json:"subtype"`
	IsSidechain       bool    `json:"isSidechain"`
	IsMeta            bool    `json:"isMeta"`
	IsCompactSummary  bool    `json:"isCompactSummary"`
	TurnOrigin        string  `json:"turnOrigin"`
	CompactMetadata   *struct {
		PreservedSegment *struct {
			HeadUUID string `json:"headUuid"`
			TailUUID string `json:"tailUuid"`
		} `json:"preservedSegment"`
		PreservedMessages *struct {
			UUIDs    []string `json:"uuids"`
			AllUUIDs []string `json:"allUuids"`
		} `json:"preservedMessages"`
	} `json:"compactMetadata"`
	Attachment *struct {
		Type       string `json:"type"`
		SourceUUID string `json:"source_uuid"`
	} `json:"attachment"`
	Message *struct {
		ID      string          `json:"id"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// interruptPrefix starts Claude's marker of an interrupted turn ("[Request interrupted
// by user]", "… for tool use]").
const interruptPrefix = "[Request interrupted by user"

// parseCutRecord reads one transcript line; false for a line without a uuid (Claude's
// bookkeeping: queue operations, titles, cost state) or one that is not JSON.
func parseCutRecord(line []byte) (cutRecord, bool) {
	if !bytes.Contains(line, []byte(`"uuid"`)) {
		return cutRecord{}, false
	}
	var l cutLine
	if json.Unmarshal(line, &l) != nil || l.UUID == "" {
		return cutRecord{}, false
	}
	r := cutRecord{
		uuid: l.UUID, logicalParent: l.LogicalParentUUID, typ: l.Type, subtype: l.Subtype,
		sidechain: l.IsSidechain, meta: l.IsMeta, summary: l.IsCompactSummary, origin: l.TurnOrigin,
	}
	if l.ParentUUID != nil {
		r.parent = *l.ParentUUID
	}
	if a := l.Attachment; a != nil && a.Type == "queued_command" {
		r.sourceUUID = a.SourceUUID
	}
	if cm := l.CompactMetadata; cm != nil {
		if pm := cm.PreservedMessages; pm != nil {
			r.kept = append(append(r.kept, pm.AllUUIDs...), pm.UUIDs...)
		}
		if ps := cm.PreservedSegment; ps != nil {
			r.keptHead, r.keptTail = ps.HeadUUID, ps.TailUUID
		}
	}
	if m := l.Message; m != nil {
		if l.Type == "assistant" {
			r.msgID = m.ID
		}
		var text string
		if json.Unmarshal(m.Content, &text) != nil {
			var blocks []struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Text string `json:"text"`
			}
			_ = json.Unmarshal(m.Content, &blocks)
			for i, b := range blocks {
				switch b.Type {
				case "tool_use":
					r.toolUses = append(r.toolUses, b.ID)
				case "tool_result":
					r.toolResult = true
				case "text":
					if i == 0 {
						text = b.Text
					}
				}
			}
		}
		r.interrupt = l.Type == "user" && strings.HasPrefix(text, interruptPrefix)
	}
	return r, true
}

// readCutRecords reads a transcript's records in file order. Lines over maxLineBytes
// are skipped, as everywhere the daemon reads a transcript.
func readCutRecords(r io.Reader) ([]cutRecord, error) {
	var recs []cutRecord
	err := claudestream.ReadLines(r, maxLineBytes, func(line []byte) {
		if rec, ok := parseCutRecord(line); ok {
			recs = append(recs, rec)
		}
	})
	return recs, err
}

// forkTurn is the turn a fork starts from (forkAt).
type forkTurn struct {
	// end is the turn end's index in the items.
	end int
	// n is the turn's number among the thread's top-level turn ends (from 1), of total.
	n, total int
}

// forkAt finds the turn end at names in items (timeline order): its id, or "#N" (its
// ordinal, as thread items prints it). busy: the thread is working; an item of the turn
// it works on is "still running", not a wrong id.
func forkAt(items []Item, at string, busy bool) (forkTurn, error) {
	idx := -1
	for i := range items {
		if items[i].ID == at {
			idx = i
			break
		}
	}
	if idx < 0 {
		if n, err := strconv.ParseInt(strings.TrimPrefix(at, "#"), 10, 64); err == nil && strings.HasPrefix(at, "#") {
			for i := range items {
				if items[i].Ordinal == n {
					idx = i
					break
				}
			}
		}
	}
	if idx < 0 {
		return forkTurn{}, fmt.Errorf("%w: the thread has no item %s (give a turn end's item id, or its #ordinal from thread items)", ErrInvalidArgument, at)
	}
	var t forkTurn
	lastEnd := -1
	for i := range items {
		if isTopTurnEnd(items[i]) {
			t.total++
			lastEnd = i
			if i <= idx {
				t.n = t.total
			}
		}
	}
	it := items[idx]
	if !isTopTurnEnd(it) {
		if busy && idx > lastEnd && it.ParentToolUseID == "" {
			return forkTurn{}, fmt.Errorf("%w: #%d is in the turn that is still running: fork from its turn end once it finishes", ErrFailedPrecondition, it.Ordinal)
		}
		return forkTurn{}, fmt.Errorf("%w: #%d (%s) is not a turn end: --at takes the turn end of a finished turn (a \"turn end\" line of thread items)", ErrInvalidArgument, it.Ordinal, strings.ReplaceAll(string(it.Kind), "_", " "))
	}
	t.end = idx
	return t, nil
}

func isTopTurnEnd(it Item) bool { return it.Kind == KindTurnEnd && it.ParentToolUseID == "" }

// conversational reports whether it is a top-level item Claude's transcript has a
// record for: a message Claude read, a reply, thinking or a tool call.
func conversational(it Item) bool {
	if it.ParentToolUseID != "" {
		return false
	}
	switch it.Kind {
	case KindUserMessage:
		return !it.Queued && !it.Unsent
	case KindAssistantText, KindThinking, KindToolCall:
		return true
	}
	return false
}

// cutIndex indexes a transcript's records for the cut.
type cutIndex struct {
	recs                            []cutRecord
	byUUID, bySource, byMsg, byTool map[string]int
	// lastBoundary is the index of the last compaction boundary, -1 for none.
	lastBoundary int
}

func newCutIndex(recs []cutRecord) cutIndex {
	x := cutIndex{
		recs: recs, byUUID: map[string]int{}, bySource: map[string]int{}, byMsg: map[string]int{}, byTool: map[string]int{},
		lastBoundary: -1,
	}
	for i, r := range recs {
		x.byUUID[r.uuid] = i
		if r.sidechain {
			continue
		}
		if r.sourceUUID != "" {
			x.bySource[r.sourceUUID] = i
		}
		if _, ok := x.byMsg[r.msgID]; r.msgID != "" && !ok {
			x.byMsg[r.msgID] = i
		}
		for _, id := range r.toolUses {
			x.byTool[id] = i
		}
		if r.boundary() {
			x.lastBoundary = i
		}
	}
	return x
}

// find is the index of it's record: a message's own record (or the attachment that
// delivered it mid-turn), a reply's or thinking's first record (by message id, the
// item id up to its "/<block>"), a tool call's tool_use. False when it has none here.
func (x cutIndex) find(it Item) (int, bool) {
	switch it.Kind {
	case KindUserMessage:
		if i, ok := x.byUUID[it.ID]; ok && x.recs[i].typ == "user" {
			return i, true
		}
		i, ok := x.bySource[it.ID]
		return i, ok
	case KindAssistantText, KindThinking:
		if j := strings.LastIndexByte(it.ID, '/'); j > 0 {
			if i, ok := x.byMsg[it.ID[:j]]; ok {
				return i, true
			}
		}
		// A local command's output is its record's uuid.
		i, ok := x.byUUID[it.ID]
		return i, ok
	case KindToolCall:
		i, ok := x.byTool[it.ID]
		return i, ok
	}
	return 0, false
}

// cutBefore is the cut for a turn whose next turn opens at record i: the record before
// it, stepping back over the opening's own records (a command's caveat; a /compact's
// summary and boundary, which lead to the record before the compaction). "" when the
// opening starts the transcript.
func (x cutIndex) cutBefore(i int) string {
	p := x.recs[i].parent
	for p != "" {
		j, ok := x.byUUID[p]
		if !ok {
			return p
		}
		r := x.recs[j]
		switch {
		case r.boundary():
			return r.logicalParent
		case r.preamble():
			p = r.parent
		default:
			return p
		}
	}
	return ""
}

// openingBefore walks back from record i (the first reply of a turn Claude opened)
// to the record that opened the turn; stops at stop (the turn before's last record)
// and returns -1 when the chain leaves the transcript.
func (x cutIndex) openingBefore(i, stop int) int {
	for {
		if x.recs[i].opens() || i <= stop {
			return i
		}
		j, ok := x.byUUID[x.recs[i].parent]
		if !ok {
			return -1
		}
		i = j
	}
}

// loads reports whether Claude keeps record uuid when it resumes the transcript: after
// the last compaction boundary, or in its kept tail.
func (x cutIndex) loads(uuid string) bool {
	i, ok := x.byUUID[uuid]
	if !ok {
		return false
	}
	b := x.lastBoundary
	if b < 0 || i >= b {
		return true
	}
	br := x.recs[b]
	if len(br.kept) > 0 {
		for _, k := range br.kept {
			if k == uuid {
				return true
			}
		}
		return false
	}
	h, okH := x.byUUID[br.keptHead]
	t, okT := x.byUUID[br.keptTail]
	return okH && okT && h <= i && i <= t
}

// forkCut is the --resume-session-at uuid that ends a fork's conversation with turn t
// of items (forkAt), from the parent's current transcript records (file order); "" when
// the turn ends the conversation and the whole of it is the fork's. busy: the thread is
// working, so a turn with nothing after it is not the end yet. Refusals are
// ErrFailedPrecondition and say why.
func forkCut(items []Item, t forkTurn, recs []cutRecord, busy bool) (string, error) {
	x := newCutIndex(recs)
	name := "turn " + strconv.Itoa(t.n)
	notHere := fmt.Errorf("%w: %s is not in the thread's current Claude conversation (it came before a /clear or a reseed started a new one), so a fork cannot start from it", ErrFailedPrecondition, name)
	noOpening := fmt.Errorf("%w: the start of the turn after %s is not in Claude's transcript yet, so where %s ends cannot be told; try again in a moment", ErrFailedPrecondition, name, name)

	// The turn's own records: its last one, -1 when it has none in this transcript.
	last := -1
	for i := t.end - 1; i >= 0 && !isTopTurnEnd(items[i]); i-- {
		if !conversational(items[i]) {
			continue
		}
		if j, ok := x.find(items[i]); ok && j > last {
			last = j
		}
	}
	if last < 0 {
		return "", notHere
	}

	cut, found := "", false
	for _, it := range items[t.end+1:] {
		if !conversational(it) {
			continue
		}
		j, ok := x.find(it)
		if it.Kind == KindUserMessage {
			if !ok {
				return "", noOpening
			}
			cut, found = x.cutBefore(j), true
			break
		}
		if !ok {
			continue // a reply with no record of its own (an API error's text)
		}
		o := x.openingBefore(j, last)
		if o < 0 {
			return "", noOpening
		}
		if o <= last {
			cut = x.recs[o].uuid
		} else {
			cut = x.cutBefore(o)
		}
		found = true
		break
	}
	if !found {
		for i := last + 1; i < len(x.recs); i++ {
			if x.recs[i].opens() {
				cut, found = x.cutBefore(i), true
				break
			}
		}
	}
	if !found {
		if busy {
			return "", noOpening
		}
		return "", nil // the turn ends the conversation
	}
	if cut == "" {
		return "", notHere
	}
	if _, ok := x.byUUID[cut]; !ok {
		return "", notHere
	}
	if !x.loads(cut) {
		return "", fmt.Errorf("%w: the conversation was compacted after %s and Claude keeps only a summary of it, so a fork cannot start from it; fork from a later turn, or fork the whole thread", ErrFailedPrecondition, name)
	}
	return cut, nil
}

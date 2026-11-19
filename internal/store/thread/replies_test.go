package thread

import (
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Reply marks on thread-to-thread messages (replies.go, docs/notes/thread-reply-mark.md).

func TestCheckReply(t *testing.T) {
	tests := []struct {
		name    string
		msg     Message
		wantErr string // "" for none
	}{
		{"the user", Message{Text: "hi"}, ""},
		{"the user, marked", Message{Text: "hi", Reply: ReplyWanted}, ""},
		{"a thread to itself", Message{Text: "hi", ByThreadID: "s-b"}, ""},
		{"a wake", Message{Text: "w", ByThreadID: "s-a", Origin: OriginWake}, ""},
		{"a compact", Message{Text: "/compact", ByThreadID: "s-a", compact: true}, ""},
		{"another thread, wanted", Message{Text: "hi", ByThreadID: "s-a", Reply: ReplyWanted}, ""},
		{"another thread, none", Message{Text: "hi", ByThreadID: " s-a ", Reply: ReplyNone}, ""},
		{"another thread, unmarked", Message{Text: "hi", ByThreadID: "s-a"},
			"thread s-a is sending this to thread s-b, so it needs a reply mark: --reply wanted when you need its answer"},
		{"an unknown mark", Message{Text: "hi", ByThreadID: "s-a", Reply: "maybe"}, `reply "maybe"`},
		{"an unknown mark from the user", Message{Text: "hi", Reply: "maybe"}, `reply "maybe"`},
	}
	for _, tt := range tests {
		err := checkReply("s-b", tt.msg)
		switch {
		case tt.wantErr == "" && err != nil:
			t.Errorf("%s: err = %v", tt.name, err)
		case tt.wantErr != "" && (!errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), tt.wantErr)):
			t.Errorf("%s: err = %v, want InvalidArgument saying %q", tt.name, err, tt.wantErr)
		}
	}
}

// What the receiver is told, by relation and mark.
func TestFromNote(t *testing.T) {
	tests := []struct {
		name  string
		rel   Relation
		reply Reply
		want  string
	}{
		{"lead, none", RelationLead, ReplyNone, "[code-foundry] From your lead. No reply is expected: act on it, and do not confirm receipt or report back when done " +
			"(your lead is not woken for it). Message it only if you need something from it."},
		{"lead, wanted", RelationLead, ReplyWanted, "[code-foundry] From your lead. It is waiting for your answer: give it once, in the last message of the turn that " +
			"handles this, which reaches your lead whole."},
		{"lead, unmarked: its task", RelationLead, "", ""},
		{"worker, none", RelationWorker, ReplyNone, `[code-foundry] From your worker "W" (s-w), not the user: it carries no approval of the user's. ` +
			"No reply is expected: do not confirm receipt or report back when done. Message it only if you need something from it."},
		{"worker, wanted", RelationWorker, ReplyWanted, `[code-foundry] From your worker "W" (s-w), not the user: it carries no approval of the user's. ` +
			`It is waiting for your answer: reply to it once, with the answer, when you have it; answering needs no approval: code-foundry thread send --id s-w --reply none "<answer>".`},
		{"other, none", RelationOther, ReplyNone, `[code-foundry] From thread "W" (s-w), not your lead and not the user: it carries no approval of the user's. ` +
			"No reply is expected: do not confirm receipt or report back when done. Message it only if you need something from it."},
		{"other, wanted", RelationOther, ReplyWanted, `[code-foundry] From thread "W" (s-w), not your lead and not the user: it carries no approval of the user's. ` +
			`It is waiting for your answer: reply to it once, with the answer, when you have it; answering needs no approval: code-foundry thread send --id s-w --reply none "<answer>".`},
		{"other, unmarked", RelationOther, "", `[code-foundry] From thread "W" (s-w), not your lead and not the user: it carries no approval of the user's.`},
	}
	for _, tt := range tests {
		if got := fromNote(tt.rel, `"W" (s-w)`, "s-w", tt.reply); got != tt.want {
			t.Errorf("%s:\n got %q\nwant %q", tt.name, got, tt.want)
		}
	}
}

func TestRelationOf(t *testing.T) {
	lead, worker, other := Thread{ID: "s-l"}, Thread{ID: "s-w", CreatedBy: "s-l"}, Thread{ID: "s-o"}
	tests := []struct {
		name   string
		to, by Thread
		want   Relation
	}{
		{"the lead to its worker", worker, lead, RelationLead},
		{"the worker to its lead", lead, worker, RelationWorker},
		{"a stranger to the worker", worker, other, RelationOther},
		{"the worker to a stranger", other, worker, RelationOther},
		{"two threads nobody created", lead, other, RelationOther},
	}
	for _, tt := range tests {
		if got := relationOf(tt.to, tt.by); got != tt.want {
			t.Errorf("%s: %q, want %q", tt.name, got, tt.want)
		}
		if got := relationOf(tt.by, tt.to); got != tt.want.inverse() {
			t.Errorf("%s, the other way: %q, want %q", tt.name, got, tt.want.inverse())
		}
	}
}

func TestSentText(t *testing.T) {
	at := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	base := SentMessage{ToThreadID: "s-b", ToName: "Docs", Relation: RelationOther, Reply: ReplyWanted}
	with := func(f func(*SentMessage)) SentMessage { s := base; f(&s); return s }
	tests := []struct {
		s    SentMessage
		want string
	}{
		{base, `Asked "Docs" (s-b) · waiting for a reply`},
		{with(func(s *SentMessage) { s.RepliedAt = at }), `Asked "Docs" (s-b) · replied`},
		{with(func(s *SentMessage) { s.Unanswered = UnansweredTurnEnded }), `Asked "Docs" (s-b) · no answer yet: it ended its turn`},
		{with(func(s *SentMessage) { s.Unanswered = UnansweredArchived }), `Asked "Docs" (s-b) · no answer: it was archived`},
		{with(func(s *SentMessage) { s.Unanswered = UnansweredRemoved }), `Asked "Docs" (s-b) · no answer: it was removed`},
		{with(func(s *SentMessage) { s.Unanswered, s.RepliedAt = UnansweredTurnEnded, at }), `Asked "Docs" (s-b) · replied`},
		{with(func(s *SentMessage) { s.Reply = ReplyNone }), `Told "Docs" (s-b) · no reply needed`},
		{with(func(s *SentMessage) { s.Reply, s.Relation = ReplyNone, RelationLead }), `Told your lead "Docs" (s-b) · no reply needed`},
		{with(func(s *SentMessage) { s.ToName = "" }), `Asked s-b · waiting for a reply`},
	}
	for _, tt := range tests {
		if got := sentText(tt.s); got != tt.want {
			t.Errorf("%+v: %q, want %q", tt.s, got, tt.want)
		}
	}
}

// sentNotes are the notes recording messages thread id sent.
func sentNotes(items []Item) []Item {
	var out []Item
	for _, it := range items {
		if it.Kind == KindNote && it.Sent != nil {
			out = append(out, it)
		}
	}
	return out
}

// replyWaits are id's reply-wait subscriptions.
func (e *env) replyWaits(id string) []Subscription {
	e.t.Helper()
	return slices.DeleteFunc(e.subsOf(id), func(s Subscription) bool { return !s.ReplyWait() })
}

// send sends text to id from thread by with mark reply.
func (e *env) send(by, id, text string, reply Reply) Item {
	e.t.Helper()
	it, err := e.m.Send(e.ctx(), id, Message{Text: text, ByThreadID: by, Reply: reply})
	if err != nil {
		e.t.Fatalf("send %s → %s: %v", by, id, err)
	}
	return it
}

// The mark on the receiver's item, the line it starts with, and the sender's note, for
// each relation. The receiver's turn ends at once (the text-table fake), so a wanted
// reply's wake is checked by the tests below.
func TestReplyMarkOnTheMessage(t *testing.T) {
	type party int
	const (
		lead party = iota
		worker
		other
		user
	)
	tests := []struct {
		name     string
		from, to party
		reply    Reply
		rel      Relation // on the receiver's item
		line     string   // the prompt starts with it; "" for none
		note     string   // the sender's note; "" for none
	}{
		{"a lead tells its worker", lead, worker, ReplyNone, RelationLead, "[code-foundry] From your lead. No reply is expected", ""},
		{"a lead asks its worker", lead, worker, ReplyWanted, RelationLead, "[code-foundry] From your lead. It is waiting for your answer", ""},
		{"a worker tells its lead", worker, lead, ReplyNone, RelationWorker, `[code-foundry] From your worker "worker"`, `Told your lead "lead"`},
		{"a worker asks its lead", worker, lead, ReplyWanted, RelationWorker, `[code-foundry] From your worker "worker"`, `Asked your lead "lead"`},
		{"another thread tells", other, lead, ReplyNone, RelationOther, `[code-foundry] From thread "other"`, `Told "lead"`},
		{"another thread asks", other, worker, ReplyWanted, RelationOther, `[code-foundry] From thread "other"`, `Asked "worker"`},
		{"the user", user, lead, "", "", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			f := e.family()
			threads := map[party]Thread{lead: f.lead, worker: f.worker, other: f.other}
			by := threads[tt.from].ID
			to := threads[tt.to]
			text := "the message"
			it, err := e.m.Send(e.ctx(), to.ID, Message{Text: text, ByThreadID: by, Reply: tt.reply})
			if err != nil {
				t.Fatal(err)
			}
			if it.SentBy != by || it.SenderRelation != tt.rel || it.Reply != tt.reply {
				t.Errorf("item sent by %q (%q), reply %q; want %q (%q), %q", it.SentBy, it.SenderRelation, it.Reply, by, tt.rel, tt.reply)
			}
			got := ""
			e.waitSent("the message", func(m map[string]any) bool {
				got = userTextOf(m)
				return strings.HasSuffix(got, text)
			})
			switch {
			case tt.line == "" && got != text:
				t.Errorf("prompt = %q, want the text alone", got)
			case tt.line != "" && (!strings.HasPrefix(got, tt.line) || !strings.HasSuffix(got, "\n\n"+text)):
				t.Errorf("prompt = %q, want it to start with %q", got, tt.line)
			}
			if by == "" {
				return
			}
			notes := sentNotes(e.items(by).Items)
			if tt.note == "" {
				if len(notes) != 0 {
					t.Errorf("sender's notes = %+v, want none", notes)
				}
			} else {
				if len(notes) != 1 || !strings.HasPrefix(notes[0].Text, tt.note) {
					t.Fatalf("sender's notes = %+v, want one %q", notes, tt.note)
				}
				s := notes[0].Sent
				if s.ToThreadID != to.ID || s.Reply != tt.reply || s.ItemID != it.ID || s.Ordinal != it.Ordinal || s.Relation != tt.rel.inverse() {
					t.Errorf("sent = %+v", s)
				}
			}
			// The marks survive a restart (items_db).
			e.restart()
			stored := e.items(to.ID).Items
			i := slices.IndexFunc(stored, func(x Item) bool { return x.ID == it.ID })
			if i < 0 || stored[i].SentBy != by || stored[i].SenderRelation != tt.rel || stored[i].Reply != tt.reply {
				t.Errorf("stored item = %+v", stored)
			}
			if tt.note != "" {
				if n := sentNotes(e.items(by).Items); len(n) != 1 || n[0].Sent == nil || n[0].Sent.ItemID != it.ID {
					t.Errorf("stored notes = %+v", n)
				}
			}
		})
	}
}

// A message from another thread without a mark is refused before anything is written.
func TestReplyMarkRequired(t *testing.T) {
	e := newEnv(t)
	f := e.family()
	_, err := e.m.Send(e.ctx(), f.worker.ID, Message{Text: "hi", ByThreadID: f.lead.ID})
	if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "--reply none for an instruction, a hand-off or information") {
		t.Fatalf("err = %v", err)
	}
	if items := e.items(f.worker.ID).Items; slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindUserMessage }) {
		t.Errorf("items = %+v", items)
	}
	if s, _ := e.m.Snapshot().Thread(f.worker.ID); s.State != StateDisconnected {
		t.Errorf("state = %v: the refused message started it", s.State)
	}
}

// A wanted reply between threads that are not lead and worker: the turn that read the
// message ends without an answer, so the sender is woken with its last message and told
// so; a later answer still lands as replied.
func TestReplyWantedTurnEndsWithoutAnswer(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.WakeBatch = -1 })
	f := e.family()
	ask := e.send(f.other.ID, f.lead.ID, "Which port?", ReplyWanted)
	items := e.waitItems(f.other.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	for _, want := range []string{"It ended the turn that read your message without answering you", "Your note: waiting for its answer to your message #",
		"It said (its words"} {
		if !strings.Contains(w.Text, want) {
			t.Errorf("wake lacks %q:\n%s", want, w.Text)
		}
	}
	if !strings.Contains(w.WakeJSON, `"condition": "idle"`) || !strings.Contains(w.WakeJSON, `"note": "waiting for its answer to your message #`+itoa(ask.Ordinal)+`"`) {
		t.Errorf("wake json = %s", w.WakeJSON)
	}
	if subs := e.replyWaits(f.other.ID); len(subs) != 0 {
		t.Errorf("reply-waits after the wake = %+v", subs)
	}
	e.waitItems(f.other.ID, "the note says no answer yet", func(items []Item) bool {
		n := sentNotes(items)
		return len(n) == 1 && n[0].Sent.Unanswered == UnansweredTurnEnded && strings.HasSuffix(n[0].Text, "no answer yet: it ended its turn")
	})
	// It answers later: the answer is a message (no wake), and the note says replied.
	answer := e.send(f.lead.ID, f.other.ID, "8080", ReplyNone)
	if answer.SenderRelation != RelationOther || answer.Reply != ReplyNone {
		t.Errorf("answer = %+v", answer)
	}
	items = e.waitItems(f.other.ID, "the note says replied", func(items []Item) bool {
		n := sentNotes(items)
		return len(n) == 1 && !n[0].Sent.RepliedAt.IsZero()
	})
	n := sentNotes(items)[0]
	if n.Sent.ReplyItemID != answer.ID || n.Sent.Unanswered != "" || n.Sent.ItemID != ask.ID || !strings.HasSuffix(n.Text, "· replied") {
		t.Errorf("note = %q %+v", n.Text, n.Sent)
	}
	time.Sleep(50 * time.Millisecond)
	if got := len(wakes(e.items(f.other.ID).Items)); got != 1 {
		t.Errorf("%d wakes, want 1", got)
	}
}

// An answer that comes while the turn that read the question still runs: the reply-wait
// goes with it, so the turn's end wakes nobody; the note says replied. The receiver may
// ask something of its own back while the sender waits on it: two reply-waits that face
// each other are no loop.
func TestReplyWantedAnswered(t *testing.T) {
	e := newFixtureEnvAt(t, fixturePath("text-table"), stalled)
	f := e.family()
	ask := e.send(f.other.ID, f.lead.ID, "Which port?", ReplyWanted)
	waits := e.replyWaits(f.other.ID)
	if len(waits) != 1 || waits[0].TargetID != f.lead.ID || waits[0].Condition != CondIdle || waits[0].Repeat ||
		waits[0].Args[replyArg] != string(RelationOther) || waits[0].Note != "waiting for its answer to your message #"+itoa(ask.Ordinal) {
		t.Fatalf("reply-waits = %+v", waits)
	}
	// The lead asks back before it answers: its own reply-wait, despite the sender's.
	back := e.send(f.lead.ID, f.other.ID, "8080 or 9090? I need to know which you mean.", ReplyWanted)
	if w := e.replyWaits(f.lead.ID); len(w) != 1 || w[0].TargetID != f.other.ID {
		t.Fatalf("the lead's reply-waits = %+v", w)
	}
	// That message was the lead's next to the sender: it answered the question.
	if w := e.replyWaits(f.other.ID); len(w) != 0 {
		t.Errorf("the sender's reply-waits = %+v", w)
	}
	items := e.waitItems(f.other.ID, "the note says replied", func(items []Item) bool {
		n := sentNotes(items)
		return slices.ContainsFunc(n, func(it Item) bool { return it.Sent.ToThreadID == f.lead.ID && !it.Sent.RepliedAt.IsZero() })
	})
	i := slices.IndexFunc(items, func(it Item) bool { return it.Sent != nil && it.Sent.ItemID == ask.ID })
	if i < 0 || items[i].Sent.ReplyItemID != back.ID {
		t.Errorf("notes = %+v", sentNotes(items))
	}
	if got := wakes(items); len(got) != 0 {
		t.Errorf("wakes = %+v", got)
	}
	// The answer is in the sender's timeline as the lead's message.
	j := slices.IndexFunc(items, func(it Item) bool { return it.ID == back.ID })
	if j < 0 || items[j].SentBy != f.lead.ID || items[j].SenderRelation != RelationOther || items[j].Reply != ReplyWanted {
		t.Errorf("answer item = %+v", items)
	}
}

// No answer will come: the receiver is archived (by the user, or by the waiting thread
// itself, which needs no wake for its own act) or removed.
func TestReplyWantedUnanswerable(t *testing.T) {
	tests := []struct {
		name     string
		end      func(e *env, f family)
		why      string
		wantWake string // "" for none
	}{
		{"archived by the user", func(e *env, f family) { e.archive(f.lead.ID) }, UnansweredArchived,
			"was archived before it answered your message, so no answer will come"},
		{"archived by the waiting thread", func(e *env, f family) {
			if _, err := e.m.Archive(AskedBy(e.ctx(), f.other.ID), f.lead.ID, true); err != nil {
				e.t.Fatal(err)
			}
		}, UnansweredArchived, ""},
		{"removed", func(e *env, f family) {
			if err := e.m.Remove(e.ctx(), f.lead.ID); err != nil {
				e.t.Fatal(err)
			}
		}, UnansweredRemoved, "was removed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, fixturePath("text-table"), stalled)
			f := e.family()
			e.send(f.other.ID, f.lead.ID, "Which port?", ReplyWanted)
			if len(e.replyWaits(f.other.ID)) != 1 {
				t.Fatal("no reply-wait")
			}
			tt.end(e, f)
			e.waitItems(f.other.ID, "the note says why", func(items []Item) bool {
				n := sentNotes(items)
				return len(n) == 1 && n[0].Sent.Unanswered == tt.why
			})
			if tt.wantWake == "" {
				time.Sleep(100 * time.Millisecond)
				if w := wakes(e.items(f.other.ID).Items); len(w) != 0 {
					t.Errorf("wakes = %+v", w)
				}
			} else {
				items := e.waitItems(f.other.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
				w := wakes(items)[0]
				if !strings.Contains(w.WakeTitle, tt.wantWake) {
					t.Errorf("wake = %q", w.WakeTitle)
				}
			}
			if subs := e.subsOf(f.other.ID); len(subs) != 0 {
				t.Errorf("subscriptions = %+v", subs)
			}
		})
	}
}

// A lead's own worker answers in the last message of its turn, which the lead's --notify
// wake brings: a wanted reply adds no reply-wait to it. Without such a subscription the
// reply-wait brings that last message. A message with no reply wanted renews no
// --notify subscription.
func TestReplyToOwnWorker(t *testing.T) {
	t.Run("with notify", func(t *testing.T) {
		n := newNotifyEnv(t)
		n.setStep(n.child.ID, step{StateDisconnected, StatusNeedsAttention, "finished", ""})
		n.waitItems(n.parent.ID, "the finish's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		n.send(n.parent.ID, n.child.ID, "Which file did you change?", ReplyWanted)
		items := n.waitItems(n.parent.ID, "the answer's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
		if strings.Contains(wakes(items)[1].Text, "It handled your message") {
			t.Errorf("the notify wake carries a reply-wait's sentence: %s", wakes(items)[1].Text)
		}
		if len(n.replyWaits(n.parent.ID)) != 0 || len(sentNotes(items)) != 0 {
			t.Errorf("reply-waits %+v, notes %+v", n.replyWaits(n.parent.ID), sentNotes(items))
		}
		time.Sleep(50 * time.Millisecond)
		if got := len(wakes(n.items(n.parent.ID).Items)); got != 2 {
			t.Errorf("%d wakes, want 2", got)
		}
	})
	// The worker's turn can end before Send's bookkeeping runs (a short turn): the renewed
	// notify subscription then fires at once and ends. That one wake is the answer; a
	// reply-wait on top would wake the lead a second time for the same turn's end. Driven
	// by hand (afterSend after the turn ended) so the order is fixed; a fire queues its
	// wake before afterSend returns, so the drained queue holds every wake there is.
	t.Run("turn over before the bookkeeping", func(t *testing.T) {
		n := newNotifyEnv(t)
		n.setStep(n.child.ID, finished)
		n.waitItems(n.parent.ID, "the finish's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		n.setStep(n.child.ID, busy)
		n.m.update(n.child.ID, false, func(rec *record) { rec.s.HandledThrough = 5 })
		n.setStep(n.child.ID, finished)
		n.m.afterSend(n.ctx(), n.child.ID, Message{Text: "Which file did you change?", ByThreadID: n.parent.ID, Reply: ReplyWanted},
			Item{ID: "i-5", Ordinal: 5})
		n.waitDrained(n.parent.ID)
		items := n.items(n.parent.ID).Items
		if got := len(wakes(items)); got != 2 {
			t.Fatalf("%d wakes, want 2:\n%s", got, describeItems(items))
		}
		if strings.Contains(wakes(items)[1].WakeTitle, "It handled your message") {
			t.Errorf("the answer's wake is a reply-wait's: %s", wakes(items)[1].WakeTitle)
		}
		if subs := n.subsOf(n.parent.ID); len(subs) != 0 {
			t.Errorf("subscriptions = %+v", subs)
		}
	})
	t.Run("none renews no notify", func(t *testing.T) {
		n := newNotifyEnv(t)
		n.setStep(n.child.ID, step{StateDisconnected, StatusNeedsAttention, "finished", ""})
		n.waitItems(n.parent.ID, "the finish's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		it := n.send(n.parent.ID, n.child.ID, "FYI: the base moved.", ReplyNone)
		n.waitFor(n.child.ID, "its turn ended", func(s Thread) bool { return s.HandledThrough >= it.Ordinal && Meets(CondSettled, s) })
		time.Sleep(100 * time.Millisecond)
		if got := len(wakes(n.items(n.parent.ID).Items)); got != 1 {
			t.Errorf("%d wakes, want 1", got)
		}
		if subs := n.subsOf(n.parent.ID); len(subs) != 0 {
			t.Errorf("subscriptions = %+v", subs)
		}
	})
	t.Run("without notify", func(t *testing.T) {
		e := newEnv(t, func(o *Options) { o.WakeBatch = -1 })
		f := e.family()
		e.send(f.lead.ID, f.worker.ID, "Which file did you change?", ReplyWanted)
		items := e.waitItems(f.lead.ID, "the answer's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		if w := wakes(items)[0]; !strings.Contains(w.WakeTitle, "It handled your message: its answer is its last message, below.") {
			t.Errorf("wake = %q", w.WakeTitle)
		}
		if len(sentNotes(items)) != 0 || len(e.replyWaits(f.lead.ID)) != 0 {
			t.Errorf("notes %+v, reply-waits %+v", sentNotes(items), e.replyWaits(f.lead.ID))
		}
	})
}

// NoNotify (thread send --wait, --notify=false) sets up no wake for a wanted reply: the
// sender waits itself.
func TestReplyWantedNoNotify(t *testing.T) {
	e := newFixtureEnvAt(t, fixturePath("text-table"), stalled)
	f := e.family()
	if _, err := e.m.Send(e.ctx(), f.lead.ID, Message{Text: "Which port?", ByThreadID: f.other.ID, Reply: ReplyWanted, NoNotify: true}); err != nil {
		t.Fatal(err)
	}
	if subs := e.subsOf(f.other.ID); len(subs) != 0 {
		t.Errorf("subscriptions = %+v", subs)
	}
	if n := sentNotes(e.items(f.other.ID).Items); len(n) != 1 || !strings.HasSuffix(n[0].Text, "waiting for a reply") {
		t.Errorf("notes = %+v", n)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

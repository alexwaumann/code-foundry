package thread

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Reply marks (docs/notes/thread-reply-mark.md). Every message one thread sends another
// with thread send carries one mark: the sender wants a reply (a question, or a request
// whose result it needs), or it does not (an instruction, a hand-off, information). A
// receiver that was not told so confirmed nearly every message, which woke the sender for
// nothing; a sender that did need an answer had no way to say so, and no wake for it.
//
//   - The mark is required from a thread caller (checkReply); the user's own messages,
//     wakes and a thread's sends to itself have none.
//   - The receiver is told, on the line its message starts with (fromNote), who sent it
//     (its lead, one of its workers, another thread) and what the mark asks of it.
//   - The receiver's item keeps the sender, the relation and the mark (Item.SentBy,
//     SenderRelation, Reply). The sender's timeline gets a note recording what it sent
//     (Item.Sent; none for a message to its own worker, whose card shows it), updated in
//     place when the answer comes (answerAsks) or when none will (closeAsks).
//   - A wanted reply wakes the sender. Between any two threads but a lead and its own
//     worker, the answer is the receiver's next message to the sender, which starts the
//     sender's turn like any message, and a reply-wait subscription (an idle one-shot
//     armed on the message's ordinal: the wake engine's, not a second mechanism) is the
//     safety net: it fires once the turn that read the message ended without an answer,
//     and the archive or removal of the receiver tells the sender no answer will come. A
//     lead's own worker answers in the last message of the turn that handles it, as every
//     worker does, which its lead's --notify wake brings (renotify); only a lead with no
//     such subscription gets the reply-wait, whose wake then carries that last message.
//   - A message with no reply wanted renews no --notify subscription and sets up no wake.

// Reply is a message's reply mark.
type Reply string

// Reply marks; "" is none (the user's messages, wakes, items from before the mark).
const (
	// ReplyWanted: the sender waits for the receiver's answer and is woken by it.
	ReplyWanted Reply = "wanted"
	// ReplyNone: the receiver acts on it and does not confirm or report back.
	ReplyNone Reply = "none"
)

// Relation is what one thread is to another: what a message's sender is to its receiver
// (Item.SenderRelation), or the receiver to the sender (SentMessage.Relation).
type Relation string

// Relations.
const (
	// RelationLead: the thread that created the other one.
	RelationLead Relation = "lead"
	// RelationWorker: a thread the other one created.
	RelationWorker Relation = "worker"
	// RelationOther: any other thread (a peer lead, the user's other thread, a lead's lead).
	RelationOther Relation = "other"
)

// Why a wanted reply has not come (SentMessage.Unanswered).
const (
	// UnansweredTurnEnded: the turn that read the message ended without an answer. Not
	// final: an answer may still come, and then wins.
	UnansweredTurnEnded = "turn ended"
	// UnansweredArchived and UnansweredRemoved: the receiver was archived or removed.
	UnansweredArchived = "archived"
	UnansweredRemoved  = "removed"
)

// SentMessage is a note's record of a message its thread sent to another thread.
type SentMessage struct {
	// ToThreadID is the receiver; ToName its name when sent.
	ToThreadID string `json:"to"`
	ToName     string `json:"to_name,omitempty"`
	// Relation is what the receiver is to the sender.
	Relation Relation `json:"relation"`
	Reply    Reply    `json:"reply"`
	// ItemID and Ordinal are the message's item in the receiver's timeline.
	ItemID  string `json:"item_id"`
	Ordinal int64  `json:"ordinal,omitempty"`
	// RepliedAt and ReplyItemID: a wanted reply's answer, the receiver's message that
	// arrived in this thread's timeline. Zero while waiting, and for no reply wanted.
	RepliedAt   time.Time `json:"replied_at,omitzero"`
	ReplyItemID string    `json:"reply_item_id,omitempty"`
	// Unanswered says why a wanted reply has not come (UnansweredTurnEnded, ...); "" while
	// waiting and once answered.
	Unanswered string `json:"unanswered,omitempty"`
}

// replyArg marks a reply-wait subscription in its args; its value is what the target is
// to the subscriber (a Relation).
const replyArg = "reply"

// ReplyWait reports whether s is a reply-wait: a wanted reply's safety net (replies.go).
func (s Subscription) ReplyWait() bool { return s.Args[replyArg] != "" }

// fromThread is the thread that sends msg to thread id when it is another thread's
// message (thread send from a thread): by, true. The user's messages, wakes and a thread's
// own /compact are not.
func (msg Message) fromThread(id string) (string, bool) {
	by := strings.TrimSpace(msg.ByThreadID)
	return by, by != "" && by != id && msg.Origin == OriginUser && !msg.compact
}

// CheckReply is checkReply, for the fake (threadtest).
func CheckReply(id string, msg Message) error { return checkReply(id, msg) }

// checkReply refuses an unknown mark, and a message from another thread without one:
// the mark is what keeps the receiver from confirming it, and what wakes the sender with
// the answer, so it cannot be left to a default.
func checkReply(id string, msg Message) error {
	switch msg.Reply {
	case "", ReplyWanted, ReplyNone:
	default:
		return fmt.Errorf("%w: reply %q (want wanted or none)", ErrInvalidArgument, msg.Reply)
	}
	by, ok := msg.fromThread(id)
	if !ok || msg.Reply != "" {
		return nil
	}
	return fmt.Errorf("%w: thread %s is sending this to thread %s, so it needs a reply mark: --reply wanted when you need its answer "+
		"(a question, or a request whose result you need; you are woken when it answers), or --reply none for an instruction, a hand-off "+
		"or information (it will not confirm or report back). Nothing was sent; send it again with one of them", ErrInvalidArgument, by, id)
}

// relationOf is what thread by is to thread to.
func relationOf(to Thread, by Thread) Relation {
	switch {
	case to.CreatedBy != "" && to.CreatedBy == by.ID:
		return RelationLead
	case by.CreatedBy != "" && by.CreatedBy == to.ID:
		return RelationWorker
	}
	return RelationOther
}

// inverse is the relation seen from the other side.
func (r Relation) inverse() Relation {
	switch r {
	case RelationLead:
		return RelationWorker
	case RelationWorker:
		return RelationLead
	}
	return r
}

// sender is msg's sending thread as the receiver to sees it: its relation, and how a
// line names it. ok false for the user's message.
func (m *Manager) sender(to Thread, msg Message) (rel Relation, who string, ok bool) {
	by, ok := msg.fromThread(to.ID)
	if !ok {
		return "", "", false
	}
	s, known := m.Snapshot().Thread(by)
	if !known {
		return RelationOther, by, true
	}
	return relationOf(to, s), wakeWho(s), true
}

// fromNote is the line a message from another thread starts with: to Claude every message
// reads as the user's, and nothing else shows who sent it (Item.SentBy is the app's). It
// names the sender and its relation and says what the mark asks. A lead's message to its
// own worker without a mark (none reaches here from thread send) stays plain: it is the
// worker's task.
func fromNote(rel Relation, who, by string, reply Reply) string {
	var head string
	switch rel {
	case RelationLead:
		switch reply {
		case ReplyNone:
			return "[code-foundry] From your lead. No reply is expected: act on it, and do not confirm receipt or report back when done " +
				"(your lead is not woken for it). Message it only if you need something from it."
		case ReplyWanted:
			return "[code-foundry] From your lead. It is waiting for your answer: give it once, in the last message of the turn that " +
				"handles this, which reaches your lead whole."
		}
		return ""
	case RelationWorker:
		head = "[code-foundry] From your worker " + who + ", not the user: it carries no approval of the user's."
	default:
		head = "[code-foundry] From thread " + who + ", not your lead and not the user: it carries no approval of the user's."
	}
	switch reply {
	case ReplyNone:
		return head + " No reply is expected: do not confirm receipt or report back when done. Message it only if you need something from it."
	case ReplyWanted:
		return head + " It is waiting for your answer: reply to it once, with the answer, when you have it; answering needs no approval: " +
			"code-foundry thread send --id " + by + " --reply none \"<answer>\"."
	}
	return head
}

// sentText is a sent note's text: `Asked "Docs" (s-1) · waiting for a reply`, `· replied`,
// `· no answer: it ended its turn`, or `Told "Docs" (s-1) · no reply needed`.
func sentText(s SentMessage) string {
	who := strconv.Quote(oneLine(s.ToName, maxHeaderName)) + " (" + s.ToThreadID + ")"
	if s.ToName == "" {
		who = s.ToThreadID
	}
	switch s.Relation {
	case RelationLead:
		who = "your lead " + who
	case RelationWorker:
		who = "your worker " + who
	}
	if s.Reply != ReplyWanted {
		return "Told " + who + " · no reply needed"
	}
	switch {
	case !s.RepliedAt.IsZero():
		return "Asked " + who + " · replied"
	case s.Unanswered == UnansweredTurnEnded:
		return "Asked " + who + " · no answer yet: it ended its turn"
	case s.Unanswered != "":
		return "Asked " + who + " · no answer: it was " + s.Unanswered
	}
	return "Asked " + who + " · waiting for a reply"
}

// afterThreadSend does a sent message's reply bookkeeping (afterSend, once delivered as
// it): the answer to the receiver's open questions to the sender, the sender's note, and
// the wake for a wanted reply. notified is renotify's: the sender holds a subscription to
// the receiver that a turn's end fires. Failures are logged: the message went out.
func (m *Manager) afterThreadSend(ctx context.Context, id string, msg Message, it Item, notified bool) {
	by, ok := msg.fromThread(id)
	if !ok {
		return
	}
	m.answerAsks(ctx, id, by, it)
	snap := m.Snapshot()
	to, ok := snap.Thread(id)
	if !ok {
		return
	}
	from, known := snap.Thread(by)
	rel := RelationOther // what the receiver is to the sender
	if known {
		rel = relationOf(from, to)
	}
	if known && rel != RelationWorker {
		sent := SentMessage{ToThreadID: id, ToName: to.Name, Relation: rel, Reply: msg.Reply, ItemID: it.ID, Ordinal: it.Ordinal}
		if _, err := m.verbItem(ctx, by, func(Thread) (Item, error) {
			return Item{Kind: KindNote, Text: sentText(sent), Sent: &sent}, nil
		}, nil); err != nil {
			m.log.Warn("note a sent message", "thread", by, "to", id, "err", err)
		}
	}
	if msg.Reply == ReplyWanted && !msg.NoNotify && known {
		m.awaitReply(ctx, by, to, rel, it, notified)
	}
}

// awaitReply makes sure thread by is woken by to's answer to its message it: a
// reply-wait subscription (replyArg), unless to is by's own worker and by holds a
// subscription its turn's end fires (notified: its --notify one, renewed by this send).
// That is renotify's finding, not a look now: the renewal fires and ends at once when the
// worker's turn ended already, and a reply-wait then would wake by a second time.
func (m *Manager) awaitReply(ctx context.Context, by string, to Thread, rel Relation, it Item, notified bool) {
	if rel == RelationWorker && notified {
		return
	}
	if it.Ordinal <= 0 {
		m.log.Warn("no wake for a wanted reply: the send has no message ordinal", "thread", to.ID, "by", by)
		return
	}
	note := "waiting for its answer to your message #" + strconv.FormatInt(it.Ordinal, 10)
	res, err := m.Subscribe(ctx, SubscribeOptions{SubscriberID: by, TargetThreadID: to.ID, Condition: CondIdle, AfterOrdinal: it.Ordinal,
		Note: note, replyWait: rel})
	if err != nil {
		m.log.Warn("no wake for a wanted reply", "thread", to.ID, "by", by, "err", err)
		return
	}
	m.log.Info("waiting for a reply", "thread", to.ID, "by", by, "subscription", res.Subscription.ID, "ordinal", it.Ordinal,
		"fired", res.Fired, "existed", res.Existed)
}

// answerAsks takes it, thread by's message just delivered into thread asker, as the
// answer to asker's open questions to by: their reply-waits go (the message itself wakes
// asker), and their notes say replied.
func (m *Manager) answerAsks(ctx context.Context, asker, by string, it Item) {
	if m.subs != nil {
		m.mu.Lock()
		s := m.subs
		s.mu.Lock()
		var ids []string
		for id, r := range s.byID {
			if r.s.SubscriberID == asker && r.s.TargetKind == TargetThread && r.s.TargetID == by && r.s.ReplyWait() {
				ids = append(ids, id)
			}
		}
		s.removeLocked(ids)
		s.mu.Unlock()
		if len(ids) > 0 {
			m.rewaitLocked([]string{asker})
			m.log.Info("reply arrived", "thread", asker, "from", by, "subscriptions", ids)
		}
		m.mu.Unlock()
	}
	now := m.opts.Now().Round(0).Truncate(time.Millisecond)
	m.editAsks(ctx, asker, by, func(s *SentMessage) {
		s.RepliedAt, s.ReplyItemID, s.Unanswered = now, it.ID, ""
	})
}

// closeAsks records on thread asker's open questions to thread to why no answer came.
func (m *Manager) closeAsks(ctx context.Context, asker, to, why string) {
	m.editAsks(ctx, asker, to, func(s *SentMessage) { s.Unanswered = why })
}

// closeAsksLater is closeAsks off the locks. Callers hold m.mu.
func (m *Manager) closeAsksLater(asker, to, why string) {
	if m.closed {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.closeAsks(m.ctx, asker, to, why)
	}()
}

// editAsks changes, with fn, each note in thread asker's timeline that records a wanted
// reply from thread to that has not come, and rewrites its text.
func (m *Manager) editAsks(ctx context.Context, asker, to string, fn func(*SentMessage)) {
	_, err := m.verbItem(ctx, asker, func(Thread) (Item, error) { return Item{}, nil }, func(w itemWriter) (Item, bool) {
		for _, id := range w.log.openAsks(to) {
			w.change(id, func(it *Item) {
				fn(it.Sent)
				it.Text = sentText(*it.Sent)
			})
		}
		return Item{}, true
	})
	if err != nil {
		m.log.Warn("update the notes of questions to a thread", "thread", asker, "to", to, "err", err)
	}
}

// openAsks are the ids of the notes recording a wanted reply from thread to that has not
// come (not replied, and not given up on for good: a turn that ended may still answer).
func (t *threadLog) openAsks(to string) []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var ids []string
	for _, it := range t.items {
		if s := it.Sent; it.Kind == KindNote && s != nil && s.ToThreadID == to && s.Reply == ReplyWanted && s.RepliedAt.IsZero() &&
			(s.Unanswered == "" || s.Unanswered == UnansweredTurnEnded) {
			ids = append(ids, it.ID)
		}
	}
	return ids
}

// replySentence is what a reply-wait's wake adds to its header.
func replySentence(sub Subscription) string {
	switch Relation(sub.Args[replyArg]) {
	case "":
		return ""
	case RelationWorker:
		return "It handled your message: its answer is its last message, below."
	}
	return "It ended the turn that read your message without answering you: its last message below may hold the answer; " +
		"if not, it may still answer later, as a message."
}

// replyWaitFiredLocked records that r, a reply-wait, fired: the turn that read the
// message ended without an answer (a worker's last message is its answer, so nothing for
// one). Callers hold m.mu.
func (m *Manager) replyWaitFiredLocked(r *subRec) {
	if !r.s.ReplyWait() || Relation(r.s.Args[replyArg]) == RelationWorker {
		return
	}
	m.closeAsksLater(r.s.SubscriberID, r.s.TargetID, UnansweredTurnEnded)
}

// replyArchivedLocked tells each thread waiting on a reply from thread id, which is being
// archived by thread by ("" the user), that none will come, except by itself. Callers
// hold m.mu.
func (m *Manager) replyArchivedLocked(id, by string) {
	if m.subs == nil {
		return
	}
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	t := rec.s
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	told := map[string]bool{}
	for _, r := range s.byID {
		who := r.s.SubscriberID
		if !r.s.ReplyWait() || r.s.TargetKind != TargetThread || r.s.TargetID != id || told[who] {
			continue
		}
		told[who] = true
		m.closeAsksLater(who, id, UnansweredArchived)
		if who == by {
			continue // it archived it itself
		}
		m.fireLocked(r, func(sub Subscription, at time.Time) Message { return replyArchivedWake(sub, t, at) })
	}
}

// replyArchivedWake is the wake of sub, a reply-wait, about thread t, archived before it
// answered.
func replyArchivedWake(sub Subscription, t Thread, at time.Time) Message {
	p := wakeArchivedPayload{Kind: "thread", SubscriptionID: sub.ID, Note: sub.Note, Condition: CondArchived, FiredAt: wakeTime(at), Thread: wakeArchivedThread{
		ID: t.ID, Name: t.Name, ProjectID: t.ProjectID, CreatedBy: t.CreatedBy, Labels: t.Labels, ArchivedAt: wakeTime(at), Report: wakeReportOf(t.Report),
	}}
	if p.Thread.Labels == nil {
		p.Thread.Labels = []string{}
	}
	return wakeMessage("Thread "+wakeWho(t)+" was archived before it answered your message, so no answer will come. Read it (code-foundry thread read "+
		t.ID+") for what it did, or tell the user if you still need the answer.", p)
}

// CondArchived is the condition of the wake that tells a thread waiting on a reply that
// the other thread was archived. Nothing subscribes to it.
const CondArchived Condition = "archived"

type wakeArchivedPayload struct {
	Kind           string             `json:"kind"`
	SubscriptionID string             `json:"subscription_id"`
	Note           string             `json:"note,omitempty"`
	Condition      Condition          `json:"condition"`
	FiredAt        string             `json:"fired_at"`
	Thread         wakeArchivedThread `json:"thread"`
}

type wakeArchivedThread struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	ProjectID  string      `json:"project_id"`
	CreatedBy  string      `json:"created_by"`
	Labels     []string    `json:"labels"`
	ArchivedAt string      `json:"archived_at"`
	Report     *wakeReport `json:"report"`
}

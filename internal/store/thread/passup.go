package thread

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strings"
	"time"
)

// Passing a worker's question up to the user (docs/notes/pass-up-question.md). A worker's
// question is its lead's to answer; for a product decision the lead genuinely does not
// know, the lead runs `thread pass-up` and keeps working. The question then is an ask on
// the lead, at the level of its own: a question item in the lead's timeline (Request.PassedUp
// set) that the existing pending list, Needs you, the popup and the docked card show, and
// the lead's status reads NeedsAttention "question: From <worker>: …" while it is open.
// The answer goes straight to the worker (its question tool answered as in its own thread,
// or a thread ask answered as the lead's message), and the lead gets a wake saying what
// the user answered.
//
// Only questions: a worker's pending question-tool prompt, or its latest thread ask the
// lead has not answered. Never a permission prompt. Only by a thread above the worker
// (createdByLocked), once per question, while it is open.
//
// The open pass-ups live in memory (Manager.passUps); the item persists in the lead's log
// as JSON, so nothing needs a migration. A daemon restart withdraws them all: the workers'
// prompts die with their processes, and the item is cancelled when the lead's log is next
// loaded (withdrawStaleLocked).

// PassUpKind is what a passed-up question was in the worker.
type PassUpKind string

// Pass-up kinds.
const (
	// PassUpQuestion: the worker's pending question-tool prompt (AskUserQuestion), which
	// blocks it.
	PassUpQuestion PassUpKind = "question"
	// PassUpAsk: the worker's `thread ask`; it keeps working on its assumption.
	PassUpAsk PassUpKind = "ask"
)

// PassedUp marks a question item on a lead as a worker's question passed up to the user.
type PassedUp struct {
	// From is the worker; FromName its name when it was passed up.
	From     string `json:"from"`
	FromName string `json:"from_name,omitempty"`
	Kind     PassUpKind
	// WorkerRequest is the worker's pending question-tool request (PassUpQuestion).
	WorkerRequest string `json:",omitempty"`
	// Assuming is what the worker does until it is answered (PassUpAsk).
	Assuming string `json:",omitempty"`
}

// passUpPrefix starts a passed-up question's request id on the lead.
const passUpPrefix = "pu-"

// passUp is an open passed-up question. Guarded by m.mu.
type passUp struct {
	lead, worker string
	// reqID is the request id on the lead; itemID its question item there ("" until
	// written).
	reqID, itemID string
	kind          PassUpKind
	workerReq     string    // PassUpQuestion
	askAt         time.Time // PassUpAsk: the ask's time
	summary       string    // "From <worker>: <question>"
	at            time.Time
}

// passUpState is a worker's thread asks as pass-up sees them, on its record. In memory.
type passUpState struct {
	// leadSent is when a thread above it last sent it a message: an ask before that is
	// answered.
	leadSent time.Time
	// passedAsk is the time of the ask passed up last: one pass-up per ask.
	passedAsk time.Time
}

// PassUpResult is what PassUp did.
type PassUpResult struct {
	Worker Thread
	Kind   PassUpKind
	// Question is the question's first text; Item the question item on the lead.
	Question string
	Item     Item
}

// PassUp implements Store.
func (m *Manager) PassUp(ctx context.Context, lead, worker, requestID string) (PassUpResult, error) {
	lead, worker, requestID = strings.TrimSpace(lead), strings.TrimSpace(worker), strings.TrimSpace(requestID)
	if lead == "" {
		return PassUpResult{}, fmt.Errorf("%w: only a lead passes up a question: run it from the thread that created the worker", ErrInvalidArgument)
	}
	if worker == "" {
		return PassUpResult{}, fmt.Errorf("%w: name the worker whose question to pass up", ErrInvalidArgument)
	}
	_, pending, err := m.Pending(ctx, worker)
	if err != nil {
		return PassUpResult{}, err
	}
	log, err := m.thread(ctx, worker)
	if err != nil {
		return PassUpResult{}, err
	}
	pu, it, err := m.reservePassUp(lead, worker, requestID, pending, log)
	if err != nil {
		return PassUpResult{}, err
	}
	item, err := m.verbItem(ctx, lead, func(Thread) (Item, error) { return it, nil }, nil)
	if err != nil {
		m.mu.Lock()
		delete(m.passUps, pu.reqID)
		m.mu.Unlock()
		return PassUpResult{}, err
	}
	m.mu.Lock()
	cur, open := m.passUps[pu.reqID]
	if open {
		cur.itemID = item.ID
		if rec, ok := m.recs[lead]; ok {
			m.commitLocked(rec, false)
		}
	}
	w := m.recs[worker]
	m.mu.Unlock()
	if !open {
		// Withdrawn while the item was written (the worker answered it, or went).
		m.cancelPassUpItem(lead, item.ID, "withdrawn: the worker no longer asks it")
		return PassUpResult{}, fmt.Errorf("%w: thread %s's question is no longer open", ErrFailedPrecondition, worker)
	}
	// The worker's prompt may have been answered between the look and the registration.
	if pu.kind == PassUpQuestion {
		if _, still, err := m.Pending(ctx, worker); err == nil && !slices.ContainsFunc(still, func(p PendingRequest) bool { return p.RequestID == pu.workerReq }) {
			m.withdrawPassUps(func(p *passUp) bool { return p.reqID == pu.reqID }, "withdrawn: the worker no longer asks it")
			return PassUpResult{}, fmt.Errorf("%w: thread %s's question is no longer open", ErrFailedPrecondition, worker)
		}
	}
	m.log.Info("question passed up", "lead", lead, "worker", worker, "kind", pu.kind, "request", pu.reqID)
	var ws Thread
	if w != nil {
		ws = w.s
	}
	return PassUpResult{Worker: ws, Kind: pu.kind, Question: firstQuestion(it), Item: item}, nil
}

// reservePassUp checks that lead may pass up worker's question (requestID, or its oldest
// pending question, else its open ask), registers it and builds the item for the lead.
func (m *Manager) reservePassUp(lead, worker, requestID string, pending []PendingRequest, log *threadLog) (*passUp, Item, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, err := m.record(worker)
	if err != nil {
		return nil, Item{}, err
	}
	l, err := m.record(lead)
	if err != nil {
		return nil, Item{}, err
	}
	switch {
	case !m.createdByLocked(worker, lead):
		return nil, Item{}, fmt.Errorf("%w: thread %s did not create thread %s: a lead passes up only its own workers' questions", ErrFailedPrecondition, lead, worker)
	case l.s.Removing || !l.s.ArchivedAt.IsZero():
		return nil, Item{}, fmt.Errorf("%w: thread %s is archived or being removed", ErrFailedPrecondition, lead)
	case w.s.Removing || !w.s.ArchivedAt.IsZero():
		return nil, Item{}, fmt.Errorf("%w: thread %s is archived or being removed: it asks nothing", ErrFailedPrecondition, worker)
	}
	now := m.opts.Now().Round(0).Truncate(time.Millisecond)
	pu := &passUp{lead: lead, worker: worker, reqID: passUpPrefix + itemSuffix(), at: now}
	pass := &PassedUp{From: worker, FromName: w.s.Name}
	var input string
	switch q, err := m.passUpTarget(w, requestID, pending); {
	case err != nil:
		return nil, Item{}, err
	case q != nil:
		cur, ok := log.get(q.ItemID)
		if !ok || cur.Request == nil {
			return nil, Item{}, fmt.Errorf("%w: thread %s's question %s is no longer open", ErrFailedPrecondition, worker, q.RequestID)
		}
		pu.kind, pu.workerReq, input = PassUpQuestion, q.RequestID, cur.Request.InputJSON
		pass.Kind, pass.WorkerRequest = PassUpQuestion, q.RequestID
	default:
		a := w.s.Asked
		pu.kind, pu.askAt = PassUpAsk, a.At
		pass.Kind, pass.Assuming = PassUpAsk, a.Assuming
		input = askInput(a.Question)
		w.passUp.passedAsk = a.At
	}
	it := Item{Kind: KindQuestion, Request: &Request{RequestID: pu.reqID, ToolName: "AskUserQuestion", InputJSON: input, State: RequestPending, PassedUp: pass}}
	pu.summary = requestSummary(it)
	if m.passUps == nil {
		m.passUps = map[string]*passUp{}
	}
	m.passUps[pu.reqID] = pu
	m.anyPassUps.Store(true)
	return pu, it, nil
}

// passUpTarget is the question of w's that a pass-up names: requestID (a pending question),
// else w's oldest pending question, else nil for its open ask. Refusals say why. Callers
// hold m.mu.
func (m *Manager) passUpTarget(w *record, requestID string, pending []PendingRequest) (*PendingRequest, error) {
	id := w.s.ID
	if requestID != "" {
		i := slices.IndexFunc(pending, func(p PendingRequest) bool { return p.RequestID == requestID })
		switch {
		case i < 0:
			return nil, fmt.Errorf("%w: thread %s has no pending request %s", ErrFailedPrecondition, id, requestID)
		case pending[i].Kind != KindQuestion:
			return nil, permissionRefusal(id, requestID)
		case m.passedLocked(id, requestID):
			return nil, alreadyPassed(id)
		}
		return &pending[i], nil
	}
	var perm string
	for i, p := range pending {
		if p.Kind != KindQuestion {
			if perm == "" {
				perm = p.RequestID
			}
			continue
		}
		if m.passedLocked(id, p.RequestID) {
			continue
		}
		return &pending[i], nil
	}
	if a := w.s.Asked; a != nil {
		switch {
		case !w.passUp.passedAsk.Before(a.At):
			if perm == "" {
				return nil, alreadyPassed(id)
			}
		case w.passUp.leadSent.After(a.At):
			if perm == "" {
				return nil, fmt.Errorf("%w: thread %s's ask was answered: a message from you came after it; nothing to pass up", ErrFailedPrecondition, id)
			}
		default:
			return nil, nil
		}
	}
	if perm != "" {
		return nil, permissionRefusal(id, perm)
	}
	for _, p := range m.passUps {
		if p.worker == id {
			return nil, alreadyPassed(id)
		}
	}
	return nil, fmt.Errorf("%w: thread %s has no open question to pass up", ErrFailedPrecondition, id)
}

// passedLocked reports whether worker's question request is passed up already.
func (m *Manager) passedLocked(worker, req string) bool {
	for _, p := range m.passUps {
		if p.worker == worker && p.workerReq == req {
			return true
		}
	}
	return false
}

func permissionRefusal(worker, req string) error {
	return fmt.Errorf("%w: thread %s's request %s is a permission prompt: never pass one up; approve or deny it yourself: "+
		"code-foundry thread respond --id %s --request %s allow (or deny --message \"why\")", ErrFailedPrecondition, worker, req, worker, req)
}

func alreadyPassed(worker string) error {
	return fmt.Errorf("%w: thread %s's question is already passed up to the user: keep working; you will be told the answer", ErrFailedPrecondition, worker)
}

// askInput is an ask as a question tool's input: the question, no options, so the user
// answers it in Other.
func askInput(q string) string {
	b, err := json.Marshal(map[string]any{"questions": []map[string]any{{"question": q, "header": "", "multiSelect": false, "options": []any{}}}})
	if err != nil {
		return `{"questions":[]}`
	}
	return string(b)
}

// firstQuestion is a question item's first question.
func firstQuestion(it Item) string {
	if it.Request == nil {
		return ""
	}
	if qs := questionsOf(it.Request.InputJSON); len(qs) > 0 {
		return qs[0].Question
	}
	return ""
}

// passUpOverlayLocked is the status a lead shows for its open passed-up questions: the
// oldest one's "question: From <worker>: …"; false when none is open or the lead is put
// away. Callers hold m.mu.
func (m *Manager) passUpOverlayLocked(rec *record) (string, bool) {
	if len(m.passUps) == 0 || rec.s.Removing || !rec.s.ArchivedAt.IsZero() {
		return "", false
	}
	var oldest *passUp
	for _, p := range m.passUps {
		if p.lead == rec.s.ID && p.itemID != "" && (oldest == nil || p.at.Before(oldest.at) || p.at.Equal(oldest.at) && p.reqID < oldest.reqID) {
			oldest = p
		}
	}
	if oldest == nil {
		return "", false
	}
	return "question: " + oldest.summary, true
}

// passUpsOf counts lead's open passed-up questions. Callers hold m.mu.
func (m *Manager) passUpsOf(lead string) int {
	n := 0
	for _, p := range m.passUps {
		if p.lead == lead && p.itemID != "" {
			n++
		}
	}
	return n
}

// passUpOf is lead's open passed-up question reqID; nil when it is not one.
func (m *Manager) passUpOf(lead, reqID string) *passUp {
	if !strings.HasPrefix(reqID, passUpPrefix) {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.passUps[reqID]; ok && p.lead == lead {
		c := *p
		return &c
	}
	return nil
}

// answerPassUp is Respond for a passed-up question: the answer goes to the worker, the
// item on the lead is resolved, and the lead is told.
func (m *Manager) answerPassUp(ctx context.Context, p *passUp, d Decision) (Item, error) {
	m.mu.Lock()
	if _, ok := m.passUps[p.reqID]; !ok {
		m.mu.Unlock()
		return Item{}, fmt.Errorf("%w: no pending request %s on thread %s", ErrNotFound, p.reqID, p.lead)
	}
	delete(m.passUps, p.reqID) // claimed: the worker's answer withdraws nothing now
	m.mu.Unlock()
	log, err := m.thread(ctx, p.lead)
	if err != nil {
		return Item{}, err
	}
	cur, ok := log.get(p.itemID)
	if !ok || cur.Request == nil {
		return Item{}, fmt.Errorf("%w: request %s has no item", ErrNotFound, p.reqID)
	}
	if d.Allow {
		for _, q := range questionsOf(cur.Request.InputJSON) {
			if strings.TrimSpace(d.Answers[q.Question]) == "" {
				m.restorePassUp(p)
				return Item{}, fmt.Errorf("%w: no answer for question %q", ErrInvalidArgument, q.Question)
			}
		}
	}
	switch p.kind {
	case PassUpQuestion:
		if _, err := m.Respond(ctx, p.worker, p.workerReq, d); err != nil {
			m.cancelPassUpItem(p.lead, p.itemID, "withdrawn: the worker no longer asks it")
			m.recommit(p.lead)
			return Item{}, fmt.Errorf("thread %s's question is no longer open: %w", p.worker, err)
		}
	case PassUpAsk:
		if d.Allow {
			text := "The user answered the question you asked (your lead passed it up to them):\n" + answersText(cur.Request.InputJSON, d.Answers)
			if _, err := m.Send(ctx, p.worker, Message{Text: text, ByThreadID: p.lead, Reply: ReplyNone}); err != nil {
				m.restorePassUp(p)
				return Item{}, err
			}
		}
	}
	it, _ := m.changeItem(log, p.lead, p.itemID, func(q *Request) {
		if d.Allow {
			q.State, q.Decision, q.Answers = RequestAllowed, DecisionAllow, maps.Clone(d.Answers)
		} else {
			q.State, q.Decision, q.Message = RequestDenied, DecisionDeny, "skipped"
		}
	})
	m.mu.Lock()
	if rec, ok := m.recs[p.lead]; ok {
		m.commitLocked(rec, false)
		if rec.s.ArchivedAt.IsZero() && !rec.s.Removing {
			m.tellLeadLocked(rec.s, p, cur.Request, d)
		}
	}
	m.mu.Unlock()
	m.log.Info("passed-up question answered", "lead", p.lead, "worker", p.worker, "kind", p.kind, "decision", d.word())
	return it, nil
}

// restorePassUp puts a claimed pass-up back (its answer failed before reaching anyone).
func (m *Manager) restorePassUp(p *passUp) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.recs[p.lead]; ok {
		m.passUps[p.reqID] = p
	}
}

// answersText is the user's answers to a question's questions, one per line.
func answersText(input string, answers map[string]string) string {
	qs := questionsOf(input)
	if len(qs) == 1 {
		return quoted(answers[qs[0].Question])
	}
	var lines []string
	for _, q := range qs {
		lines = append(lines, quoted(q.Question+" → "+answers[q.Question]))
	}
	if len(lines) == 0 {
		keys := slices.Sorted(maps.Keys(answers))
		for _, k := range keys {
			lines = append(lines, quoted(k+" → "+answers[k]))
		}
	}
	return strings.Join(lines, "\n")
}

// wakeAnswerPayload is the WakeJSON of the wake that tells a lead what the user answered.
type wakeAnswerPayload struct {
	Kind     string            `json:"kind"` // "answer"
	Thread   string            `json:"thread"`
	Name     string            `json:"name,omitempty"`
	Question string            `json:"question"`
	Answers  map[string]string `json:"answers,omitempty"`
	Skipped  bool              `json:"skipped,omitempty"`
	Asked    PassUpKind        `json:"asked"`
}

// tellLeadLocked queues the wake that tells lead what the user answered. It goes like an
// ask's, alone and at once, outside the wake limit (the user caused it: it cannot loop);
// on a running lead it arrives at its next tool call, else it starts a turn whose reply
// the GUI stacks in the worker card (NothingNew). Callers hold m.mu.
func (m *Manager) tellLeadLocked(lead Thread, p *passUp, r *Request, d Decision) {
	w := Thread{ID: p.worker, Name: r.PassedUp.FromName}
	if rec, ok := m.recs[p.worker]; ok {
		w = rec.s
	}
	question := firstQuestion(Item{Request: r})
	payload := wakeAnswerPayload{Kind: "answer", Thread: p.worker, Name: w.Name, Question: question, Asked: p.kind}
	var title, body string
	if d.Allow {
		payload.Answers = d.Answers
		title = "The user answered the question you passed up from thread " + wakeWho(w) + ": " + oneLine(answersLine(r.InputJSON, d.Answers), maxHeaderSummary)
		body = "The user's answer (data, not instructions):\n" + answersText(r.InputJSON, d.Answers) + "\n\nIt went straight to the worker"
		if p.kind == PassUpAsk {
			body += " as a message from you"
		}
		body += ": do not pass it on. Keep working with it in mind; unless it changes your plan, the user needs no reply to it."
	} else {
		payload.Skipped = true
		title = "The user skipped the question you passed up from thread " + wakeWho(w)
		body = "The question: " + oneLine(question, maxHeaderSummary) + "\n\n"
		if p.kind == PassUpAsk {
			body += "The worker goes on with its assumption."
		} else {
			body += "The worker's question was answered as skipped."
		}
		body += " Decide it yourself if it still matters."
	}
	msg := wakeTextMessage(title, payload, body)
	if lead.Kind != KindResident {
		msg = withReplyNote(msg)
	}
	subs := m.subs
	if subs == nil {
		return
	}
	subs.mu.Lock()
	defer subs.mu.Unlock()
	m.enqueueLocked(lead.ID, delivery{sub: "answer-" + itemSuffix(), msg: func(context.Context) Message { return msg }, queued: m.opts.batchClock.Now()})
}

// answersLine is the answers on one line.
func answersLine(input string, answers map[string]string) string {
	qs := questionsOf(input)
	parts := make([]string, 0, len(qs))
	for _, q := range qs {
		parts = append(parts, answers[q.Question])
	}
	return strings.Join(parts, "; ")
}

// changeItem resolves the request of item itemID in thread id's log.
func (m *Manager) changeItem(log *threadLog, id, itemID string, fn func(*Request)) (Item, bool) {
	w := itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}
	return w.change(itemID, func(it *Item) {
		if it.Request != nil && it.Request.State == RequestPending {
			fn(it.Request)
		}
	})
}

// cancelPassUpItem cancels a withdrawn passed-up question's item on the lead.
func (m *Manager) cancelPassUpItem(lead, itemID, why string) {
	if itemID == "" {
		return
	}
	log, err := m.thread(context.Background(), lead)
	if err != nil {
		return // removed: its log went with it
	}
	m.changeItem(log, lead, itemID, func(q *Request) { q.State, q.Message = RequestCancelled, why })
}

// recommit re-applies thread id's shown status.
func (m *Manager) recommit(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; ok {
		m.commitLocked(rec, false)
	}
}

// withdrawPassUps removes the open pass-ups match picks, cancels their items with why and
// re-applies their leads' status.
func (m *Manager) withdrawPassUps(match func(*passUp) bool, why string) {
	m.mu.Lock()
	gone := m.takePassUpsLocked(match)
	m.mu.Unlock()
	m.finishWithdrawals(gone, why)
}

// takePassUpsLocked removes and returns the open pass-ups match picks. Callers hold m.mu.
func (m *Manager) takePassUpsLocked(match func(*passUp) bool) []passUp {
	var gone []passUp
	for id, p := range m.passUps {
		if match(p) {
			gone = append(gone, *p)
			delete(m.passUps, id)
		}
	}
	sort.Slice(gone, func(i, j int) bool { return gone[i].reqID < gone[j].reqID })
	return gone
}

// finishWithdrawals cancels withdrawn pass-ups' items and re-applies their leads' status.
func (m *Manager) finishWithdrawals(gone []passUp, why string) {
	for _, p := range gone {
		m.cancelPassUpItem(p.lead, p.itemID, why)
		m.recommit(p.lead)
		m.log.Info("passed-up question withdrawn", "lead", p.lead, "worker", p.worker, "kind", p.kind, "why", why)
	}
}

// requestSettled hears that thread id's request item left pending (answered, withdrawn,
// cancelled): a pass-up of it is withdrawn. Off the caller's goroutine: the caller may
// hold anything.
func (m *Manager) requestSettled(id string, it Item) {
	if !m.anyPassUps.Load() || it.Kind != KindQuestion || it.Request == nil || it.Request.State == RequestPending {
		return
	}
	req := it.Request.RequestID
	go func() {
		if m.ctx.Err() != nil {
			return // shutting down: the lead's item is withdrawn when its log next loads
		}
		m.withdrawPassUps(func(p *passUp) bool { return p.worker == id && p.kind == PassUpQuestion && p.workerReq == req },
			"withdrawn: the worker's question was answered or withdrawn")
	}()
}

// putAwayPassUpsLocked withdraws the pass-ups rec is the lead or the worker of once it is
// archived or being removed. Callers hold m.mu; the items change off it.
func (m *Manager) putAwayPassUpsLocked(rec *record) {
	if len(m.passUps) == 0 || (rec.s.ArchivedAt.IsZero() && !rec.s.Removing) {
		return
	}
	id := rec.s.ID
	gone := m.takePassUpsLocked(func(p *passUp) bool { return p.lead == id || p.worker == id })
	if len(gone) == 0 || m.closed {
		return
	}
	why := "withdrawn: the worker was archived or removed"
	if gone[0].lead == id {
		why = "withdrawn: this thread was archived or removed"
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.finishWithdrawals(gone, why)
	}()
}

// noteLeadSentLocked records a message to rec from a thread above it: its ask is answered.
func (m *Manager) noteLeadSent(id, by string) {
	if by == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; ok && m.createdByLocked(id, by) {
		rec.passUp.leadSent = m.opts.Now().Round(0).Truncate(time.Millisecond)
	}
}

// openPassUpItems are lead's open passed-up question items. Callers hold m.mu.
func (m *Manager) openPassUpItems(lead string) map[string]bool {
	out := map[string]bool{}
	for _, p := range m.passUps {
		if p.lead == lead {
			out[p.itemID] = true
		}
	}
	return out
}

// withdrawStale cancels the passed-up questions a loaded log has open that no pass-up
// holds (a daemon restart lost them).
func withdrawStale(w itemWriter, open map[string]bool) {
	var stale []string
	w.log.mu.Lock()
	for _, it := range w.log.items {
		if it.Request != nil && it.Request.PassedUp != nil && it.Request.State == RequestPending && !open[it.ID] {
			stale = append(stale, it.ID)
		}
	}
	w.log.mu.Unlock()
	for _, id := range stale {
		w.change(id, func(it *Item) {
			it.Request.State, it.Request.Message = RequestCancelled, "withdrawn: the app restarted"
		})
	}
}

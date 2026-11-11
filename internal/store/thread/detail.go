package thread

// Detail is what a thread's items say beyond its record, read by the same rules as its
// wakes (wakeDetailOf), for thread.get: an agent that reads a thread instead of waiting
// for its wake sees the same facts (docs/notes/orch-cli-batch.md). Whether its report
// is stale is on the record (Thread.ReportStale).
type Detail struct {
	// Pending is the request a "permission: …" or "question: …" status describes; nil
	// otherwise.
	Pending *PendingDetail
}

// PendingDetail is a pending permission prompt or question as a wake's JSON carries
// it: Kind "permission" or "question", RequestID, Tool, Input (the tool's input JSON as
// a json.RawMessage, or its head as a string when longer than 4 KiB), and a question's
// Question and Options (Questions when it asks several).
type PendingDetail = wakePending

// DetailOf reads t's Detail from its items.
func DetailOf(t Thread, items []Item) Detail {
	d := wakeDetailOf(t, items, wakeChildren{})
	return Detail{Pending: d.pending}
}

// LastSaid is what a wake on t carries as last_message (wakeDetailOf): its latest turn's
// last assistant text, cut at maxLastMessage runes. "" unless t meets CondIdle, and when
// that turn said nothing.
func LastSaid(t Thread, items []Item) string {
	if !Meets(CondIdle, t) {
		return ""
	}
	_, _, last := lastTurn(items)
	return cutMessage(last)
}

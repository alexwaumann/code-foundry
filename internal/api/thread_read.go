package api

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Pages of a thread's items for agents (ListThreadItemsRequest.query, thread.read;
// docs/notes/agents-5-cli.md): the last few items of a role, or the ones after an item,
// and where to read on.

// itemPage is a query's answer before mapping.
type itemPage struct {
	items     []thread.Item
	nextSince string
	more      bool
}

// pageItems selects q's page of items: those of q's role; after q.since (an item id, else
// an ordinal) the first q.last of them by ordinal, else the last q.last; q.last 0 is every
// one. The page is in the log's order: by ordinal, except a message Claude read later than
// it arrived sits where it read it (docs/notes/orch-queued-placement.md); counting by
// ordinal keeps since from skipping it. A since that names no item of the thread and is
// no number is NotFound.
func pageItems(items []thread.Item, q *v1.ThreadItemsQuery) (itemPage, error) {
	since, hasSince, err := sinceOrdinal(items, q.GetSince())
	if err != nil {
		return itemPage{}, err
	}
	var sel []thread.Item
	for _, it := range items {
		if (!hasSince || it.Ordinal > since) && roleMatches(q.GetRole(), it) {
			sel = append(sel, it)
		}
	}
	p := itemPage{items: sel}
	if n := int(q.GetLast()); n > 0 && len(sel) > n {
		byOrd := slices.SortedFunc(slices.Values(sel), func(a, b thread.Item) int { return cmp.Compare(a.Ordinal, b.Ordinal) })
		keep := byOrd[len(byOrd)-n:]
		if hasSince {
			keep, p.more = byOrd[:n], true
		}
		lo, hi := keep[0].Ordinal, keep[len(keep)-1].Ordinal
		p.items = slices.DeleteFunc(slices.Clone(sel), func(it thread.Item) bool { return it.Ordinal < lo || it.Ordinal > hi })
	}
	p.nextSince = nextSince(p.items, q.GetSince())
	return p, nil
}

// nextSince is where the next read goes on after items: the item with the highest
// ordinal before the first one still streaming (in ordinal order: a placed message sits
// after items with higher ordinals), else since.
func nextSince(items []thread.Item, since string) string {
	byOrd := slices.SortedFunc(slices.Values(items), func(a, b thread.Item) int { return cmp.Compare(a.Ordinal, b.Ordinal) })
	for _, it := range byOrd {
		if it.Streaming {
			break
		}
		since = it.ID
	}
	return since
}

// sinceOrdinal reads a since: the ordinal of the item with that id, else the number
// itself ("5" or "#5"). ok is false for "".
func sinceOrdinal(items []thread.Item, since string) (ord int64, ok bool, err error) {
	if since == "" {
		return 0, false, nil
	}
	for _, it := range items {
		if it.ID == since {
			return it.Ordinal, true, nil
		}
	}
	// "#5" is how thread read prints an ordinal.
	if n, err := strconv.ParseInt(strings.TrimPrefix(since, "#"), 10, 64); err == nil && n >= 0 {
		return n, true, nil
	}
	return 0, false, connect.NewError(connect.CodeNotFound, fmt.Errorf("the thread has no item %s (give an item id or an ordinal)", since))
}

// roleMatches: it is of the role (any for UNSPECIFIED).
func roleMatches(role v1.ThreadItemRole, it thread.Item) bool {
	switch role {
	case v1.ThreadItemRole_THREAD_ITEM_ROLE_USER:
		return it.Kind == thread.KindUserMessage && it.Origin != thread.OriginWake
	case v1.ThreadItemRole_THREAD_ITEM_ROLE_WAKE:
		return it.Kind == thread.KindUserMessage && it.Origin == thread.OriginWake
	case v1.ThreadItemRole_THREAD_ITEM_ROLE_ASSISTANT:
		return it.Kind == thread.KindAssistantText
	case v1.ThreadItemRole_THREAD_ITEM_ROLE_TOOL:
		return it.Kind == thread.KindToolCall || it.Kind == thread.KindPermission || it.Kind == thread.KindQuestion
	case v1.ThreadItemRole_THREAD_ITEM_ROLE_NOTE:
		return it.Kind == thread.KindNote
	default:
		return true
	}
}

// pageToProto maps a page.
func pageToProto(id string, p itemPage) *v1.ThreadItemsPage {
	out := &v1.ThreadItemsPage{ThreadId: id, NextSince: p.nextSince, More: p.more, Items: make([]*v1.ThreadItem, len(p.items))}
	for i, it := range p.items {
		out.Items[i] = itemToProto(it)
	}
	return out
}

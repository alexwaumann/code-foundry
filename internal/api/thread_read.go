package api

import (
	"fmt"
	"strconv"

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

// pageItems selects q's page of items (in ordinal order): those of q's role; after
// q.since (an item id, else an ordinal) the first q.last of them, else the last q.last;
// q.last 0 is every one. A since that names no item of the thread and is no number is
// NotFound.
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
		if hasSince {
			p.items, p.more = sel[:n], true
		} else {
			p.items = sel[len(sel)-n:]
		}
	}
	p.nextSince = q.GetSince()
	for _, it := range p.items {
		if it.Streaming {
			break
		}
		p.nextSince = it.ID
	}
	return p, nil
}

// sinceOrdinal reads a since: the ordinal of the item with that id, else the number
// itself. ok is false for "".
func sinceOrdinal(items []thread.Item, since string) (ord int64, ok bool, err error) {
	if since == "" {
		return 0, false, nil
	}
	for _, it := range items {
		if it.ID == since {
			return it.Ordinal, true, nil
		}
	}
	if n, err := strconv.ParseInt(since, 10, 64); err == nil && n >= 0 {
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

package command

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// A pull request a command opens (pr.create, which also answers with the branch's open
// one; pr.revert) is linked to the thread that ran it, the way thread.pr.link links one
// (docs/notes/pr-create-links-thread.md): deduplicated by URL, never removed, copied up
// the CreatedBy chain. The thread is Context.CallerThreadID: the thread whose CLI ran the
// command, or the thread selected in the app. No thread, no link.

// ThreadLink is what linking an opened pull request to the calling thread did, in the
// command's --json as "threadLink".
type ThreadLink struct {
	ThreadID string `json:"threadId"`
	// Linked is false when the thread had the pull request already (or the link failed).
	Linked bool   `json:"linked"`
	Slug   string `json:"slug,omitempty"`
	Number int32  `json:"number,omitempty"`
	URL    string `json:"url"`
	// Error is why the link failed. The pull request exists all the same.
	Error string `json:"error,omitempty"`
}

// linkCallerPR links the pull request at url to uctx's caller thread with b. It returns
// the line the command's message gets ("" and nil when there is no thread, no URL or no
// backend) and the link for its JSON. A failed link is logged and reported in the line,
// never returned: the pull request is open either way.
func linkCallerPR(ctx context.Context, b PullRequestLinkBackend, uctx Context, url string) (string, *ThreadLink) {
	id := uctx.CallerThreadID
	if b == nil || id == "" || url == "" {
		return "", nil
	}
	res, err := b.LinkPullRequest(ctx, connect.NewRequest(&v1.LinkThreadPullRequestRequest{Id: id, PullRequest: url}))
	if err != nil {
		slog.Warn("link the opened pull request to the calling thread", "thread", id, "pr", url, "err", err)
		msg := err.Error()
		if ce := (*connect.Error)(nil); errors.As(err, &ce) {
			msg = ce.Message()
		}
		return fmt.Sprintf("could not link %s to thread %s: %s", url, id, msg), &ThreadLink{ThreadID: id, URL: url, Error: msg}
	}
	l, th := res.Msg.GetLink(), res.Msg.GetThread()
	link := &ThreadLink{ThreadID: cmp.Or(th.GetId(), id), Linked: res.Msg.GetLinked(), Slug: l.GetSlug(), Number: l.GetNumber(), URL: cmp.Or(l.GetUrl(), url)}
	if !link.Linked {
		return fmt.Sprintf("thread %s already has %s#%d linked", threadLabel(th), l.GetSlug(), l.GetNumber()), link
	}
	return fmt.Sprintf("linked %s#%d to thread %s", l.GetSlug(), l.GetNumber(), threadLabel(th)), link
}

// withThreadLink adds the link line and "threadLink" to a command's result: the message
// gets the line after a newline, and the JSON (a proto message, as it was) gets the link
// as one more field, so readers of the existing fields see no change.
func withThreadLink(r Result, line string, link *ThreadLink) Result {
	if link == nil {
		return r
	}
	r.Message += "\n" + line
	if m, ok := r.JSON.(proto.Message); ok {
		r.JSON = linkedJSON{msg: m, link: link}
	}
	return r
}

// linkedJSON is a proto message's protojson object with "threadLink" added.
type linkedJSON struct {
	msg  proto.Message
	link *ThreadLink
}

func (j linkedJSON) MarshalJSON() ([]byte, error) {
	b, err := protojson.Marshal(j.msg)
	if err != nil {
		return nil, fmt.Errorf("encode result: %w", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		return nil, fmt.Errorf("encode result: %w", err)
	}
	if fields == nil {
		fields = map[string]json.RawMessage{}
	}
	lb, err := json.Marshal(j.link)
	if err != nil {
		return nil, fmt.Errorf("encode thread link: %w", err)
	}
	fields["threadLink"] = lb
	return json.Marshal(fields)
}

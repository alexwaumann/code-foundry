package api

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Wait blocks until the thread meets req's condition, or its timeout passes (timed_out,
// with the current record). It subscribes to the thread list before reading the
// snapshot, so a change between the two is not missed and a condition that already
// holds returns at once. See docs/notes/agents-1-wait-events.md.
func (h *Thread) Wait(ctx context.Context, req *connect.Request[v1.WaitThreadRequest]) (*connect.Response[v1.WaitThreadResponse], error) {
	id, until := req.Msg.GetId(), req.Msg.GetUntil()
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("a thread id is required"))
	}
	var expired <-chan time.Time
	if d := req.Msg.GetTimeout().AsDuration(); d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		expired = t.C
	}
	sub := bus.Subscribe[thread.Event](h.bus, watchBuffer)
	defer sub.Close()
	cur, ok := h.store.Snapshot().Thread(id)
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s not found", id))
	}
	var dropped uint64
	for {
		p := threadToProto(cur)
		if threadWaitMet(until, p) {
			return connect.NewResponse(&v1.WaitThreadResponse{Thread: p}), nil
		}
		select {
		case <-ctx.Done():
			return nil, threadError(ctx.Err())
		case <-expired:
			return connect.NewResponse(&v1.WaitThreadResponse{Thread: p, TimedOut: true}), nil
		case ev, open := <-sub.C():
			if !open {
				return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("the daemon is stopping"))
			}
			if d := sub.Dropped(); d != dropped {
				// Missed changes: the snapshot has them.
				dropped = d
				if cur, ok = h.store.Snapshot().Thread(id); !ok {
					return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s was removed", id))
				}
				continue
			}
			switch e := ev.(type) {
			case thread.Updated:
				if e.Thread.ID == id {
					cur = e.Thread
				}
			case thread.Removed:
				if e.ID == id {
					return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s was removed", id))
				}
			}
		}
	}
}

// threadWaitMet reports whether t meets the wait condition (ThreadWaitCondition in
// thread_lifecycle.proto; UNSPECIFIED is IDLE).
func threadWaitMet(until v1.ThreadWaitCondition, t *v1.Thread) bool {
	switch until {
	case v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ATTENTION:
		return t.GetStatus() == v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION
	case v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ERROR:
		return t.GetStatus() == v1.ThreadStatus_THREAD_STATUS_ERROR
	case v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_DISCONNECTED:
		return t.GetState() == v1.ThreadState_THREAD_STATE_DISCONNECTED
	}
	return threadSettled(t)
}

// threadSettled is the IDLE condition: Claude is not working and nothing waits on an
// answer. A turn that ended shows as needs-attention "finished" (or "error: <code>")
// until someone looks at the thread, so those count; a pending permission prompt or
// question mid-turn does not (stream_status.go's reason prefixes, as thread.set-effort's
// onTurn).
func threadSettled(t *v1.Thread) bool {
	if t.GetState() == v1.ThreadState_THREAD_STATE_STARTING {
		return false
	}
	switch t.GetStatus() {
	case v1.ThreadStatus_THREAD_STATUS_IDLE, v1.ThreadStatus_THREAD_STATUS_ERROR:
		return true
	case v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION:
		r := t.GetStatusReason()
		return !strings.HasPrefix(r, "permission") && !strings.HasPrefix(r, "question")
	case v1.ThreadStatus_THREAD_STATUS_UNSPECIFIED:
		// A row from before status persistence: only a stopped one is known not to work.
		return t.GetState() == v1.ThreadState_THREAD_STATE_DISCONNECTED
	}
	return false
}

package api

import (
	"context"
	"fmt"
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
		if threadWaitMet(until, cur) {
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

// threadWaitConditions maps the wait conditions to the store's (UNSPECIFIED is IDLE).
var threadWaitConditions = map[v1.ThreadWaitCondition]thread.Condition{
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_UNSPECIFIED:  thread.CondIdle,
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_IDLE:         thread.CondIdle,
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ATTENTION:    thread.CondAttention,
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ERROR:        thread.CondError,
	v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_DISCONNECTED: thread.CondDisconnected,
}

// threadWaitMet reports whether t meets the wait condition (ThreadWaitCondition in
// thread_lifecycle.proto): thread.Meets, which the wake subscriptions share.
func threadWaitMet(until v1.ThreadWaitCondition, t thread.Thread) bool {
	c, ok := threadWaitConditions[until]
	if !ok {
		c = thread.CondIdle
	}
	return thread.Meets(c, t)
}

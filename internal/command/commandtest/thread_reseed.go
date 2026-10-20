package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Reseed returns Current one epoch on (from 1); like the daemon, a CONNECTED thread
// that is busy gets reseed_pending, an idle one is stopping (CLOSING, reseed_pending, stopped),
// and a prefix sets seed_pending.
func (s *Thread) Reseed(_ context.Context, r *connect.Request[v1.ReseedThreadRequest]) (*connect.Response[v1.ReseedThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	cur.Epoch = max(cur.GetEpoch(), 1) + 1
	cur.SeedPending = r.Msg.GetPrefix() != ""
	stopped := false
	if cur.GetState() == v1.ThreadState_THREAD_STATE_CONNECTED {
		if cur.GetStatus() == v1.ThreadStatus_THREAD_STATUS_BUSY {
			cur.ReseedPending = true
		} else {
			// Closing: reseed_pending until the process is gone, like the daemon.
			cur.State, cur.ReseedPending, stopped = v1.ThreadState_THREAD_STATE_CLOSING, true, true
		}
	}
	return connect.NewResponse(&v1.ReseedThreadResponse{Thread: cur, Stopped: stopped}), nil
}

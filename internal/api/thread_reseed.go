package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Resident threads and reseeds (docs/notes/ember-1-primitives.md): the Thread fields and
// the Reseed handler.

// residentToProto maps a thread's kind, resident name, epoch and reseed state.
func residentToProto(s thread.Thread, p *v1.Thread) {
	if s.Kind == thread.KindResident {
		p.Kind, p.ResidentName = v1.ThreadKind_THREAD_KIND_RESIDENT, s.ResidentName
	}
	p.Epoch = int32(max(s.Epoch, 1))
	p.ReseedPending, p.SeedPending = s.ReseedPending, s.SeedPrefix != ""
}

// Reseed gives a thread a fresh Claude session with a seed.
func (h *Thread) Reseed(ctx context.Context, req *connect.Request[v1.ReseedThreadRequest]) (*connect.Response[v1.ReseedThreadResponse], error) {
	m := req.Msg
	s, stopped, err := h.store.Reseed(ctx, m.GetId(), thread.ReseedOptions{
		SystemPromptAppend: m.GetSystemPromptAppend(), AddDirs: m.GetAddDirs(), Prefix: m.GetPrefix(),
	})
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ReseedThreadResponse{Thread: threadToProto(s), Stopped: stopped}), nil
}

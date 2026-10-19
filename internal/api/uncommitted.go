package api

import (
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// withUncommittedDetail adds an UncommittedWork detail to out when err is a removal
// refused only for uncommitted changes (*project.UncommittedError), so a client can ask
// the user whether to delete that work and retry with force.
func withUncommittedDetail(out *connect.Error, err error) *connect.Error {
	var ue *project.UncommittedError
	if !errors.As(err, &ue) {
		return out
	}
	d := &v1.UncommittedWork{}
	for _, w := range ue.Worktrees {
		d.Worktrees = append(d.Worktrees, worktreeToProto(w))
	}
	if det, derr := connect.NewErrorDetail(d); derr == nil {
		out.AddDetail(det)
	}
	return out
}

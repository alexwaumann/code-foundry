package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// SetPullRequestCheckbox ticks or unticks one task-list item of a pull request's
// description. Thin: the gh store re-reads the description, checks the item, sends the
// mutation and invalidates the detail (docs/notes/pr-checkbox.md).
func (h *Gh) SetPullRequestCheckbox(ctx context.Context, req *connect.Request[v1.SetPullRequestCheckboxRequest]) (*connect.Response[v1.SetPullRequestCheckboxResponse], error) {
	r, err := h.store.SetPullRequestCheckbox(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()), gh.CheckboxChange{
		Index: int(req.Msg.GetIndex()), Text: req.Msg.GetText(), Checked: req.Msg.GetChecked(),
	})
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.SetPullRequestCheckboxResponse{Changed: r.Changed, Message: r.Message}), nil
}

package api

import (
	"context"
	"errors"
	"fmt"
	"io/fs"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/preview"
)

// StreamFile grants the File tab's player a URL streaming one video or audio file (package
// preview's media route): checked now by ReadFile's rules (fsx.OpenMedia), and again by the
// route on every request. The URL is root-relative: the route is on the API listener the
// GUI already calls.
func (h *Filesystem) StreamFile(_ context.Context, req *connect.Request[v1.StreamFileRequest]) (*connect.Response[v1.StreamFileResponse], error) {
	m := req.Msg
	f, c, err := fsx.OpenMedia(h.readRoots(), m.GetBaseDir(), m.GetPath())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("%s does not exist", m.GetPath()))
	}
	if err != nil {
		return nil, fileError(err)
	}
	_ = f.Close()
	grant, err := h.grants.GrantMedia(c.Path)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("stream %s: %w", c.Path, err))
	}
	return connect.NewResponse(&v1.StreamFileResponse{
		Url: preview.MediaURL(grant, c.Path), MimeType: c.MIMEType, Size: c.Size, ModifiedAt: c.ModifiedAt.UnixMilli(),
	}), nil
}

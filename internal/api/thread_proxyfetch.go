package api

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/proxyfetch"
)

// WithFetch sets the client ProxyFetch makes pages' requests with; without one it is
// Unimplemented.
func (h *Thread) WithFetch(c *proxyfetch.Client) *Thread {
	h.fetch = c
	return h
}

// ProxyFetch implements ThreadService: one HTTP request for a page of the thread, the
// bridge's cf.fetch (docs/notes/bridge-fetch.md). The request ends with the call.
func (h *Thread) ProxyFetch(ctx context.Context, req *connect.Request[v1.ProxyFetchRequest]) (*connect.Response[v1.ProxyFetchResponse], error) {
	if h.fetch == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon does not fetch for pages"))
	}
	m := req.Msg
	if _, err := h.store.Get(ctx, m.GetThreadId()); err != nil {
		return nil, threadError(err)
	}
	res, err := h.fetch.Do(ctx, proxyfetch.Request{
		Thread: m.GetThreadId(), URL: m.GetUrl(), Method: m.GetMethod(), Header: m.GetHeaders(), Body: m.GetBody(),
		Timeout: time.Duration(m.GetTimeoutMs()) * time.Millisecond,
	})
	if err != nil {
		return nil, fetchError(err)
	}
	return connect.NewResponse(&v1.ProxyFetchResponse{
		Status: uint32(res.Status), StatusText: res.StatusText, Headers: res.Header, Body: res.Body, Url: res.URL,
	}), nil
}

// fetchError maps a proxyfetch error to the code the bridge reads (api/bridge.ts):
// InvalidArgument is invalid, DeadlineExceeded timeout, the rest failed.
func fetchError(err error) error {
	var fe *proxyfetch.Error
	if !errors.As(err, &fe) {
		return threadError(err)
	}
	code := connect.CodeUnavailable
	switch fe.Kind {
	case proxyfetch.Invalid:
		code = connect.CodeInvalidArgument
	case proxyfetch.Timeout:
		code = connect.CodeDeadlineExceeded
	case proxyfetch.TooLarge:
		code = connect.CodeResourceExhausted
	}
	return connect.NewError(code, err)
}

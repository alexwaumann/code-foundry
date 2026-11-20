package api

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/proxyfetch"
	"github.com/alexwaumann/code-foundry/internal/shot"
	"github.com/alexwaumann/code-foundry/internal/store/page"
)

// PageStore is the page store (*page.Store) as PageService, PreviewFile and the page.*
// commands use it (docs/notes/page-ownership-daemon.md).
type PageStore interface {
	Access(ctx context.Context, path string) (page.Access, error)
	Allow(ctx context.Context, path string) (page.Access, error)
	SetConsent(ctx context.Context, path string, allowed bool) (page.Access, error)
	Storage(ctx context.Context, path string) (map[string]string, error)
	SetStorage(ctx context.Context, path, key string, value *string) (map[string]string, error)
}

var _ PageStore = (*page.Store)(nil)

// Page implements codefoundryv1connect.PageServiceHandler over the page store.
type Page struct {
	store PageStore
	home  string
	fetch *proxyfetch.Client
	shots *shot.Broker // nil: CheckPage is unimplemented (WithChecks)
}

var _ codefoundryv1connect.PageServiceHandler = (*Page)(nil)

// NewPage returns a PageService handler; home expands a "~/" path. fetch makes the
// pages' requests; nil makes ProxyFetch Unimplemented.
func NewPage(store PageStore, home string, fetch *proxyfetch.Client) *Page {
	return &Page{store: store, home: home, fetch: fetch}
}

// Route mounts the service.
func (h *Page) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewPageServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// ExpandPagePath is path with a leading "~/" (or a bare "~") made home.
func ExpandPagePath(home, path string) string {
	if path == "~" {
		return home
	}
	if rest, ok := strings.CutPrefix(path, "~/"); ok && home != "" {
		return filepath.Join(home, rest)
	}
	return path
}

func (h *Page) path(p string) string { return ExpandPagePath(h.home, p) }

// GetPage implements PageService.
func (h *Page) GetPage(ctx context.Context, req *connect.Request[v1.GetPageRequest]) (*connect.Response[v1.GetPageResponse], error) {
	a, err := h.store.Access(ctx, h.path(req.Msg.GetPath()))
	if err != nil {
		return nil, pageError(err)
	}
	return connect.NewResponse(&v1.GetPageResponse{Page: PageAccessProto(a)}), nil
}

// PageStorage implements PageService.
func (h *Page) PageStorage(ctx context.Context, req *connect.Request[v1.PageFileStorageRequest]) (*connect.Response[v1.PageFileStorageResponse], error) {
	vals, err := h.store.Storage(ctx, h.path(req.Msg.GetPath()))
	if err != nil {
		return nil, pageError(err)
	}
	return connect.NewResponse(&v1.PageFileStorageResponse{Values: vals}), nil
}

// SetPageStorage implements PageService.
func (h *Page) SetPageStorage(ctx context.Context, req *connect.Request[v1.SetPageFileStorageRequest]) (*connect.Response[v1.SetPageFileStorageResponse], error) {
	m := req.Msg
	vals, err := h.store.SetStorage(ctx, h.path(m.GetPath()), m.GetKey(), m.Value)
	if err != nil {
		return nil, pageError(err)
	}
	return connect.NewResponse(&v1.SetPageFileStorageResponse{Values: vals}), nil
}

// ProxyFetch implements PageService: ThreadService.ProxyFetch for a page no thread owns,
// once the daemon has checked the user allowed it, capped per page file.
func (h *Page) ProxyFetch(ctx context.Context, req *connect.Request[v1.PageProxyFetchRequest]) (*connect.Response[v1.PageProxyFetchResponse], error) {
	if h.fetch == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon does not fetch for pages"))
	}
	m := req.Msg
	a, err := h.store.Allow(ctx, h.path(m.GetPath()))
	if err != nil {
		return nil, pageError(err)
	}
	res, err := h.fetch.Do(ctx, proxyfetch.Request{
		Key: "page:" + a.Path, URL: m.GetUrl(), Method: m.GetMethod(), Header: m.GetHeaders(), Body: m.GetBody(),
		Timeout: time.Duration(m.GetTimeoutMs()) * time.Millisecond,
	})
	if err != nil {
		return nil, fetchError(err)
	}
	return connect.NewResponse(&v1.PageProxyFetchResponse{
		Status: uint32(res.Status), StatusText: res.StatusText, Headers: res.Header, Body: res.Body, Url: res.URL,
	}), nil
}

// PageAccessProto is a page's access as the API says it.
func PageAccessProto(a page.Access) *v1.PageAccess {
	out := &v1.PageAccess{Path: a.Path, OwnerThread: a.Owner, OwnerSource: ownerSourceProto(a.How()), Answer: consentProto(a.Consent), StoragePerFile: true}
	for _, o := range a.Owners {
		out.Owners = append(out.Owners, &v1.PageOwner{ThreadId: o.Thread, Source: ownerSourceProto(o.How)})
	}
	out.Consent = out.Answer
	if a.Owner != "" {
		out.Consent = v1.PageConsent_PAGE_CONSENT_OWNED
	}
	return out
}

func ownerSourceProto(how string) v1.PageOwnerSource {
	switch how {
	case page.Written:
		return v1.PageOwnerSource_PAGE_OWNER_SOURCE_WRITTEN
	case page.Shown:
		return v1.PageOwnerSource_PAGE_OWNER_SOURCE_SHOWN
	case page.PagesDirectory:
		return v1.PageOwnerSource_PAGE_OWNER_SOURCE_PAGES_DIRECTORY
	}
	return v1.PageOwnerSource_PAGE_OWNER_SOURCE_UNSPECIFIED
}

func consentProto(c page.Consent) v1.PageConsent {
	switch c {
	case page.Allowed:
		return v1.PageConsent_PAGE_CONSENT_ALLOWED
	case page.Refused:
		return v1.PageConsent_PAGE_CONSENT_REFUSED
	}
	return v1.PageConsent_PAGE_CONSENT_NOT_ASKED
}

// UnavailablePage is the access of a file that is no page the bridge is given, err saying
// why (without the store's sentinel, "invalid argument: ").
func UnavailablePage(err error) *v1.PageAccess {
	reason := err.Error()
	for _, s := range []error{page.ErrInvalidArgument, page.ErrNotFound, page.ErrGuarded} {
		reason = strings.TrimPrefix(reason, s.Error()+": ")
	}
	return &v1.PageAccess{Consent: v1.PageConsent_PAGE_CONSENT_UNAVAILABLE, Answer: v1.PageConsent_PAGE_CONSENT_UNAVAILABLE, UnavailableReason: reason}
}

// pageError is a page store error as a Connect error.
func pageError(err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return err
	}
	code := connect.CodeInternal
	switch {
	case errors.Is(err, page.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, page.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, page.ErrGuarded), errors.Is(err, page.ErrRefused):
		code = connect.CodePermissionDenied
	case errors.Is(err, page.ErrNotAsked):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}

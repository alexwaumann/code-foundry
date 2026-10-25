package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/proxyfetch"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// ProxyFetch answers the upstream's response, any status; its errors map to the codes
// the bridge reads; an unknown thread is NotFound; no client is Unimplemented.
func TestProxyFetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/issues":
			b, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"auth":"`+r.Header.Get("Authorization")+`","body":`+string(b)+`}`)
		case "/big":
			_, _ = w.Write(make([]byte, proxyfetch.MaxResponseBody+1))
		default:
			http.Error(w, "nope", http.StatusTeapot)
		}
	}))
	defer srv.Close()
	ap := netip.MustParseAddrPort(strings.TrimPrefix(srv.URL, "http://"))
	b := bus.New()
	fake := threadtest.New(b)
	fake.Put(thread.Thread{ID: "s-1"})
	ctx := context.Background()
	fetch := func(h *Thread, m *v1.ProxyFetchRequest) (*v1.ProxyFetchResponse, error) {
		res, err := h.ProxyFetch(ctx, connect.NewRequest(m))
		if err != nil {
			return nil, err
		}
		return res.Msg, nil
	}
	if _, err := fetch(NewThread(fake, b), &v1.ProxyFetchRequest{ThreadId: "s-1", Url: srv.URL}); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("no client: %v", err)
	}
	c := proxyfetch.New(proxyfetch.Options{Allow: []netip.AddrPort{ap}})
	defer c.Close()
	h := NewThread(fake, b).WithFetch(c)

	res, err := fetch(h, &v1.ProxyFetchRequest{ThreadId: "s-1", Url: srv.URL + "/issues", Method: "POST",
		Headers: map[string]string{"Authorization": "Bearer t"}, Body: []byte(`[1]`)})
	if err != nil || res.GetStatus() != 200 || string(res.GetBody()) != `{"auth":"Bearer t","body":[1]}` ||
		res.GetHeaders()["content-type"] != "application/json" || res.GetUrl() != srv.URL+"/issues" {
		t.Fatalf("POST = %v, %v", res, err)
	}
	if res, err := fetch(h, &v1.ProxyFetchRequest{ThreadId: "s-1", Url: srv.URL + "/x"}); err != nil || res.GetStatus() != 418 || res.GetStatusText() != "I'm a teapot" {
		t.Errorf("418 = %v, %v", res, err)
	}
	for _, tc := range []struct {
		name string
		req  *v1.ProxyFetchRequest
		code connect.Code
	}{
		{"unknown thread", &v1.ProxyFetchRequest{ThreadId: "s-9", Url: srv.URL}, connect.CodeNotFound},
		{"scheme", &v1.ProxyFetchRequest{ThreadId: "s-1", Url: "file:///etc/hosts"}, connect.CodeInvalidArgument},
		{"loopback", &v1.ProxyFetchRequest{ThreadId: "s-1", Url: "http://127.0.0.1:1/"}, connect.CodeInvalidArgument},
		{"too big", &v1.ProxyFetchRequest{ThreadId: "s-1", Url: srv.URL + "/big"}, connect.CodeResourceExhausted},
		{"unreachable", &v1.ProxyFetchRequest{ThreadId: "s-1", Url: "http://unreachable.invalid/"}, connect.CodeUnavailable},
	} {
		if _, err := fetch(h, tc.req); connect.CodeOf(err) != tc.code {
			t.Errorf("%s: %v, want %v", tc.name, err, tc.code)
		}
	}
}

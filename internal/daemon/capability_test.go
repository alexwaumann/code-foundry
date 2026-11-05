package daemon

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/capability"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// bearer adds an Authorization header to every request.
type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

// Agent search's scoped token, through the loopback listener's auth and the command
// handler: thread.search, thread.read and its own search.report run; any other command,
// search.report for another search, and any other RPC are refused, and the token is dead
// once revoked or expired. The daemon token is unaffected.
func TestScopedTokenOnTheLoopbackAPI(t *testing.T) {
	var mu sync.Mutex
	var ran []string
	reg := command.NewRegistry()
	for _, name := range []string{"thread.search", "thread.read", "search.report", "thread.new", "settings.set"} {
		if err := reg.Register(command.Command{Name: name, Title: name, Category: "Test", NoPalette: true, NoKeybinding: true,
			Args: []command.ArgSpec{{Name: "search", Type: command.String}, {Name: "text", Type: command.String}},
			Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
				mu.Lock()
				ran = append(ran, name)
				mu.Unlock()
				return command.Result{Message: "ok"}, nil
			}}); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	route := api.NewCommand(reg).Route()
	mux.Handle(route.Path, route.Handler)
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	now := time.Unix(1000, 0)
	var clock sync.Mutex
	caps := capability.NewRegistry(func() time.Time { clock.Lock(); defer clock.Unlock(); return now })
	srv := httptest.NewServer(loopbackHandler("daemon-secret", caps, []string{"/preview/"}, 0, nil, mux))
	t.Cleanup(srv.Close)
	tok, revoke, err := caps.Issue(capability.Scope{Search: "q-0123456789ab"}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	client := func(token string) codefoundryv1connect.CommandServiceClient {
		return codefoundryv1connect.NewCommandServiceClient(&http.Client{Transport: bearer{token}}, srv.URL)
	}
	invoke := func(token, name string, args map[string]string) error {
		_, err := client(token).Invoke(context.Background(), connect.NewRequest(&v1.InvokeCommandRequest{Name: name, Args: args}))
		return err
	}
	ctx := context.Background()
	if _, err := client(tok).List(ctx, connect.NewRequest(&v1.ListCommandsRequest{})); err != nil {
		t.Errorf("List with the scoped token: %v", err)
	}
	for _, tc := range []struct {
		name string
		args map[string]string
		code connect.Code // 0: runs
	}{
		{"thread.search", nil, 0},
		{"thread.read", nil, 0},
		{"search.report", map[string]string{"search": "q-0123456789ab"}, 0},
		{"search.report", map[string]string{"search": "q-ffffffffffff"}, connect.CodePermissionDenied},
		{"search.report", nil, connect.CodePermissionDenied},
		{"thread.new", map[string]string{"text": "do anything"}, connect.CodePermissionDenied},
		{"settings.set", nil, connect.CodePermissionDenied},
	} {
		err := invoke(tok, tc.name, tc.args)
		if tc.code == 0 && err != nil || tc.code != 0 && connect.CodeOf(err) != tc.code {
			t.Errorf("%s %v = %v, want code %v", tc.name, tc.args, err, tc.code)
		}
	}
	mu.Lock()
	if strings.Join(ran, ",") != "thread.search,thread.read,search.report" {
		t.Errorf("ran %q", ran)
	}
	ran = nil
	mu.Unlock()
	// Any other RPC or path: 403.
	for _, path := range []string{"/codefoundry.v1.FilesystemService/WriteFile", "/codefoundry.v1.SearchService/Report", "/codefoundry.v1.ThreadService/List",
		"/codefoundry.v1.HealthService/Version", "/codefoundry.v1.EventService/Watch", "/anything"} {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+path, strings.NewReader("{}"))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s with the scoped token = %d, want 403", path, res.StatusCode)
		}
	}
	// The daemon token still does everything.
	if err := invoke("daemon-secret", "thread.new", nil); err != nil {
		t.Errorf("thread.new with the daemon token: %v", err)
	}
	// Revoked (the search ended): unauthenticated.
	revoke()
	if err := invoke(tok, "thread.search", nil); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("revoked token = %v", err)
	}
	// Expired.
	tok2, _, _ := caps.Issue(capability.Scope{Search: "q-0123456789ab"}, time.Minute)
	if err := invoke(tok2, "thread.search", nil); err != nil {
		t.Fatalf("fresh token: %v", err)
	}
	clock.Lock()
	now = now.Add(time.Minute)
	clock.Unlock()
	if err := invoke(tok2, "thread.search", nil); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("expired token = %v", err)
	}
	var ce *connect.Error
	if err := invoke("cfcap_forged", "thread.search", nil); !errors.As(err, &ce) || ce.Code() != connect.CodeUnauthenticated {
		t.Errorf("forged token = %v", err)
	}
}

package capability

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// A scoped token: its own search's three verbs and the CLI's way to them, nothing else.
func TestScopeAllows(t *testing.T) {
	s := Scope{Search: "q-0123456789ab"}
	for _, tt := range []struct {
		name string
		args map[string]string
		ok   bool
	}{
		{"thread.search", map[string]string{"query": "poller"}, true},
		{"thread.read", map[string]string{"id": "s-1", "full": "true"}, true},
		{"search.report", map[string]string{"search": "q-0123456789ab", "thread": "s-1"}, true},
		{"search.report", map[string]string{"search": "q-ffffffffffff", "thread": "s-1"}, false},
		{"search.report", map[string]string{"thread": "s-1"}, false},
		{"thread.new", map[string]string{"prompt": "x"}, false},
		{"thread.send", map[string]string{"id": "s-1", "text": "x"}, false},
		{"thread.list", nil, false},
		{"settings.set", map[string]string{"key": "k"}, false},
		{"search.agent", map[string]string{"question": "x"}, false},
		{"search.promote", map[string]string{"id": "q-0123456789ab"}, false},
		{"", nil, false},
	} {
		err := s.AllowCommand(tt.name, tt.args)
		if (err == nil) != tt.ok || (err != nil && !errors.Is(err, ErrDenied)) {
			t.Errorf("AllowCommand(%q, %v) = %v, want ok %v", tt.name, tt.args, err, tt.ok)
		}
	}
	if err := (Scope{}).AllowCommand("thread.search", nil); err == nil {
		t.Error("an empty scope allowed thread.search")
	}
	for path, want := range map[string]bool{
		codefoundryv1connect.HealthServicePingProcedure:       true,
		codefoundryv1connect.CommandServiceListProcedure:      true,
		codefoundryv1connect.CommandServiceInvokeProcedure:    true,
		codefoundryv1connect.SearchServiceReportProcedure:     false,
		codefoundryv1connect.SearchServiceStartAgentProcedure: false,
		codefoundryv1connect.SearchServicePromoteProcedure:    false,
		codefoundryv1connect.HealthServiceVersionProcedure:    false,
		codefoundryv1connect.EventServiceWatchProcedure:       false,
		"/preview/x/": false, "/codefoundry.v1.CommandService/Invoke/": false,
	} {
		if got := s.AllowProcedure(path); got != want {
			t.Errorf("AllowProcedure(%q) = %v", path, got)
		}
	}
}

// Issue, Lookup, revoke and expiry.
func TestRegistry(t *testing.T) {
	now := time.Unix(1000, 0)
	r := NewRegistry(func() time.Time { return now })
	tok, revoke, err := r.Issue(Scope{Search: "q-1"}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(tok, TokenPrefix) || len(tok) < 40 {
		t.Errorf("token = %q", tok)
	}
	if s, ok := r.Lookup(tok); !ok || s.Search != "q-1" {
		t.Errorf("lookup = %+v, %v", s, ok)
	}
	for _, bad := range []string{"", tok + "x", tok[:len(tok)-1], strings.ToUpper(tok)} {
		if _, ok := r.Lookup(bad); ok {
			t.Errorf("lookup %q succeeded", bad)
		}
	}
	other, _, _ := r.Issue(Scope{Search: "q-2"}, time.Minute)
	revoke()
	revoke() // idempotent
	if _, ok := r.Lookup(tok); ok {
		t.Error("a revoked token is live")
	}
	if s, ok := r.Lookup(other); !ok || s.Search != "q-2" {
		t.Error("revoking one token ended another")
	}
	now = now.Add(time.Minute)
	if _, ok := r.Lookup(other); ok {
		t.Error("an expired token is live")
	}
	var nilReg *Registry
	if _, ok := nilReg.Lookup(other); ok {
		t.Error("a nil registry knows a token")
	}
}

func TestScopeContext(t *testing.T) {
	if _, ok := FromContext(context.Background()); ok {
		t.Error("a plain context has a scope")
	}
	if s, ok := FromContext(WithScope(context.Background(), Scope{Search: "q-1"})); !ok || s.Search != "q-1" {
		t.Errorf("scope = %+v, %v", s, ok)
	}
}

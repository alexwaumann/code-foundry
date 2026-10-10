package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDecodeOrgPolicy(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		allowed []string
		known   bool
		err     bool
	}{
		{"member: no policy fields", `{"login":"acme","id":1}`, nil, false, false},
		{"owner, enterprise org, everything", `{"members_can_create_repositories":true,"members_can_create_public_repositories":true,
			"members_can_create_internal_repositories":true,"members_can_create_private_repositories":true}`,
			[]string{"PUBLIC", "INTERNAL", "PRIVATE"}, true, false},
		{"owner, private disabled", `{"members_can_create_public_repositories":true,"members_can_create_internal_repositories":true,
			"members_can_create_private_repositories":false}`, []string{"PUBLIC", "INTERNAL"}, true, false},
		{"owner, no internal field (not enterprise)", `{"members_can_create_public_repositories":true,
			"members_can_create_private_repositories":true}`, []string{"PUBLIC", "PRIVATE"}, true, false},
		{"owner, only private", `{"members_can_create_public_repositories":false,"members_can_create_private_repositories":true}`,
			[]string{"PRIVATE"}, true, false},
		{"owner, creation disabled", `{"members_can_create_repositories":false,"members_can_create_public_repositories":true,
			"members_can_create_private_repositories":true}`, []string{}, true, false},
		{"malformed", `[`, nil, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			allowed, known, err := decodeOrgPolicy([]byte(tt.body))
			if (err != nil) != tt.err {
				t.Fatalf("err = %v, want error %t", err, tt.err)
			}
			if known != tt.known || fmt.Sprint(allowed) != fmt.Sprint(tt.allowed) {
				t.Errorf("got %v known=%t, want %v known=%t", allowed, known, tt.allowed, tt.known)
			}
		})
	}
}

// ownersGitHub answers PublishOwners (GraphQL) and GET orgs/{org} (REST).
type ownersGitHub struct {
	mu       sync.Mutex
	login    string
	orgs     []string
	policies map[string]string // org -> body
	errs     map[string]error  // org -> REST error
	rest     []string
}

func (g *ownersGitHub) graphql(op string, _ map[string]any) (json.RawMessage, error) {
	if op != "PublishOwners" {
		return nil, fmt.Errorf("unexpected op %s", op)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	nodes := []any{}
	for _, o := range g.orgs {
		nodes = append(nodes, map[string]any{"login": o})
	}
	return json.Marshal(map[string]any{
		"rateLimit": map[string]any{"limit": 5000, "cost": 1, "remaining": 4000, "resetAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)},
		"viewer":    map[string]any{"login": g.login, "organizations": map[string]any{"nodes": nodes}},
	})
}

func (g *ownersGitHub) restOrg(path string, _ map[string]string) (json.RawMessage, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.rest = append(g.rest, path)
	org, ok := strings.CutPrefix(path, "orgs/")
	if !ok {
		return nil, fmt.Errorf("unexpected path %s", path)
	}
	if err := g.errs[org]; err != nil {
		return nil, err
	}
	if b, ok := g.policies[org]; ok {
		return json.RawMessage(b), nil
	}
	return json.RawMessage(fmt.Sprintf(`{"login":%q}`, org)), nil
}

func (g *ownersGitHub) restCalls() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.rest)
}

func ownerSummary(os []PublishOwner) []string {
	out := make([]string, len(os))
	for i, o := range os {
		kind := "user"
		if o.Org {
			kind = "org"
		}
		out[i] = fmt.Sprintf("%s %s %s known=%t", o.Login, kind, strings.Join(o.Allowed, "+"), o.Known)
	}
	return out
}

func TestPublishOwners(t *testing.T) {
	g := &ownersGitHub{
		login: "octocat",
		orgs:  []string{"zeta", "octo-org", "Acme", "gone"},
		policies: map[string]string{
			"octo-org": `{"members_can_create_public_repositories":true,"members_can_create_internal_repositories":true,"members_can_create_private_repositories":false}`,
		},
		errs: map[string]error{"gone": fmt.Errorf("%w: Not Found", ErrNotFound)},
	}
	f := &fakeRunner{}
	f.set(g.graphql)
	rr := &restRunner{fakeRunner: f, rest: g.restOrg}
	s := startStore(t, testOptions(openTestDB(t), rr, nil))
	// age moves the cached list's time back by d.
	age := func(d time.Duration) {
		s.owners.mu.Lock()
		s.owners.at = s.owners.at.Add(-d)
		s.owners.mu.Unlock()
	}
	ctx := context.Background()

	want := []string{
		"octocat user PUBLIC+PRIVATE known=true",
		"Acme org PUBLIC+INTERNAL+PRIVATE known=false",
		"gone org PUBLIC+INTERNAL+PRIVATE known=false",
		"octo-org org PUBLIC+INTERNAL known=true",
		"zeta org PUBLIC+INTERNAL+PRIVATE known=false",
	}
	got, err := s.PublishOwners(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(ownerSummary(got)) != fmt.Sprint(want) {
		t.Fatalf("owners:\n got %v\nwant %v", ownerSummary(got), want)
	}
	if calls := g.restCalls(); len(calls) != 4 {
		t.Errorf("REST calls = %v, want one per org", calls)
	}

	// Cached: no request for 10 minutes, and callers cannot change the cache.
	got[0].Allowed[0] = "MUTATED"
	age(9 * time.Minute)
	again, err := s.PublishOwners(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(ownerSummary(again)) != fmt.Sprint(want) {
		t.Errorf("cached owners = %v", ownerSummary(again))
	}
	if n := f.count("PublishOwners"); n != 1 {
		t.Errorf("PublishOwners requests = %d, want 1 (cached)", n)
	}

	// Expired: asked again.
	age(2 * time.Minute)
	if _, err := s.PublishOwners(ctx); err != nil {
		t.Fatal(err)
	}
	if n := f.count("PublishOwners"); n != 2 {
		t.Errorf("PublishOwners requests = %d, want 2 after 11 minutes", n)
	}

	// A transient REST failure answers unknown for that org and is not cached.
	g.mu.Lock()
	g.errs["zeta"] = errors.New("github: 500 Internal Server Error")
	g.mu.Unlock()
	age(OwnersTTL)
	got, err = s.PublishOwners(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(ownerSummary(got)) != fmt.Sprint(want) {
		t.Errorf("owners with zeta failing = %v", ownerSummary(got))
	}
	if _, err := s.PublishOwners(ctx); err != nil {
		t.Fatal(err)
	}
	if n := f.count("PublishOwners"); n != 4 {
		t.Errorf("PublishOwners requests = %d, want 4 (a partial list is not cached)", n)
	}
}

func TestPublishOwnersWithoutREST(t *testing.T) {
	g := &ownersGitHub{login: "octocat", orgs: []string{"octo-org"}}
	f := &fakeRunner{}
	f.set(g.graphql)
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	got, err := s.PublishOwners(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"octocat user PUBLIC+PRIVATE known=true", "octo-org org PUBLIC+INTERNAL+PRIVATE known=false"}
	if fmt.Sprint(ownerSummary(got)) != fmt.Sprint(want) {
		t.Errorf("owners = %v, want %v", ownerSummary(got), want)
	}
}

func TestPublishOwnersError(t *testing.T) {
	f := &fakeRunner{}
	f.set(func(string, map[string]any) (json.RawMessage, error) {
		return nil, fmt.Errorf("%w: boom", ErrServerTimeout)
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	if _, err := s.PublishOwners(context.Background()); !errors.Is(err, ErrServerTimeout) {
		t.Errorf("err = %v, want ErrServerTimeout", err)
	}
}

package gh

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestDecodeSearchRepositoriesFixture(t *testing.T) {
	got, err := decodeSearchRepositories(fixtureData(t, "search_repositories_cli.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != MaxSearchResults {
		t.Fatalf("len = %d, want %d", len(got), MaxSearchResults)
	}
	first := Repository{Owner: "cli", Name: "cli", Description: "GitHub’s official command line tool",
		Visibility: "PUBLIC", URL: "https://github.com/cli/cli"}
	if got[0] != first {
		t.Errorf("first = %+v, want %+v", got[0], first)
	}
	archived := 0
	for _, r := range got {
		if r.Archived {
			archived++
			if r.Slug() != "dotnet/cli" {
				t.Errorf("archived %s, want only dotnet/cli", r.Slug())
			}
		}
	}
	if archived != 1 {
		t.Errorf("archived = %d, want 1", archived)
	}
}

func TestDecodeLookupRepositoryFixtures(t *testing.T) {
	r, err := decodeLookupRepository(fixtureData(t, "lookup_repository_cli.json"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Slug() != "cli/cli" || r.Visibility != "PUBLIC" || r.URL != "https://github.com/cli/cli" {
		t.Errorf("got %+v", r)
	}
	if _, err := decodeLookupRepository(fixtureData(t, "lookup_repository_not_found.json")); !errors.Is(err, ErrNotFound) {
		t.Errorf("not found: err = %v", err)
	}
}

func TestSearchAndLookup(t *testing.T) {
	g := newFakeGitHub()
	g.addCards(
		Repository{Owner: "alexwaumann", Name: "code-foundry", Description: "Fleets of Claude Code sessions"},
		Repository{Owner: "alexwaumann", Name: "dotfiles"},
		Repository{Owner: "Octo-Org", Name: "Old-Thing", Archived: true, Visibility: "INTERNAL", Description: "retired"},
	)
	for i := range 25 {
		g.addCards(Repository{Owner: "many", Name: fmt.Sprintf("widget-%02d", i)})
	}
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	ctx := context.Background()

	searches := []struct {
		name    string
		query   string
		want    []string // slugs, in order
		count   int      // when want is nil: just the length
		err     error
		request bool // a request went out
	}{
		{"matches name and description", "foundry", []string{"alexwaumann/code-foundry"}, 0, nil, true},
		{"owner matches", "alexwaumann", []string{"alexwaumann/code-foundry", "alexwaumann/dotfiles"}, 0, nil, true},
		{"no match is an empty list", "nothing-like-this", []string{}, 0, nil, true},
		{"capped at 20", "widget", nil, MaxSearchResults, nil, true},
		{"empty: refused locally", "   ", nil, 0, ErrInvalidArgument, false},
		{"too long: refused locally", string(make([]byte, 300)), nil, 0, ErrInvalidArgument, false},
	}
	for _, tt := range searches {
		t.Run("search/"+tt.name, func(t *testing.T) {
			before := f.count("SearchRepositories")
			got, err := s.SearchRepositories(ctx, tt.query)
			if sent := f.count("SearchRepositories") > before; sent != tt.request {
				t.Errorf("request sent = %t, want %t", sent, tt.request)
			}
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Fatalf("err = %v, want %v", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.want == nil {
				if len(got) != tt.count {
					t.Fatalf("len = %d, want %d", len(got), tt.count)
				}
				return
			}
			slugs := make([]string, 0, len(got))
			for _, r := range got {
				slugs = append(slugs, r.Slug())
			}
			if fmt.Sprint(slugs) != fmt.Sprint(tt.want) {
				t.Fatalf("got %v, want %v", slugs, tt.want)
			}
		})
	}

	lookups := []struct {
		name        string
		owner, repo string
		want        Repository
		err         error
		request     bool
	}{
		{"exact", "alexwaumann", "dotfiles", Repository{Owner: "alexwaumann", Name: "dotfiles", Visibility: "PUBLIC",
			URL: "https://github.com/alexwaumann/dotfiles"}, nil, true},
		{"GitHub's spelling comes back", "octo-org", "old-thing", Repository{Owner: "Octo-Org", Name: "Old-Thing",
			Description: "retired", Visibility: "INTERNAL", Archived: true, URL: "https://github.com/Octo-Org/Old-Thing"}, nil, true},
		{"missing is not found", "alexwaumann", "nope", Repository{}, ErrNotFound, true},
		{"invalid slug: refused locally", "-x", "y", Repository{}, ErrInvalidSlug, false},
	}
	for _, tt := range lookups {
		t.Run("lookup/"+tt.name, func(t *testing.T) {
			before := f.count("LookupRepository")
			got, err := s.LookupRepository(ctx, tt.owner, tt.repo)
			if sent := f.count("LookupRepository") > before; sent != tt.request {
				t.Errorf("request sent = %t, want %t", sent, tt.request)
			}
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Fatalf("err = %v, want %v", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}

	t.Run("rate limited", func(t *testing.T) {
		g.failNext("SearchRepositories", &RateLimitError{Msg: "API rate limit exceeded", ResetAt: time.Now().Add(time.Minute)})
		if _, err := s.SearchRepositories(ctx, "foundry"); !errors.Is(err, ErrRateLimited) {
			t.Fatalf("err = %v, want rate limited", err)
		}
	})
}

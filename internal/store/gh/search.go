package gh

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Repository search and lookup for the Add Project dialog (RepoService.SearchGitHub and
// LookupGitHub). Each call is one request on the store's worker, so pacing, the
// rate-limit pauses and the auth state apply as to every other request. Nothing is
// cached: the dialog asks on Enter, never per keystroke.

// Query names of the dialog's documents (queries/).
const (
	querySearchRepositories = "search_repositories"
	queryLookupRepository   = "lookup_repository"
)

// MaxSearchResults is how many repositories SearchRepositories returns at most.
const MaxSearchResults = 20

// maxSearchQuery bounds the search text (GitHub refuses queries over 256 characters).
const maxSearchQuery = 256

// Repository is a github.com repository as the Add Project dialog shows it.
type Repository struct {
	Owner       string
	Name        string
	Description string
	// Visibility is GitHub's RepositoryVisibility: PUBLIC, PRIVATE or INTERNAL.
	Visibility string
	Archived   bool
	Fork       bool
	URL        string
}

// Slug is "owner/name" as GitHub spells it.
func (r Repository) Slug() string { return r.Owner + "/" + r.Name }

// Finder finds repositories on github.com. *Store implements it; ghtest.Store fakes it.
type Finder interface {
	// SearchRepositories returns the first MaxSearchResults repositories matching
	// query (GitHub's search syntax), best match first.
	SearchRepositories(ctx context.Context, query string) ([]Repository, error)
	// LookupRepository returns one repository; ErrNotFound when it does not exist or
	// the viewer cannot see it.
	LookupRepository(ctx context.Context, owner, name string) (Repository, error)
}

var _ Finder = (*Store)(nil)

// SearchRepositories implements Finder.
func (s *Store) SearchRepositories(ctx context.Context, query string) ([]Repository, error) {
	q := strings.TrimSpace(query)
	switch {
	case q == "":
		return nil, fmt.Errorf("%w: empty search", ErrInvalidArgument)
	case utf8.RuneCountInString(q) > maxSearchQuery:
		return nil, fmt.Errorf("%w: search is longer than %d characters", ErrInvalidArgument, maxSearchQuery)
	}
	return submitFunc(ctx, s, "search|"+q, func(ctx context.Context) ([]Repository, error) {
		data, err := s.call(ctx, querySearchRepositories, map[string]any{"q": q})
		if err != nil && !isPartial(err) {
			return nil, err
		}
		return decodeSearchRepositories(data)
	})
}

// LookupRepository implements Finder. owner and name keep their case: the result
// carries GitHub's spelling either way.
func (s *Store) LookupRepository(ctx context.Context, owner, name string) (Repository, error) {
	owner, name = strings.TrimSpace(owner), strings.TrimSpace(name)
	slug, err := NormalizeSlug(owner + "/" + name)
	if err != nil {
		return Repository{}, err
	}
	return submitFunc(ctx, s, "lookup|"+slug, func(ctx context.Context) (Repository, error) {
		data, err := s.call(ctx, queryLookupRepository, map[string]any{"owner": owner, "name": name})
		if err != nil {
			// A missing repository is a NOT_FOUND part next to "repository": null.
			return Repository{}, err
		}
		return decodeLookupRepository(data)
	})
}

type repositoryCardJSON struct {
	Name  string `json:"name"`
	Owner *struct {
		Login string `json:"login"`
	} `json:"owner"`
	Description *string `json:"description"`
	Visibility  string  `json:"visibility"`
	IsArchived  bool    `json:"isArchived"`
	IsFork      bool    `json:"isFork"`
	URL         string  `json:"url"`
}

// repository maps a card; ok is false for an empty node (a search hit that is not a
// repository, which type: REPOSITORY never returns, or one GitHub blanked).
func (c *repositoryCardJSON) repository() (Repository, bool) {
	if c == nil || c.Name == "" || c.Owner == nil || c.Owner.Login == "" {
		return Repository{}, false
	}
	r := Repository{
		Owner: c.Owner.Login, Name: c.Name, Visibility: c.Visibility,
		Archived: c.IsArchived, Fork: c.IsFork, URL: c.URL,
	}
	if c.Description != nil {
		r.Description = strings.TrimSpace(*c.Description)
	}
	if r.URL == "" {
		r.URL = "https://github.com/" + r.Slug()
	}
	return r, true
}

func decodeSearchRepositories(data []byte) ([]Repository, error) {
	var d struct {
		Search *struct {
			Nodes []*repositoryCardJSON `json:"nodes"`
		} `json:"search"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("decode repository search: %w", err)
	}
	if d.Search == nil {
		return nil, fmt.Errorf("decode repository search: no search result")
	}
	out := make([]Repository, 0, len(d.Search.Nodes))
	for _, n := range d.Search.Nodes {
		if r, ok := n.repository(); ok && len(out) < MaxSearchResults {
			out = append(out, r)
		}
	}
	return out, nil
}

func decodeLookupRepository(data []byte) (Repository, error) {
	var d struct {
		Repository *repositoryCardJSON `json:"repository"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return Repository{}, fmt.Errorf("decode repository: %w", err)
	}
	r, ok := d.Repository.repository()
	if !ok {
		return Repository{}, fmt.Errorf("decode repository: %w", ErrNotFound)
	}
	return r, nil
}

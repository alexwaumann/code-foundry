package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// Publish owners (RepoService.ListPublishOwners): the accounts the viewer can create a
// repository in, for the publish picker. One GraphQL request lists the viewer and their
// organizations; one REST GET /orgs/{org} per organization reads its repository policy
// (members_can_create_{public,internal,private}_repositories). GitHub returns those
// fields only to organization owners, so for most organizations the policy is unknown
// and the picker offers every visibility. The list is cached for OwnersTTL.

const queryPublishOwners = "publish_owners"

// OwnersTTL is how long ListPublishOwners serves a cached list.
const OwnersTTL = 10 * time.Minute

// Repository visibilities, as GitHub's GraphQL spells them (Repository.Visibility).
const (
	VisibilityPublic   = "PUBLIC"
	VisibilityInternal = "INTERNAL"
	VisibilityPrivate  = "PRIVATE"
)

// AllVisibilities is every visibility, most open first.
var AllVisibilities = []string{VisibilityPublic, VisibilityInternal, VisibilityPrivate}

// PublishOwner is an account the viewer can publish a repository to.
type PublishOwner struct {
	Login string
	// Org is true for an organization, false for the viewer's own account.
	Org bool
	// Allowed are the visibilities a new repository may have there, most open first.
	// Every visibility when Known is false.
	Allowed []string
	// Known: Allowed is the organization's policy (always true for the viewer).
	Known bool
}

// Owners lists publish owners. *Store implements it; ghtest.Store fakes it.
type Owners interface {
	// PublishOwners returns the viewer's account first, then their organizations by
	// login.
	PublishOwners(ctx context.Context) ([]PublishOwner, error)
}

var _ Owners = (*Store)(nil)

// ownersCache holds the last complete owner list.
type ownersCache struct {
	mu     sync.Mutex
	at     time.Time
	owners []PublishOwner
}

func (c *ownersCache) get(now time.Time) ([]PublishOwner, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.owners == nil || now.Sub(c.at) >= OwnersTTL {
		return nil, false
	}
	return clonePublishOwners(c.owners), true
}

func (c *ownersCache) put(now time.Time, owners []PublishOwner) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at, c.owners = now, clonePublishOwners(owners)
}

func clonePublishOwners(in []PublishOwner) []PublishOwner {
	out := make([]PublishOwner, len(in))
	for i, o := range in {
		o.Allowed = slices.Clone(o.Allowed)
		out[i] = o
	}
	return out
}

// PublishOwners implements Owners. A list with an organization whose policy could not
// be read for a transient reason (network, rate limit) is returned but not cached.
func (s *Store) PublishOwners(ctx context.Context) ([]PublishOwner, error) {
	if owners, ok := s.owners.get(s.opts.Now()); ok {
		return owners, nil
	}
	type result struct {
		owners   []PublishOwner
		complete bool
	}
	r, err := submitFunc(ctx, s, "publish-owners", func(ctx context.Context) (result, error) {
		data, err := s.call(ctx, queryPublishOwners, nil)
		if err != nil && !isPartial(err) { // an SSO-protected org may come back as a partial error
			return result{}, err
		}
		login, orgs, err := decodePublishOwners(data)
		if err != nil {
			return result{}, err
		}
		owners := []PublishOwner{{Login: login, Allowed: []string{VisibilityPublic, VisibilityPrivate}, Known: true}}
		complete := true
		rr, _ := s.opts.Runner.(RESTRunner)
		for _, org := range orgs {
			o := PublishOwner{Login: org, Org: true, Allowed: slices.Clone(AllVisibilities)}
			if rr != nil {
				allowed, known, transient := s.orgPolicy(ctx, rr, org)
				if known {
					o.Allowed, o.Known = allowed, true
				}
				complete = complete && !transient
			}
			owners = append(owners, o)
		}
		return result{owners: owners, complete: complete}, nil
	})
	if err != nil {
		return nil, err
	}
	if r.complete {
		s.owners.put(s.opts.Now(), r.owners)
	}
	return clonePublishOwners(r.owners), nil
}

// orgPolicy reads an organization's repository creation policy with REST GET
// /orgs/{org}. known is false when the response has no policy fields (the viewer is
// not an owner) or the request failed; transient is true for a failure worth retrying
// (anything but not found or permission denied). Worker goroutine only.
func (s *Store) orgPolicy(ctx context.Context, rr RESTRunner, org string) (allowed []string, known, transient bool) {
	if err := s.pace(ctx); err != nil {
		return nil, false, true
	}
	start := s.opts.Now()
	body, err := rr.REST(ctx, "orgs/"+url.PathEscape(org), nil)
	s.lastEnd = s.opts.Now()
	s.log.Debug("gh request", "rest", "orgs/"+org, "dur", s.lastEnd.Sub(start).Round(time.Millisecond).String(), "err", err)
	if err != nil {
		if isAuthOrNetwork(err) {
			s.noteResult(ctx, err, nil)
		}
		return nil, false, !isNotFoundOrDenied(err)
	}
	allowed, known, err = decodeOrgPolicy(body)
	if err != nil {
		s.log.Warn("gh: decode org policy", "org", org, "err", err)
		return nil, false, false
	}
	return allowed, known, false
}

func isNotFoundOrDenied(err error) bool {
	return errors.Is(err, ErrNotFound) || errors.Is(err, ErrPermissionDenied)
}

func decodePublishOwners(data []byte) (login string, orgs []string, err error) {
	var d struct {
		Viewer *struct {
			Login         string `json:"login"`
			Organizations *struct {
				Nodes []*struct {
					Login string `json:"login"`
				} `json:"nodes"`
			} `json:"organizations"`
		} `json:"viewer"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return "", nil, fmt.Errorf("decode publish owners: %w", err)
	}
	if d.Viewer == nil || d.Viewer.Login == "" {
		return "", nil, fmt.Errorf("decode publish owners: no viewer")
	}
	if d.Viewer.Organizations != nil {
		for _, n := range d.Viewer.Organizations.Nodes {
			if n != nil && n.Login != "" {
				orgs = append(orgs, n.Login)
			}
		}
	}
	slices.SortFunc(orgs, func(a, b string) int { return strings.Compare(strings.ToLower(a), strings.ToLower(b)) })
	return d.Viewer.Login, slices.Compact(orgs), nil
}

// decodeOrgPolicy reads members_can_create_*_repositories from GET /orgs/{org}. They
// are present only for organization owners; without public and private the policy is
// unknown. internal is present only for organizations that can have internal
// repositories (GitHub Enterprise); absent means not allowed. When
// members_can_create_repositories is false nothing is allowed.
func decodeOrgPolicy(body []byte) (allowed []string, known bool, err error) {
	var d struct {
		Any      *bool `json:"members_can_create_repositories"`
		Public   *bool `json:"members_can_create_public_repositories"`
		Internal *bool `json:"members_can_create_internal_repositories"`
		Private  *bool `json:"members_can_create_private_repositories"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return nil, false, fmt.Errorf("decode organization: %w", err)
	}
	if d.Public == nil && d.Private == nil && d.Internal == nil {
		return nil, false, nil
	}
	allowed = []string{}
	if d.Any != nil && !*d.Any {
		return allowed, true, nil
	}
	for _, v := range []struct {
		flag *bool
		vis  string
	}{{d.Public, VisibilityPublic}, {d.Internal, VisibilityInternal}, {d.Private, VisibilityPrivate}} {
		if v.flag != nil && *v.flag {
			allowed = append(allowed, v.vis)
		}
	}
	return allowed, true, nil
}

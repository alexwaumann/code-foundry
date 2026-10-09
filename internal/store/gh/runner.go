package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Runner executes GitHub requests. HTTPRunner talks to api.github.com; tests use fakes.
type Runner interface {
	// GraphQL runs a query and returns the raw "data" object. GraphQL-level errors are
	// returned as classified errors (ErrNotFound, *RateLimitError, ...). When the
	// response has data as well as errors (some fields failed, the rest resolved), it
	// returns both: the data and a *PartialError.
	GraphQL(ctx context.Context, query string, vars map[string]any) (json.RawMessage, error)
	// AuthStatus re-resolves the token and reports whether GitHub accepts it. Used
	// while the store is paused as not authenticated.
	AuthStatus(ctx context.Context) (AuthStatus, error)
}

// AuthStatus is the github.com account behind the token gh hands out.
type AuthStatus struct {
	LoggedIn bool
	Login    string
	// Error says why there is no usable token (none, or GitHub rejected it).
	Error string
}

// graphQLResponse is the POST /graphql response envelope.
type graphQLResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []graphQLError  `json:"errors"`
}

type graphQLError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	// Path is where in the response the error happened, e.g. ["r1"] for an aliased
	// repository that does not exist.
	Path []any `json:"path,omitempty"`
}

// PartialError is a GraphQL response with both data and errors: some fields failed
// (an aliased repository that does not exist, say) and the rest resolved. Runner.GraphQL
// returns it alongside the data. errors.Is classifies it like a plain GraphQL error
// (ErrNotFound when any part was NOT_FOUND), so callers that ignore partial data keep
// treating it as a failure.
type PartialError struct {
	Errors []graphQLError
}

func (e *PartialError) Error() string { return "partial result: " + e.Unwrap().Error() }

// Unwrap returns the classified error of all parts.
func (e *PartialError) Unwrap() error { return classifyGraphQLErrors(e.Errors) }

// At returns the classified error of the parts under the top-level field alias, or nil.
func (e *PartialError) At(alias string) error {
	var errs []graphQLError
	for _, ge := range e.Errors {
		if len(ge.Path) > 0 && ge.Path[0] == alias {
			errs = append(errs, ge)
		}
	}
	if len(errs) == 0 {
		return nil
	}
	return classifyGraphQLErrors(errs)
}

// Unplaced returns the classified error of the parts with no top-level path, or nil.
func (e *PartialError) Unplaced() error {
	var errs []graphQLError
	for _, ge := range e.Errors {
		if len(ge.Path) == 0 {
			errs = append(errs, ge)
		}
	}
	if len(errs) == 0 {
		return nil
	}
	return classifyGraphQLErrors(errs)
}

func isPartial(err error) bool {
	var pe *PartialError
	return errors.As(err, &pe)
}

func classifyGraphQLErrors(errs []graphQLError) error {
	msgs := make([]string, 0, len(errs))
	for _, e := range errs {
		msgs = append(msgs, e.Message)
	}
	msg := strings.Join(msgs, "; ")
	for _, e := range errs {
		switch e.Type {
		case "NOT_FOUND":
			return fmt.Errorf("%w: %s", ErrNotFound, msg)
		case "RATE_LIMITED":
			return &RateLimitError{Msg: msg, Secondary: strings.Contains(strings.ToLower(msg), "secondary")}
		}
	}
	return fmt.Errorf("github graphql: %s", msg)
}

// RateLimitError is a rate-limit failure. errors.Is(err, ErrRateLimited) is true.
type RateLimitError struct {
	// Secondary is true for GitHub's secondary (abuse) limits, which have no reset time
	// and call for waiting RetryAfter, or at least a minute without one.
	Secondary bool
	Msg       string
	// RetryAfter is GitHub's retry-after header, when it sent one.
	RetryAfter time.Duration
	// ResetAt is x-ratelimit-reset when the response said the budget is exhausted.
	ResetAt time.Time
}

func (e *RateLimitError) Error() string {
	kind := "primary"
	if e.Secondary {
		kind = "secondary"
	}
	return fmt.Sprintf("%s (%s): %s", ErrRateLimited, kind, e.Msg)
}

// Is reports ErrRateLimited.
func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimited }

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return strings.TrimSpace(line)
}

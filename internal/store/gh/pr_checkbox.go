package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Ticking a task-list box of a pull request's description from the panel
// (docs/notes/pr-checkbox.md). GitHub has no compare-and-set for a description, so the
// box is flipped in a copy read just before the write, never in the cached detail's, and
// only if that copy's item still reads as the client showed it. Calls for one pull
// request hold its merge lock from the read to the write: two quick clicks each see the
// other's result. An edit landing between one read and its write is lost; GitHub offers
// no way to close that window, so it is as short as two requests.

// Query names of the documents (queries/).
const (
	queryPullRequestBody       = "pull_request_body"
	queryUpdatePullRequestBody = "update_pull_request_body"
)

// CheckboxChange is what SetPullRequestCheckbox asks for.
type CheckboxChange struct {
	// Index counts the description's task-list items from 0 (task_items.go).
	Index int
	// Text is the item as the client showed it.
	Text string
	// Checked is the state asked for.
	Checked bool
}

// CheckboxResult is what SetPullRequestCheckbox did.
type CheckboxResult struct {
	// Changed is false when the box was already so, and nothing was sent.
	Changed bool
	// Message says what happened, for people.
	Message string
}

// SetPullRequestCheckbox implements Service.
func (s *Store) SetPullRequestCheckbox(ctx context.Context, slug string, number int, r CheckboxChange) (CheckboxResult, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return CheckboxResult{}, err
	}
	if r.Index < 0 {
		return CheckboxResult{}, fmt.Errorf("%w: task index %d", ErrInvalidArgument, r.Index)
	}
	unlock, err := s.full.mergeLocks.lock(ctx, k)
	if err != nil {
		return CheckboxResult{}, err
	}
	defer unlock()
	id, body, err := s.freshBody(ctx, k)
	if err != nil {
		return CheckboxResult{}, fmt.Errorf("pull request #%d: cannot read its description: %w", k.number, err)
	}
	next, changed, why := SetTaskItem(body, r.Index, r.Text, r.Checked)
	if why != "" {
		// GitHub's description is not the client's: it must re-read.
		s.invalidateFull(k)
		return CheckboxResult{}, fmt.Errorf("%w: pull request #%d %s; look again and retry", ErrFailedPrecondition, k.number, why)
	}
	word := "Unchecked"
	if r.Checked {
		word = "Checked"
	}
	if !changed {
		// Someone else ticked it: the client may be showing the old state.
		s.invalidateFull(k)
		return CheckboxResult{Message: fmt.Sprintf("Task %d on #%d was already %s", r.Index+1, k.number, strings.ToLower(word))}, nil
	}
	what := fmt.Sprintf("changing task %d", r.Index+1)
	if _, err := s.stateWrite(ctx, k, what, queryUpdatePullRequestBody, map[string]any{"id": id, "body": next}, writeRefused); err != nil {
		return CheckboxResult{}, err
	}
	s.log.Info("gh pull request task set", "pr", k.String(), "index", r.Index, "checked", r.Checked)
	return CheckboxResult{Changed: true, Message: fmt.Sprintf("%s task %d on #%d", word, r.Index+1, k.number)}, nil
}

// freshBody reads k's node id and description from GitHub.
func (s *Store) freshBody(ctx context.Context, k fullKey) (id, body string, err error) {
	owner, name := splitSlug(k.slug)
	data, err := submitRead(ctx, s, queryPullRequestBody+"|"+k.String(), func(ctx context.Context) ([]byte, error) {
		return s.call(ctx, queryPullRequestBody, map[string]any{"owner": owner, "name": name, "number": k.number})
	})
	var pe *PartialError
	if errors.As(err, &pe) {
		return "", "", pe.Unwrap()
	}
	if err != nil {
		return "", "", err
	}
	var d struct {
		Repository *struct {
			PullRequest *struct {
				ID   string  `json:"id"`
				Body *string `json:"body"`
			} `json:"pullRequest"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return "", "", fmt.Errorf("decode description: %w", err)
	}
	if d.Repository == nil || d.Repository.PullRequest == nil || d.Repository.PullRequest.ID == "" {
		return "", "", ErrNotFound
	}
	p := d.Repository.PullRequest
	if p.Body != nil {
		body = *p.Body
	}
	return p.ID, body, nil
}

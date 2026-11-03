package threadtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// PullRequestOwner records "PullRequestOwner <id> <slugs,> <number>" and answers
// thread.LinkOwner over the fake's threads, as the store does.
func (f *Fake) PullRequestOwner(_ context.Context, id string, slugs []string, number int) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record(fmt.Sprintf("PullRequestOwner %s %s %d", id, strings.Join(slugs, ","), number)); err != nil {
		return "", err
	}
	if _, err := f.get(id); err != nil {
		return "", err
	}
	return thread.LinkOwner(id, slugs, number, func(t string) ([]thread.LinkedPullRequest, bool) {
		s, ok := f.byID[t]
		return s.LinkedPullRequests, ok
	}), nil
}

// AddNote records "AddNote <id> <text>" and appends a note item, as ShowHTML appends
// its card.
func (f *Fake) AddNote(_ context.Context, id, text string) (thread.Item, error) {
	f.mu.Lock()
	if err := f.record("AddNote " + id + " " + text); err != nil {
		f.mu.Unlock()
		return thread.Item{}, err
	}
	if _, err := f.get(id); err != nil {
		f.mu.Unlock()
		return thread.Item{}, err
	}
	if strings.TrimSpace(text) == "" {
		f.mu.Unlock()
		return thread.Item{}, fmt.Errorf("%w: a note needs text", thread.ErrInvalidArgument)
	}
	f.next++
	it, ev := f.appendItem(id, thread.Item{ID: fmt.Sprintf("note-%d", f.next), Kind: thread.KindNote, Text: text})
	f.mu.Unlock()
	bus.Publish(f.bus, ev)
	return it, nil
}

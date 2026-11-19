package api

import (
	"context"
	"errors"
	"maps"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Snoozing a thread until an event (internal/store/thread/snooze_event.go,
// docs/notes/snooze-until-event.md).

// snoozeUntilEvent is Snooze with an event. A thread asking it of itself needs no deferral:
// a snooze cuts nothing off.
func (h *Thread) snoozeUntilEvent(ctx context.Context, m *v1.SnoozeThreadRequest) (*connect.Response[v1.SnoozeThreadResponse], error) {
	if m.GetUntil() != nil || m.GetSave() {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("give an event, until or save, not two"))
	}
	ev := m.GetEvent()
	s, err := h.store.SnoozeUntilEvent(thread.AskedBy(ctx, m.GetByThreadId()), m.GetId(), thread.EventSnooze{
		PullRequest: ev.GetPullRequest(), Condition: thread.Condition(ev.GetCondition()), Plugin: ev.GetPlugin(), Args: maps.Clone(ev.GetArgs()),
	})
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SnoozeThreadResponse{Thread: threadToProto(s)}), nil
}

// SnoozeEvents lists what a thread can be snoozed until now.
func (h *Thread) SnoozeEvents(ctx context.Context, req *connect.Request[v1.SnoozeEventsRequest]) (*connect.Response[v1.SnoozeEventsResponse], error) {
	evs, err := h.store.SnoozeEvents(ctx, req.Msg.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	out := &v1.SnoozeEventsResponse{RecentPlugins: evs.RecentPlugins}
	for _, p := range evs.PullRequests {
		pr := &v1.SnoozePullRequestEvents{Target: p.Target, Number: int32(p.Number), Title: p.Title}
		for _, c := range p.Conditions {
			pr.Conditions = append(pr.Conditions, string(c))
		}
		out.PullRequests = append(out.PullRequests, pr)
	}
	for _, p := range evs.Plugins {
		out.Plugins = append(out.Plugins, &v1.SnoozePluginEvent{Target: p.Target, Title: p.Title, PluginName: p.PluginName, Args: maps.Clone(p.Args)})
	}
	return connect.NewResponse(out), nil
}

// snoozeEventToProto maps Thread.SnoozeEvent; nil stays nil.
func snoozeEventToProto(e *thread.SnoozeEvent) *v1.ThreadSnoozeEvent {
	if e == nil {
		return nil
	}
	return &v1.ThreadSnoozeEvent{
		Kind: string(e.Kind), Target: e.Target, Condition: string(e.Condition), Args: maps.Clone(e.Args), Title: e.Title,
		PluginName: e.PluginName, Label: e.Label(), WaitingFor: e.WaitingFor(), Since: timestamp(e.Since),
	}
}

package plugin

import (
	"context"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// ownersOnly answers Owner from a map; the rest is unused here.
type ownersOnly map[string]string

func (o ownersOnly) Owner(id string) (string, bool) { v, ok := o[id]; return v, ok }
func (ownersOnly) Create(context.Context, string, ThreadSpec) (pluginsdk.PluginThread, error) {
	return pluginsdk.PluginThread{}, nil
}
func (ownersOnly) Send(context.Context, string, string) error { return nil }
func (ownersOnly) Archive(context.Context, string) error      { return nil }
func (ownersOnly) Owned(string) []pluginsdk.PluginThread      { return nil }
func (ownersOnly) LiveOwners() []string                       { return nil }

type termOwners map[string]string

func (o termOwners) Owner(id string) (string, bool) { v, ok := o[id]; return v, ok }
func (termOwners) Create(context.Context, string, TerminalSpec) (pluginsdk.PluginTerminal, error) {
	return pluginsdk.PluginTerminal{}, nil
}
func (termOwners) Close(context.Context, string) error     { return nil }
func (termOwners) Owned(string) []pluginsdk.PluginTerminal { return nil }

// A view may show the plugin's own threads and terminals, and ids the host does not know
// (shown gone), never another owner's; a terminal node's buttons act.
func TestOwnedNodes(t *testing.T) {
	m := &Manager{opts: Options{
		Threads:   ownersOnly{"s-mine": "plugin:p", "s-user": "", "s-other": "plugin:q"},
		Terminals: termOwners{"t-mine": "p", "t-shell": ""},
	}}
	a := &actor{m: m, name: "p"}
	term := ui.NewTerminal("term", "t-mine")
	term.Terminal.Actions = []ui.Button{ui.EventButton("restart", "Restart", "restart")}
	ok := ui.View{Nodes: []ui.Node{ui.NewThread("th", "s-mine"), ui.NewThread("gone", "s-gone"), term}}
	if errs := a.ownedNodeProblems(&ok); len(errs) != 0 {
		t.Errorf("own nodes: %q", errs)
	}
	if el := buildIndex(&ok).elements["restart"]; el.kind != pluginsdk.ActClick || el.actionName() != "restart" {
		t.Errorf("terminal button element = %+v", el)
	}
	bad := ui.View{Nodes: []ui.Node{ui.NewThread("a", "s-user"), ui.NewThread("b", "s-other"), ui.NewTerminal("c", "t-shell")}}
	errs := a.ownedNodeProblems(&bad)
	if len(errs) != 3 || !strings.Contains(errs[0], "s-user is not one of plugin p's threads") || !strings.Contains(errs[2], "t-shell is not one of plugin p's terminals") {
		t.Errorf("others' nodes: %q", errs)
	}
}

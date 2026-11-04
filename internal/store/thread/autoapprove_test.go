package thread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// askFixture is the bash capture with its can_use_tool as real ones read (2.1.316: a call
// no rule decided), command as its command, then edit's changes; before lines go ahead of it.
func askFixture(t *testing.T, command string, edit func(req map[string]any), before ...string) string {
	t.Helper()
	b, err := os.ReadFile(fixturePath("bash"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	out := make([]string, 0, len(lines)+len(before))
	found := false
	for _, l := range lines {
		if !strings.Contains(l, `"can_use_tool"`) {
			out = append(out, l)
			continue
		}
		found = true
		var frame map[string]any
		if err := json.Unmarshal([]byte(l), &frame); err != nil {
			t.Fatal(err)
		}
		req := frame["request"].(map[string]any)
		req["input"] = map[string]any{"command": command, "description": "Run it"}
		req["decision_reason"], req["decision_reason_type"] = "This command requires approval", "other"
		delete(req, "permission_suggestions")
		if edit != nil {
			edit(req)
		}
		nl, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		out = append(append(out, before...), string(nl))
	}
	if !found {
		t.Fatal("the capture has no can_use_tool")
	}
	path := filepath.Join(t.TempDir(), "ask.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(out, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// fakeVerbs stands in for command.Registry.ApprovedVerb.
func fakeVerbs(line string) string {
	return map[string]string{
		"code-foundry action run build": "action.run",
		"code-foundry thread list":      "thread.list",
		"code-foundry thread report x":  "thread.report",
	}[line]
}

func withVerbs(o *Options) { o.ApprovedVerb = fakeVerbs }

// answered is the allow the daemon sent for the fixture's request, nil when it sent none.
func answered(e *env) map[string]any {
	for _, m := range e.sent() {
		if m["type"] != "control_response" {
			continue
		}
		res, _ := m["response"].(map[string]any)
		if inner, _ := res["response"].(map[string]any); inner != nil && inner["behavior"] != nil {
			return inner
		}
	}
	return nil
}

// wantApproved: the fixture's turn ran to its end on the daemon's answer, which echoes
// the input, with no request item and no attention for one, and the tool row as usual.
func wantApproved(t *testing.T, e *env, s Thread, command string) {
	t.Helper()
	e.waitFor(s.ID, "the turn's end", func(s Thread) bool { return s.StatusReason == "finished" })
	res := answered(e)
	if res == nil || res["behavior"] != "allow" {
		t.Fatalf("answer %v, want allow", res)
	}
	if in, _ := res["updatedInput"].(map[string]any); in["command"] != command {
		t.Errorf("updatedInput %v, want the input echoed", res["updatedInput"])
	}
	snap := e.items(s.ID)
	if len(snap.Pending) != 0 {
		t.Errorf("pending %+v", snap.Pending)
	}
	if slices.ContainsFunc(snap.Items, func(it Item) bool { return it.Kind == KindPermission }) {
		t.Errorf("a request item was made: %+v", snap.Items)
	}
	if !slices.ContainsFunc(snap.Items, func(it Item) bool { return it.Kind == KindToolCall && it.Tool.Name == "Bash" }) {
		t.Errorf("no tool row: %+v", snap.Items)
	}
}

// wantAsked: the request waits for the user.
func wantAsked(t *testing.T, e *env, s Thread) {
	t.Helper()
	e.waitFor(s.ID, "the request", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	if p := e.items(s.ID).Pending; len(p) != 1 {
		t.Fatalf("pending %+v, want the one request", p)
	}
	if res := answered(e); res != nil {
		t.Errorf("answered %v without the user", res)
	}
}

// Who gets what: an auto thread the approved verbs, every mode the protocol's.
func TestApprovedVerbByMode(t *testing.T) {
	const run, list, report, other = "code-foundry action run build", "code-foundry thread list", "code-foundry thread report x", "rm -rf ~"
	tests := []struct {
		name    string
		mode    PermissionMode
		command string
		want    bool
	}{
		{"auto, approved verb", PermissionAuto, run, true},
		{"auto, protocol verb", PermissionAuto, list, true},
		{"auto, anything else", PermissionAuto, other, false},
		{"supervised, approved verb", PermissionSupervised, run, false},
		{"supervised, protocol verb", PermissionSupervised, list, true},
		{"supervised, protocol report", PermissionSupervised, report, true},
		{"supervised, anything else", PermissionSupervised, other, false},
		{"accept edits, approved verb", PermissionAcceptEdits, run, false},
		{"accept edits, protocol verb", PermissionAcceptEdits, list, true},
		{"default, approved verb", PermissionDefault, run, false},
		{"default, protocol verb", PermissionDefault, list, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, askFixture(t, tc.command, nil), nil, withVerbs)
			s := e.create(CreateOptions{PermissionMode: tc.mode, InitialPrompt: "go"})
			if tc.want {
				wantApproved(t, e, s, tc.command)
			} else {
				wantAsked(t, e, s)
			}
		})
	}
}

// Only a request nothing decided: a rule, a policy, a check or a hook that wants a person
// outranks the list, and so does a tool call that is more than the command.
func TestApprovedVerbOnlyForAPlainAsk(t *testing.T) {
	const run = "code-foundry action run build"
	set := func(k string, v any) func(map[string]any) {
		return func(req map[string]any) { req[k] = v }
	}
	input := func(k string, v any) func(map[string]any) {
		return func(req map[string]any) { req["input"].(map[string]any)[k] = v }
	}
	tests := []struct {
		name string
		edit func(map[string]any)
		want bool
	}{
		{"no reason at all", func(req map[string]any) { delete(req, "decision_reason_type") }, true},
		{"server policy says no", set("server_policy_ask_only", false), true},
		{"another reason's words", set("decision_reason", "Auto mode can't check actions in this session, so this one needs your approval"), true},
		{"a subagent's", set("agent_id", "a1"), true},
		{"in the background", input("run_in_background", true), true},
		{"with a timeout", input("timeout", 1000), true},
		{"an ask rule", set("decision_reason_type", "rule"), false},
		{"a safety check", set("decision_reason_type", "safetyCheck"), false},
		{"a hook", set("decision_reason_type", "hook"), false},
		{"the classifier", set("decision_reason_type", "classifier"), false},
		{"subcommands", set("decision_reason_type", "subcommandResults"), false},
		{"a mode", set("decision_reason_type", "mode"), false},
		{"a reason this version does not know", set("decision_reason_type", "somethingNew"), false},
		{"an org ceiling", set("decision_reason_code", "org_ask_ceiling"), false},
		{"a matched ask rule", set("matched_ask_rule", map[string]any{"source": "policySettings", "tool_name": "Bash"}), false},
		{"server policy ask only", set("server_policy_ask_only", true), false},
		{"for a person only", set("classifier_approvable", false), false},
		{"a blocked path", set("blocked_path", "/etc/passwd"), false},
		{"needs the user's interaction", set("requires_user_interaction", true), false},
		{"another tool", set("tool_name", "Write"), false},
		{"sandbox off", input("dangerouslyDisableSandbox", true), false},
		{"an input field this version does not know", input("somethingNew", 1), false},
		{"a command that is no string", input("command", []string{"code-foundry"}), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, askFixture(t, run, tc.edit), nil, withVerbs)
			s := e.create(CreateOptions{PermissionMode: PermissionAuto, InitialPrompt: "go"})
			if tc.want {
				wantApproved(t, e, s, run)
			} else {
				wantAsked(t, e, s)
			}
		})
	}
}

// Without the option every request goes to the user, the protocol's too.
func TestApprovedVerbUnset(t *testing.T) {
	e := newFixtureEnvAt(t, askFixture(t, "code-foundry thread list", nil), nil)
	s := e.create(CreateOptions{PermissionMode: PermissionAuto, InitialPrompt: "go"})
	wantAsked(t, e, s)
}

// The mode is read at the request, so a live switch counts at once, both ways.
func TestApprovedVerbFollowsALiveSwitch(t *testing.T) {
	const run = "code-foundry action run build"
	tests := []struct {
		name     string
		from, to PermissionMode
		want     bool
	}{
		{"auto to supervised", PermissionAuto, PermissionSupervised, false},
		{"auto to accept edits", PermissionAuto, PermissionAcceptEdits, false},
		{"supervised to auto", PermissionSupervised, PermissionAuto, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, askFixture(t, run, nil), nil, withVerbs)
			s := e.connected(CreateOptions{PermissionMode: tc.from})
			if _, err := e.m.SetPermissionMode(e.ctx(), s.ID, tc.to); err != nil {
				t.Fatal(err)
			}
			if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "go"}); err != nil {
				t.Fatal(err)
			}
			if tc.want {
				wantApproved(t, e, s, run)
			} else {
				wantAsked(t, e, s)
			}
		})
	}
}

// Claude can leave auto mode itself (a policy that disables it, 2.1.316: it reports
// default right after its init), and the thread is then supervised for this too.
func TestApprovedVerbFollowsClaudesOwnModeChange(t *testing.T) {
	status := `{"type":"system","subtype":"status","status":null,"permissionMode":"default","uuid":"u","session_id":"s"}`
	e := newFixtureEnvAt(t, askFixture(t, "code-foundry action run build", nil, status), nil, withVerbs)
	s := e.create(CreateOptions{PermissionMode: PermissionAuto, InitialPrompt: "go"})
	wantAsked(t, e, s)
	if got := e.snapshot(s.ID).PermissionMode; got != PermissionSupervised {
		t.Errorf("mode %v, want supervised", got)
	}
}

func TestProtocolAllowedToolsAreTheVerbs(t *testing.T) {
	if len(ProtocolAllowedTools) != len(ProtocolVerbs) {
		t.Fatalf("%d rules for %d verbs", len(ProtocolAllowedTools), len(ProtocolVerbs))
	}
	for i, v := range ProtocolVerbs {
		want := "Bash(code-foundry " + strings.ReplaceAll(v, ".", " ") + ":*)"
		if ProtocolAllowedTools[i] != want {
			t.Errorf("rule %d = %q, want %q", i, ProtocolAllowedTools[i], want)
		}
	}
}

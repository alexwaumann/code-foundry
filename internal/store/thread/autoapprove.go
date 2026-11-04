package thread

import (
	"encoding/json"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// The daemon answers some of Claude's requests itself (docs/notes/auto-approve-verbs.md).
// A managed settings file with allowManagedPermissionRulesOnly makes Claude ignore
// --allowedTools, so the rules cannot cover a thread there: Claude asks, and the request
// comes here first. What may run is command.Registry.ApprovedVerb's to say. Who gets it is
// decided here, on the mode at the time of the request, so a live switch counts at once.
//
// This sees requests only. In auto mode a working classifier allows or denies a call with
// no request at all (a denial is system/permission_denied, after the fact), so nothing here
// can overrule it, and a denied verb stays denied.

// bashInputs are the Bash tool's input fields that change nothing about what is approved.
// Any other asks, dangerouslyDisableSandbox above all, and so does one a later Claude adds.
var bashInputs = []string{"command", "description", "timeout", "run_in_background"}

// approvedVerb returns the verb of a request the daemon answers itself, or "": an auto
// thread's approved verbs, and in every mode the protocol's. Only where nothing decided
// that a person should answer (AskedOnPurpose): an ask rule, a policy or a safety check
// outranks the list, on a managed machine above all.
func (r *runner) approvedVerb(req *claudestream.PermissionRequest) string {
	if r.m.opts.ApprovedVerb == nil || req.ToolName != "Bash" || req.AskedOnPurpose() {
		return ""
	}
	verb := r.m.opts.ApprovedVerb(bashCommand(req.Input))
	if verb == "" || slices.Contains(ProtocolVerbs, verb) {
		return verb
	}
	if s, ok := r.m.Snapshot().Thread(r.id); !ok || s.PermissionMode != PermissionAuto {
		return ""
	}
	return verb
}

// bashCommand is the command line of a Bash tool's input, "" when the input holds
// anything but bashInputs.
func bashCommand(input json.RawMessage) string {
	var in map[string]json.RawMessage
	if err := json.Unmarshal(input, &in); err != nil {
		return ""
	}
	for k := range in {
		if !slices.Contains(bashInputs, k) {
			return ""
		}
	}
	var line string
	if err := json.Unmarshal(in["command"], &line); err != nil {
		return ""
	}
	return line
}

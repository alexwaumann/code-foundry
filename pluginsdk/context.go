package pluginsdk

// Typed SetContext: the host's when clauses read a fact as <plugin>.<key>.

// ContextScope is what a context fact is for: every thread and project (the zero
// value), one thread (ForThread) or one project (ForProject). A when clause reads the
// thread's fact first, then the project's, then the global one.
type ContextScope struct {
	ThreadID, ProjectID string
}

// ForThread scopes a fact to one thread.
func ForThread(id string) ContextScope { return ContextScope{ThreadID: id} }

// ForProject scopes a fact to one project.
func ForProject(id string) ContextScope { return ContextScope{ProjectID: id} }

func (h *Host) setContext(key string, value any, scope []ContextScope) error {
	p := ContextParams{Key: key, Value: value}
	if len(scope) > 0 {
		p.ThreadID, p.ProjectID = scope[0].ThreadID, scope[0].ProjectID
	}
	return h.SetContext(p)
}

// SetContextString sets a string fact (`<plugin>.<key> == "deploying"`), globally or for
// the scope given (one at most).
func (h *Host) SetContextString(key, value string, scope ...ContextScope) error {
	return h.setContext(key, value, scope)
}

// SetContextBool sets a boolean fact (`<plugin>.<key>`, `!<plugin>.<key>`).
func (h *Host) SetContextBool(key string, value bool, scope ...ContextScope) error {
	return h.setContext(key, value, scope)
}

// SetContextInt sets a number fact (`<plugin>.<key> > 0`).
func (h *Host) SetContextInt(key string, value int, scope ...ContextScope) error {
	return h.setContext(key, value, scope)
}

// SetContextStrings sets a list fact (`"x" in <plugin>.<key>`), at most 100 values.
func (h *Host) SetContextStrings(key string, values []string, scope ...ContextScope) error {
	if values == nil {
		values = []string{}
	}
	return h.setContext(key, values, scope)
}

// ClearContext removes a fact (it reads as null again).
func (h *Host) ClearContext(key string, scope ...ContextScope) error {
	return h.setContext(key, nil, scope)
}

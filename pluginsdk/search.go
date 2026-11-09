package pluginsdk

// Query returns a search act's query (ActSearch: what the user typed into a picker,
// trimmed), and "" for any other act. Answer it with a view that echoes it:
//
//	field.WithResults(act.Query(), matches...)
func (a SurfaceAct) Query() string {
	if a.Kind != ActSearch {
		return ""
	}
	q, _ := a.Value.(string)
	return q
}

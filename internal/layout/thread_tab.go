package layout

// ThreadTabSpace is the id of the space holding thread's own tab (a kept tab or a preview),
// or "" when it has none open. Its linked tabs (diff, files, terminals) do not count.
func (st *State) ThreadTabSpace(thread string) string {
	id := threadTabID(st, thread)
	if id == "" {
		return ""
	}
	sp, _, _ := st.FindTab(id)
	if sp == nil {
		return ""
	}
	return sp.ID
}

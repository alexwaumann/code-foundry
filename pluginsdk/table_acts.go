package pluginsdk

// ActSort: the user clicked a sortable column's header of a table (ui.Table; the host
// shapes it from its copy of the view, like a tab or a select). Key is the column's key,
// Node the table's key, Action "sort", and Value the direction asked for, "asc" or "desc"
// (SurfaceAct.Descending): the sorted column's other direction, else the column's
// SortFirst. It carries no Data and no form values. Answer with a view whose rows are in
// that order and whose Table.Sort names the column and the direction.
const ActSort = "sort"

// Descending reports whether a sort act asks for the descending order (false for an
// ascending one and for any other act).
func (a SurfaceAct) Descending() bool {
	s, _ := a.Value.(string)
	return a.Kind == ActSort && s == "desc"
}

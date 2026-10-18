package guide

import (
	"fmt"
	"io"
	"strings"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// WriteSettings lists every field of the settings schema (SettingsService.GetSchema),
// one entry each, under its group in groups' order: key, title, description, type and
// default. Keybinding fields get one short line each (the command they bind is
// described with the commands). A field of a group not in groups follows under its
// group id.
func WriteSettings(w io.Writer, groups []*v1.SettingGroup, fields []*v1.SettingField) {
	byGroup := map[string][]*v1.SettingField{}
	for _, f := range fields {
		byGroup[f.GetGroup()] = append(byGroup[f.GetGroup()], f)
	}
	seen := map[string]bool{}
	write := func(id, title, desc string) {
		list := byGroup[id]
		seen[id] = true
		if len(list) == 0 {
			return
		}
		fmt.Fprintf(w, "\n## %s (`[%s]`)\n\n", title, id)
		if desc != "" {
			fmt.Fprintf(w, "%s\n\n", oneLine(desc))
		}
		for _, f := range list {
			if f.GetType() == v1.SettingType_SETTING_TYPE_KEYBINDING {
				fmt.Fprintf(w, "- `%s` %s: %s\n", f.GetKey(), oneLine(f.GetTitle()), settingDefault(f))
				continue
			}
			fmt.Fprintf(w, "- `%s` **%s**", f.GetKey(), oneLine(f.GetTitle()))
			if d := oneLine(f.GetDescription()); d != "" {
				fmt.Fprintf(w, ": %s", d)
			}
			fmt.Fprintf(w, "\n  Type: %s. Default: %s.", settingType(f), settingDefault(f))
			if f.GetRestartRequired() {
				fmt.Fprint(w, " Applies after a daemon restart.")
			}
			fmt.Fprintln(w)
		}
	}
	for _, g := range groups {
		write(g.GetId(), g.GetTitle(), g.GetDescription())
	}
	for _, f := range fields {
		if !seen[f.GetGroup()] {
			write(f.GetGroup(), f.GetGroup(), "")
		}
	}
}

// SettingTypeName is a setting type's lower-case name: "string", "int", "bool", "enum",
// "path", "keybinding".
func SettingTypeName(t v1.SettingType) string {
	return strings.ToLower(strings.TrimPrefix(t.String(), "SETTING_TYPE_"))
}

// settingType is the type with what it accepts: an enum's values (with their labels),
// an int's bounds and unit.
func settingType(f *v1.SettingField) string {
	name := SettingTypeName(f.GetType())
	switch f.GetType() {
	case v1.SettingType_SETTING_TYPE_ENUM:
		vals := make([]string, 0, len(f.GetEnumValues()))
		labels := f.GetEnumLabels()
		for i, v := range f.GetEnumValues() {
			s := "`" + v + "`"
			if v == "" {
				s = "`\"\"`"
			}
			if i < len(labels) && labels[i] != "" && labels[i] != v {
				s += " (" + labels[i] + ")"
			}
			vals = append(vals, s)
		}
		return name + ", one of " + strings.Join(vals, ", ")
	case v1.SettingType_SETTING_TYPE_INT:
		r := fmt.Sprintf("%s, %d to %d", name, f.GetMin(), f.GetMax())
		if u := f.GetUnit(); u != "" {
			r += " " + u
		}
		return r
	case v1.SettingType_SETTING_TYPE_BOOL:
		return name + " (`true` or `false`)"
	}
	return name
}

// settingDefault is "`value`", or "none" for an empty default.
func settingDefault(f *v1.SettingField) string {
	if d := f.GetDefaultValue(); d != "" {
		return "`" + d + "`"
	}
	if f.GetType() == v1.SettingType_SETTING_TYPE_KEYBINDING {
		return "no default chord"
	}
	return "none (empty)"
}

/**
 * The hello demo's pickers as the real plugin renders them (plugins/examples/hello/picker.go):
 * the Form tab's reviewers (people with avatars) and the Layout toolbar's branch filter. The
 * captured views have nothing picked and no search; mock/plugins.ts puts these fields in
 * their place after each act.
 */

interface Option {
  key: string;
  value: string;
  label: string;
  group?: string;
  detail?: string;
  avatar?: string;
  icon?: string;
  disabled?: boolean;
}

const PEOPLE = [
  { id: "ada", name: "Ada Lovelace", initials: "A", team: "you" },
  { id: "alan", name: "Alan Turing", initials: "A", team: "platform" },
  { id: "alejandra", name: "Alejandra Ruiz", initials: "A", team: "platform" },
  { id: "alessio", name: "Alessio Conti", initials: "A", team: "design" },
  { id: "grace", name: "Grace Hopper", initials: "G", team: "infra" },
  { id: "kim", name: "Kim Park", initials: "K", team: "design" },
  { id: "margaret", name: "Margaret Hamilton", initials: "M", team: "infra" },
];
const RECENT_PEOPLE = ["ada", "kim"];
const BRANCHES = ["main", "cf/fix", "cf/retry", "cf/sidebar", "cf/plugin-picker", "release/0.30"];
const RECENT_BRANCHES = ["main", "cf/fix"];

const holds = (name: string, query: string) => name.toLowerCase().includes(query.trim().toLowerCase());

function personOpt(prefix: string, p: (typeof PEOPLE)[number]): Option {
  return { key: prefix + p.id, value: p.id, label: p.name, avatar: p.initials, detail: p.team };
}

/** The picker's search with its results, as WithResults sets it (no query: no results). */
function search(key: string, event: string, placeholder: string, query: string, results: Option[]) {
  return { key, event, placeholder, ...(query ? { query } : {}), ...(results.length > 0 ? { results } : {}) };
}

/** The Form tab's reviewers picker: picked, the saved reviewers; query, the last search. */
export function reviewersField(picked: readonly string[], query: string): Record<string, unknown> {
  const options: Option[] = [];
  for (const id of picked) {
    const p = PEOPLE.find((x) => x.id === id);
    if (p) options.push({ ...personOpt("f-rev-sel-", p), group: "Selected" });
  }
  for (const id of RECENT_PEOPLE) {
    const p = PEOPLE.find((x) => x.id === id);
    if (p && !picked.includes(id)) options.push({ ...personOpt("f-rev-rec-", p), group: "Recent" });
  }
  options.push({ key: "f-rev-rec-bot", value: "bot", label: "Release bot", icon: "bot", detail: "cannot review", group: "Recent", disabled: true });
  const results = query ? PEOPLE.filter((p) => holds(p.name, query)).map((p) => ({ ...personOpt("f-rev-match-", p), group: "Matches" })) : [];
  return {
    key: "f-reviewers",
    name: "reviewers",
    label: "Reviewers",
    description: "A picker: type 2+ characters and the plugin searches.",
    select: {
      options,
      multiple: true,
      ...(picked.length > 0 ? { value: [...picked] } : {}),
      placeholder: "No one yet",
      search: search("f-reviewers-search", "search-people", "Search people", query, results),
    },
  };
}

/** The Layout toolbar's branch picker: picked, the branches the runs are filtered by. */
export function branchField(picked: readonly string[], query: string): Record<string, unknown> {
  const opt = (prefix: string, b: string): Option => ({ key: prefix + b.replaceAll("/", "-"), value: b, label: b, icon: "git-branch" });
  const options: Option[] = [
    ...picked.map((b) => ({ ...opt("layout-br-sel-", b), group: "Selected" })),
    ...RECENT_BRANCHES.filter((b) => !picked.includes(b)).map((b) => ({ ...opt("layout-br-rec-", b), group: "Recent" })),
  ];
  const results = query ? BRANCHES.filter((b) => holds(b, query)).map((b) => opt("layout-br-match-", b)) : [];
  return {
    key: "layout-branch",
    name: "branch",
    label: "Branch",
    change: { event: "layout-branch" },
    select: {
      options,
      ...(picked.length > 0 ? { value: [...picked] } : {}),
      multiple: true,
      search: search("layout-branch-search", "search-branches", "Search branches", query, results),
    },
  };
}

/** A multiple select's value from an act's values. */
export function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

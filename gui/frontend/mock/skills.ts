/**
 * The Skills marketplace in the mock daemon (docs/notes/skills-3-api.md): one marketplace
 * Claude Code "has", ai-marketplace (cof-primary/ai-marketplace), with three enterprise
 * plugins and about forty standalone skills in both tiers; what is installed of them and a
 * local skill; SkillService (Search, Installed, Registries) and the skill.* commands, each
 * taking a few 250 ms steps and publishing a new epoch like the daemon's re-read.
 *
 * Installed at start: secure-coding (plugin, enabled, up to date), enterprise-data (plugin,
 * 1.3.2 installed: Update to 1.4.0), pr-review (enabled), sql-helper (disabled),
 * jira-sync (needs setup), incident-postmortem (an update), and the local skill my-notes.
 *
 * Controls (POST /__mock/skills?…, mock/server.ts): fail=skill.install&error=… (that
 * command fails with the message until cleared with an empty error), registries=none|default
 * (Claude Code without the marketplace), listError=… (`marketplace list` failed: the
 * registries' error), pluginsError=…, epoch=1 (a read, as the hourly refresh makes).
 * GET /__mock/skills: { calls, epoch, installed }.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import {
  InstalledSkillState,
  SkillEntryState,
  SkillKind,
  SkillTier,
  type InstalledSkillSchema,
  type ListInstalledSkillsResponseSchema,
  type ListSkillRegistriesResponseSchema,
  type SearchSkillsRequest,
  type SearchSkillsResponseSchema,
  type SkillEntrySchema,
  type SkillEventSchema,
} from "../src/gen/codefoundry/v1/skill_pb";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";

type EntryInit = MessageInitShape<typeof SkillEntrySchema>;
type InstalledInit = MessageInitShape<typeof InstalledSkillSchema>;
export type SkillEventInit = MessageInitShape<typeof SkillEventSchema>;

export const SKILL_MARKETPLACE = "ai-marketplace";
export const SKILL_MARKETPLACE_REPO = "cof-primary/ai-marketplace";
const CHECKOUT = `/Users/dev/.claude/plugins/marketplaces/${SKILL_MARKETPLACE}`;
const SKILLS_DIR = "/Users/dev/.claude/skills";
const DISABLED_DIR = "/Users/dev/.code-foundry/skills/disabled";
const PLUGIN_CACHE = `/Users/dev/.claude/plugins/cache/${SKILL_MARKETPLACE}`;
const STEP_MS = 250;
/** The daemon's RestartWarning. */
const RESTART_WARNING = "Threads that are running keep it until they restart. New threads pick this up at once.";

type Kind = "plugin" | "skill";
type Tier = "enterprise" | "community";

interface Entry {
  kind: Kind;
  tier: Tier;
  name: string;
  description: string;
  by: string;
  /** A plugin's index version; a skill's YYYYMMDD of lastUpdated. */
  version: string;
  declaredVersion: string;
  lastUpdated: Date;
  path: string;
  keywords: string[];
  skills: string[];
  /** Repo-relative. */
  setupScript: string;
}

const day = (s: string) => new Date(`${s}T10:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

function plugin(name: string, by: string, version: string, date: string, description: string, keywords: string[], skills: string[]): Entry {
  return { kind: "plugin", tier: "enterprise", name, description, by, version, declaredVersion: "", lastUpdated: day(date), path: `enterprise/c1-claude-code-marketplace/${name}`, keywords, skills: [...skills].sort(), setupScript: "" };
}

/** A skill under <tier>/skills/[<group>/]<name>; setup is install.sh, setup.sh or scripts/… at its root. */
function skill(tier: Tier, group: string, name: string, by: string, date: string, description: string, keywords: string[], setup = "", declared = ""): Entry {
  const path = `${tier}/skills/${group ? `${group}/` : ""}${name}`;
  const d = day(date);
  return { kind: "skill", tier, name, description, by, version: ymd(d), declaredVersion: declared, lastUpdated: d, path, keywords, skills: [], setupScript: setup ? `${path}/${setup}` : "" };
}

function seedEntries(): Entry[] {
  return [
    plugin("enterprise-data", "Data Platform", "1.4.0", "2026-10-14", "Query the data warehouse, browse the catalog and trace a column's lineage from Claude Code.", ["sql", "warehouse", "data"], ["catalog", "query-warehouse", "lineage", "data-quality"]),
    plugin("secure-coding", "AppSec Guild", "2.1.0", "2026-09-30", "Threat modelling, secret scanning and dependency review that follow the company's secure coding standard.", ["security", "appsec"], ["threat-model", "secrets-scan", "dependency-review"]),
    plugin("release-train", "Release Engineering", "0.9.3", "2026-10-08", "Cut releases on the train: changelog, release notes, version bumps, the deploy checklist and a rollback plan.", ["release", "deploy"], ["changelog", "release-notes", "version-bump", "deploy-checklist", "rollback-plan"]),

    skill("enterprise", "", "pr-review", "Code Quality Guild", "2026-09-12", "Review a pull request against the team's checklist: tests, naming, error handling and the change's blast radius.", ["review", "pull request"], "", "2.1.0"),
    skill("enterprise", "data", "sql-helper", "Jane Doe", "2026-08-21", "Write and explain SQL for the warehouse, with the house style for CTEs and joins.", ["sql", "postgres"], "scripts/setup.sh"),
    skill("enterprise", "data", "dbt-model", "Data Platform", "2026-09-03", "Scaffold a dbt model with tests, docs and the right materialisation for its size.", ["dbt", "sql", "analytics"]),
    skill("enterprise", "data", "airflow-dag", "Data Platform", "2026-07-29", "Write an Airflow DAG that follows the scheduling, retry and alerting conventions.", ["airflow", "pipelines"]),
    skill("enterprise", "data", "pii-redactor", "Privacy Office", "2026-10-02", "Find personal data in logs, fixtures and test data and replace it with safe synthetic values.", ["privacy", "pii", "gdpr"]),
    skill("enterprise", "", "jira-sync", "Delivery Tools", "2026-10-11", "Keep Jira tickets in step with branches and pull requests: link, transition and comment.", ["jira", "tickets"], "install.sh", "1.2.0"),
    skill("enterprise", "", "incident-postmortem", "SRE", "2026-10-16", "Draft a blameless postmortem from the incident channel, the timeline and the graphs.", ["incident", "sre", "postmortem"]),
    skill("enterprise", "", "oncall-runbook", "SRE", "2026-09-25", "Turn an alert into a runbook entry with the checks, dashboards and escalation path.", ["oncall", "runbook", "sre"]),
    skill("enterprise", "", "terraform-review", "Cloud Platform", "2026-09-18", "Review a Terraform plan for drift, blast radius, tagging and cost before it is applied.", ["terraform", "iac", "review"], "setup.sh"),
    skill("enterprise", "", "k8s-manifest", "Cloud Platform", "2026-08-30", "Write Kubernetes manifests with resource limits, probes and the platform's labels.", ["kubernetes", "k8s", "yaml"]),
    skill("enterprise", "", "api-design", "Architecture Board", "2026-07-15", "Design a REST or gRPC API that follows the API guidelines: naming, pagination, errors and versioning.", ["api", "grpc", "rest"], "", "3.0.1"),
    skill("enterprise", "", "adr-writer", "Architecture Board", "2026-06-24", "Write an architecture decision record: context, options considered, decision and consequences.", ["adr", "architecture", "docs"]),
    skill("enterprise", "", "feature-flags", "Delivery Tools", "2026-09-09", "Add, roll out and clean up feature flags with the flag service's SDK.", ["flags", "rollout"]),
    skill("enterprise", "", "observability", "SRE", "2026-08-12", "Add structured logs, metrics and traces that land in the right dashboards.", ["logging", "metrics", "tracing"]),
    skill("enterprise", "", "accessibility-audit", "Design Systems", "2026-09-27", "Audit a screen against WCAG 2.2 AA and the design system's accessibility rules.", ["a11y", "wcag", "frontend"]),
    skill("enterprise", "", "design-tokens", "Design Systems", "2026-10-05", "Use the design system's tokens for colour, type and spacing instead of raw values.", ["design", "tokens", "css"]),
    skill("enterprise", "", "mobile-release", "Mobile Platform", "2026-08-05", "Prepare an iOS and Android release: build numbers, store notes and the phased rollout.", ["ios", "android", "release"], "scripts/install.sh"),
    skill("enterprise", "", "cost-review", "FinOps", "2026-07-21", "Estimate what a change costs to run and suggest cheaper instance types and storage classes.", ["cost", "cloud", "finops"]),
    skill("enterprise", "", "vendor-risk", "Third Party Risk", "2026-06-30", "Fill in the vendor risk questionnaire for a new library or SaaS from its docs.", ["compliance", "vendor"]),
    skill("enterprise", "", "test-plan", "Quality Engineering", "2026-09-21", "Write a test plan for a feature: risks, cases, data and what is automated.", ["testing", "qa"]),
    skill("enterprise", "", "load-test", "Quality Engineering", "2026-08-18", "Write a k6 load test with the platform's thresholds and run it against staging.", ["k6", "performance", "testing"], "install.sh"),
    skill("enterprise", "", "golden-path", "Developer Experience", "2026-10-13", "Start a new service on the golden path: template, pipeline, ownership and catalog entry.", ["scaffold", "service", "platform"]),

    skill("community", "", "haiku-writer", "", "2026-05-02", "Write commit messages as haiku. Five, seven, five.", ["fun", "git"]),
    skill("community", "", "regex-explainer", "Sam Patel", "2026-08-09", "Explain a regular expression piece by piece and suggest a clearer one.", ["regex"]),
    skill("community", "", "mermaid-diagrams", "Priya Raman", "2026-09-14", "Draw sequence, flow and entity diagrams in Mermaid from code or a description.", ["mermaid", "diagrams", "docs"]),
    skill("community", "", "git-archaeology", "Tom Becker", "2026-07-07", "Find why a line is the way it is: blame, log and the pull requests behind it.", ["git", "history"]),
    skill("community", "", "flaky-test-hunter", "Ana Lima", "2026-10-01", "Run a test many times, find the order or timing that makes it flaky, and propose a fix.", ["testing", "flaky"], "setup.sh"),
    skill("community", "", "readme-polish", "Chris Okafor", "2026-06-11", "Tidy a README: a one-line summary, quick start, examples and links that work.", ["docs", "readme"]),
    skill("community", "", "bash-strict", "Lee Wong", "2026-08-26", "Make shell scripts strict and portable: set -euo pipefail, quoting and shellcheck clean.", ["bash", "shell"]),
    skill("community", "", "pandas-tips", "Maria Rossi", "2026-07-30", "Rewrite slow pandas code with vectorised operations and the right dtypes.", ["python", "pandas", "data"]),
    skill("community", "", "typescript-strict", "Jordan Kim", "2026-09-19", "Turn on TypeScript's strict flags one at a time and fix what each finds.", ["typescript", "types"]),
    skill("community", "", "css-grid", "Elif Demir", "2026-05-27", "Lay out a page with CSS grid and subgrid instead of nested flex boxes.", ["css", "frontend"]),
    skill("community", "", "sql-formatter", "Jane Doe", "2026-08-02", "Format SQL to the community style: upper-case keywords, one column per line.", ["sql", "style"]),
    skill("community", "", "code-golf", "", "2026-04-18", "Make a function as short as possible, then explain why you should not ship it.", ["fun"]),
    skill("community", "", "meeting-notes", "Rita Novak", "2026-09-05", "Turn a meeting transcript into decisions, owners and dates.", ["notes", "meetings"]),
    skill("community", "", "dockerfile-slim", "Ben Carter", "2026-10-09", "Shrink a Docker image with multi-stage builds, a distroless base and fewer layers.", ["docker", "containers"], "scripts/setup.sh"),
    skill("community", "", "rust-borrowck", "Ola Nordmann", "2026-06-16", "Explain a borrow checker error and the smallest change that satisfies it.", ["rust"]),
    skill("community", "", "go-errors", "Ivan Petrov", "2026-09-29", "Wrap Go errors with %w, add context once, and check them with errors.Is and errors.As.", ["go", "errors"]),
    skill("community", "", "emoji-commit", "", "2026-03-08", "Pick a gitmoji for a commit from its diff.", ["git", "fun"]),
  ];
}

/** What is installed of an entry, or a local skill. */
interface Inst {
  kind: Kind;
  name: string;
  /** "" for a local skill. */
  registry: string;
  version: string;
  lastUpdated: Date;
  enabled: boolean;
  /** A skill whose setup script exited 0 (with the script as it is now). */
  setupDone: boolean;
  /** A local skill's description and by (an installed one shows its entry's). */
  description?: string;
  by?: string;
}

const instKey = (kind: Kind, name: string) => `${kind}:${name}`;

function seedInstalled(): Map<string, Inst> {
  const at = (s: string) => day(s);
  const rows: Inst[] = [
    { kind: "plugin", name: "secure-coding", registry: SKILL_MARKETPLACE, version: "2.1.0", lastUpdated: at("2026-10-01"), enabled: true, setupDone: true },
    { kind: "plugin", name: "enterprise-data", registry: SKILL_MARKETPLACE, version: "1.3.2", lastUpdated: at("2026-09-02"), enabled: true, setupDone: true },
    { kind: "skill", name: "pr-review", registry: SKILL_MARKETPLACE, version: "20260912", lastUpdated: at("2026-09-12"), enabled: true, setupDone: true },
    { kind: "skill", name: "sql-helper", registry: SKILL_MARKETPLACE, version: "20260821", lastUpdated: at("2026-08-21"), enabled: false, setupDone: true },
    { kind: "skill", name: "jira-sync", registry: SKILL_MARKETPLACE, version: "20261011", lastUpdated: at("2026-10-11"), enabled: true, setupDone: false },
    { kind: "skill", name: "incident-postmortem", registry: SKILL_MARKETPLACE, version: "20260904", lastUpdated: at("2026-09-04"), enabled: true, setupDone: true },
    { kind: "skill", name: "my-notes", registry: "", version: "", lastUpdated: new Date(0), enabled: true, setupDone: true, description: "How I like my notes: short, dated, one idea per line.", by: "" },
  ];
  return new Map(rows.map((r) => [instKey(r.kind, r.name), r]));
}

/** a > b by major.minor.patch (the fixture has no pre-releases). */
function newerSemver(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

const kindProto = (k: Kind) => (k === "plugin" ? SkillKind.PLUGIN : SkillKind.SKILL);
const tierProto = (t: Tier) => (t === "enterprise" ? SkillTier.ENTERPRISE : SkillTier.COMMUNITY);
const tierRank = (t: Tier) => (t === "enterprise" ? 0 : 1);

/** The daemon's marketplace.Search (internal/store/skill/marketplace/search.go). */
export function searchEntries(entries: readonly Entry[], q: { text: string; tier: Tier | ""; kind: Kind | ""; limit: number }): { hits: Entry[]; total: number } {
  const limit = Math.min(q.limit > 0 ? q.limit : 50, 500);
  const text = q.text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const words = text.split(" ").filter(Boolean);
  const has = (s: string, w: string) => s.toLowerCase().includes(w);
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (text === "") return 3;
    if (n === text) return 0;
    if (n.startsWith(text)) return 1;
    return n.includes(text) ? 2 : 3;
  };
  const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
  const hits = entries
    .filter((e) => (!q.tier || e.tier === q.tier) && (!q.kind || e.kind === q.kind))
    .filter((e) => words.every((w) => has(e.name, w) || has(e.description, w) || has(e.by, w) || e.keywords.some((k) => has(k, w))))
    .map((e) => ({ e, r: rank(e.name) }))
    .sort((a, b) => cmp(a.r, b.r) || cmp(a.e.name.toLowerCase(), b.e.name.toLowerCase()) || cmp(tierRank(a.e.tier), tierRank(b.e.tier)) || cmp(a.e.kind, b.e.kind) || cmp(a.e.path, b.e.path))
    .map((h) => h.e);
  return { hits: hits.slice(0, limit), total: hits.length };
}

export interface SkillDeps {
  publish: (ev: SkillEventInit) => void;
  /**
   * Starts skill.setup's terminal in ctx's thread or project (World: kind=setup, the
   * owner's labels, skill and title) running script in dir; null when the context has
   * no thread or project. The World reports its exit with setupExited.
   */
  startSetup: (ctx: UiContext | undefined, name: string, dir: string, script: string) => { id: string; cwd: string; labels: Record<string, string> } | null;
}

interface ArgDef {
  name: string;
  type: ArgType;
  required: boolean;
  description: string;
  enumValues?: string[];
  defaultValue?: string;
}

/** A command as World's registry takes it. */
export interface SkillCommand {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; args: ArgDef[]; confirm?: (ctx: UiContext | undefined, args: Record<string, string>) => string };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
}

export class MockSkills {
  private entries: Entry[] = seedEntries();
  private installed = seedInstalled();
  private epoch = 1;
  private readAt = new Date(Date.now() - 12 * 60_000);
  private refreshedAt: Date | null = null;
  /** Failures by command name (POST /__mock/skills?fail=…&error=…). */
  readonly failures = new Map<string, string>();
  /** Claude Code without the marketplace (registries=none). */
  noRegistries = false;
  /** `claude plugin marketplace list` failed (the registries are the last good list's). */
  listError = "";
  pluginsError = "";
  /** The marketplace's own read error (a failed refresh). */
  private registryError = "";
  /** Commands run: "<command> <args as JSON>". */
  calls: string[] = [];

  constructor(private readonly deps: SkillDeps) {}

  reset(): void {
    this.entries = seedEntries();
    this.installed = seedInstalled();
    this.readAt = new Date(Date.now() - 12 * 60_000);
    this.refreshedAt = null;
    this.failures.clear();
    this.noRegistries = false;
    this.listError = "";
    this.pluginsError = "";
    this.registryError = "";
    this.calls = [];
    this.bump();
  }

  /** A read: the next epoch, published (SkillService.Watch, the EventService skill source). */
  bump(): void {
    this.epoch++;
    this.deps.publish({ epoch: BigInt(this.epoch) });
  }

  event(): SkillEventInit {
    return { epoch: BigInt(this.epoch) };
  }

  /** The catalogue: none when Claude Code has no marketplace. */
  private catalogue(): Entry[] {
    return this.noRegistries ? [] : this.entries;
  }

  private instOf(e: Entry): Inst | undefined {
    const i = this.installed.get(instKey(e.kind, e.name));
    return i && i.registry === SKILL_MARKETPLACE ? i : undefined;
  }

  /** The newer version an installed row's entry offers ("" for none). */
  private offer(i: Inst): string {
    if (!i.registry) return "";
    const e = this.catalogue().find((x) => x.kind === i.kind && x.name === i.name);
    if (!e) return "";
    return (i.kind === "plugin" ? newerSemver(e.version, i.version) : e.version > i.version) ? e.version : "";
  }

  private entryMsg(e: Entry): EntryInit {
    const i = this.instOf(e);
    return {
      kind: kindProto(e.kind),
      tier: tierProto(e.tier),
      name: e.name,
      description: e.description,
      by: e.by,
      version: e.version,
      declaredVersion: e.declaredVersion,
      lastUpdated: timestampFromDate(e.lastUpdated),
      registry: SKILL_MARKETPLACE,
      path: e.path,
      keywords: e.keywords,
      skills: e.skills,
      setupScript: e.setupScript,
      state: !i ? SkillEntryState.NOT_INSTALLED : i.enabled ? SkillEntryState.ENABLED : SkillEntryState.DISABLED,
      installedVersion: i?.version ?? "",
      updateVersion: i ? this.offer(i) : "",
    };
  }

  /** SkillService.Search. */
  search(req: SearchSkillsRequest): MessageInitShape<typeof SearchSkillsResponseSchema> {
    let refreshError = "";
    if (req.refresh) refreshError = this.refreshNow();
    const tier = req.tier === SkillTier.ENTERPRISE ? "enterprise" : req.tier === SkillTier.COMMUNITY ? "community" : "";
    const kind = req.kind === SkillKind.PLUGIN ? "plugin" : req.kind === SkillKind.SKILL ? "skill" : "";
    const { hits, total } = searchEntries(this.catalogue(), { text: req.query, tier, kind, limit: req.limit });
    return { entries: hits.map((e) => this.entryMsg(e)), total, refreshError, epoch: BigInt(this.epoch) };
  }

  private dirOf(i: Inst): string {
    if (i.kind === "plugin") return `${PLUGIN_CACHE}/${i.name}/${i.version}`;
    return `${i.enabled ? SKILLS_DIR : DISABLED_DIR}/${i.name}`;
  }

  private installedMsg(i: Inst): InstalledInit {
    const e = i.registry ? this.entries.find((x) => x.kind === i.kind && x.name === i.name) : undefined;
    const update = this.offer(i);
    const script = e?.setupScript ? e.setupScript.slice(e.path.length + 1) : "";
    return {
      kind: kindProto(i.kind),
      name: i.name,
      id: i.kind === "plugin" ? `${i.name}@${i.registry}` : i.name,
      registry: i.registry,
      path: e?.path ?? "",
      tier: e ? tierProto(e.tier) : SkillTier.UNSPECIFIED,
      description: e?.description ?? i.description ?? "",
      by: e?.by ?? i.by ?? "",
      version: i.version,
      ...(i.registry ? { lastUpdated: timestampFromDate(i.lastUpdated) } : {}),
      enabled: i.enabled,
      state: i.registry ? InstalledSkillState.INSTALLED : InstalledSkillState.LOCAL,
      dir: this.dirOf(i),
      scope: i.kind === "plugin" ? "user" : "",
      skills: e?.skills ?? [],
      setupScript: i.kind === "skill" ? script : "",
      needsSetup: i.kind === "skill" && script !== "" && !i.setupDone,
      ...(update && e ? { update: { version: update, lastUpdated: timestampFromDate(e.lastUpdated), commitSha: "3f9c2e1a7b4d" } } : {}),
    };
  }

  /** SkillService.Installed, by name then kind. */
  list(): MessageInitShape<typeof ListInstalledSkillsResponseSchema> {
    const rows = [...this.installed.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.kind.localeCompare(b.kind));
    return { installed: rows.map((i) => this.installedMsg(i)), pluginsError: this.pluginsError, epoch: BigInt(this.epoch) };
  }

  /** SkillService.Registries. */
  registries(): MessageInitShape<typeof ListSkillRegistriesResponseSchema> {
    const regs = this.noRegistries
      ? []
      : [
          {
            name: SKILL_MARKETPLACE,
            repo: SKILL_MARKETPLACE_REPO,
            source: "github",
            url: "",
            ref: "",
            dir: CHECKOUT,
            owner: "AI Platform",
            plugins: this.entries.filter((e) => e.kind === "plugin").length,
            skills: this.entries.filter((e) => e.kind === "skill").length,
            shallow: false,
            readAt: timestampFromDate(this.readAt),
            ...(this.refreshedAt ? { refreshedAt: timestampFromDate(this.refreshedAt) } : {}),
            error: this.registryError,
            issues: [],
          },
        ];
    return { registries: regs, error: this.listError, expectedMarketplace: SKILL_MARKETPLACE, epoch: BigInt(this.epoch) };
  }

  /** The World's report of a setup terminal's exit: exit 0 is setup done. */
  setupExited(name: string, code: number): void {
    const i = this.installed.get(instKey("skill", name));
    if (!i || code !== 0) return;
    i.setupDone = true;
    this.bump();
  }

  /** A refresh: Claude Code updates the checkout (now), or the failure set for skill.refresh. Returns the failure. */
  private refreshNow(): string {
    const fail = this.failures.get("skill.refresh") ?? "";
    this.registryError = fail;
    if (!fail) {
      this.readAt = new Date();
      this.refreshedAt = new Date();
    }
    this.bump();
    return fail;
  }

  // -------------------------------------------------------------------------------------
  // skill.*

  /** The entry a command names: <name> or <name>@<marketplace>, with --kind; the daemon's refusals. */
  private entry(nameArg: string, kind: string): Entry {
    const [name = "", market] = nameArg.split("@");
    const found = this.catalogue().filter((e) => e.name === name && (!kind || e.kind === kind) && (!market || (e.kind === "plugin" && market === SKILL_MARKETPLACE)));
    if (found.length === 0) throw new CommandError("invalid", `no ${kind || "plugin or skill"} named "${nameArg}" in the marketplace`);
    if (found.length > 1) throw new CommandError("invalid", `"${name}" is both a plugin and a skill; choose one with --kind plugin or --kind skill`);
    return found[0] as Entry;
  }

  /** What is installed under a command's name (installed things are found on disk, the catalogue aside). */
  private inst(nameArg: string, kind: string): Inst {
    const [name = ""] = nameArg.split("@");
    const found = [...this.installed.values()].filter((i) => i.name === name && (!kind || i.kind === kind));
    if (found.length === 0) throw new CommandError("invalid", `no installed plugin or skill named "${nameArg}"`);
    if (found.length > 1) throw new CommandError("invalid", `"${name}" is both a plugin and a skill; choose one with --kind plugin or --kind skill`);
    return found[0] as Inst;
  }

  private local(i: Inst, op: string): void {
    if (!i.registry) throw new CommandError("invalid", `skill ${i.name} is local (Code Foundry did not install it), so it cannot be ${op}; remove deletes it`);
  }

  /** The command's failure, when one is set; after the first step, like a real one. */
  private async step(cmd: string, steps = 2): Promise<void> {
    for (let n = 0; n < steps; n++) {
      await new Promise((r) => setTimeout(r, STEP_MS));
      const fail = this.failures.get(cmd);
      if (fail) throw new CommandError("unavailable", fail);
    }
  }

  private what(i: { kind: Kind; name: string; registry: string }): string {
    return i.kind === "plugin" && i.registry ? `plugin ${i.name}@${i.registry}` : `${i.kind} ${i.name}`;
  }

  private change(op: string, i: Inst, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ op, kind: i.kind, name: i.name, ...(i.registry ? { registry: i.registry } : {}), ...(i.version ? { version: i.version } : {}), dir: this.dirOf(i), ...extra });
  }

  private record(name: string, args: Record<string, string>, allowed: string[]): void {
    for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new CommandError("invalid", `unknown argument "${k}"`);
    this.calls.push(`${name} ${JSON.stringify(args)}`);
  }

  private setupLine(i: Inst): string {
    const e = this.entries.find((x) => x.kind === "skill" && x.name === i.name);
    if (i.kind !== "skill" || !e?.setupScript || i.setupDone) return "";
    return `\nit has a setup script (${e.setupScript.slice(e.path.length + 1)}); run it in a terminal with: code-foundry skill setup ${i.name}`;
  }

  commands(): SkillCommand[] {
    const always = () => true;
    const nameArg: ArgDef = { name: "name", type: ArgType.STRING, required: true, description: "The plugin or skill's name (code-foundry skill browse); <name>@<marketplace> names a plugin" };
    const kindArg: ArgDef = { name: "kind", type: ArgType.ENUM, required: false, description: "plugin or skill, when a plugin and a skill share the name", enumValues: ["plugin", "skill"] };
    const cmd = (name: string, title: string, description: string, args: ArgDef[], confirm?: SkillCommand["cmd"]["confirm"]): SkillCommand["cmd"] => ({
      name,
      title,
      category: "Skill",
      description,
      keybindings: [],
      args,
      ...(confirm ? { confirm } : {}),
    });
    return [
      {
        cmd: cmd("skill.browse", "Browse Skills", "Search the plugins and skills of the marketplaces Claude Code has.", [
          { name: "query", type: ArgType.STRING, required: false, description: "Words that must all match (case-insensitive)" },
          { name: "tier", type: ArgType.ENUM, required: false, description: "Only this tier", enumValues: ["enterprise", "community"] },
          { name: "kind", type: ArgType.ENUM, required: false, description: "Only plugins or only skills", enumValues: ["plugin", "skill"] },
          { name: "limit", type: ArgType.INT, required: false, description: "At most this many (up to 500)", defaultValue: "50" },
          { name: "refresh", type: ArgType.BOOL, required: false, description: "Update the marketplaces first" },
        ]),
        when: always,
        run: (_c, a) => {
          this.record("skill.browse", a, ["query", "tier", "kind", "limit", "refresh"]);
          if (a.refresh === "true") this.refreshNow();
          if (this.noRegistries) return `Claude Code has no plugin marketplace; add your organisation's with: claude plugin marketplace add <owner>/<repo> (for example the ${SKILL_MARKETPLACE} repository)`;
          const { hits, total } = searchEntries(this.catalogue(), { text: a.query ?? "", tier: (a.tier ?? "") as Tier | "", kind: (a.kind ?? "") as Kind | "", limit: Number(a.limit ?? 50) });
          const lines = hits.map((e) => `${e.name}  ${e.kind}  ${e.tier}  ${e.version}`);
          if (total > hits.length) lines.push(`${String(hits.length)} of ${String(total)} shown (--limit shows more)`);
          return Promise.resolve({ message: lines.join("\n") || "nothing matches", resultJson: JSON.stringify({ total, entries: hits.map((e) => ({ kind: e.kind, name: e.name })) }) });
        },
      },
      {
        cmd: cmd("skill.install", "Install Skill", "Install a marketplace plugin or copy a skill into ~/.claude/skills/<name>.", [nameArg, kindArg]),
        when: always,
        run: async (_c, a) => {
          this.record("skill.install", a, ["name", "kind"]);
          const e = this.entry(a.name ?? "", a.kind ?? "");
          const had = this.instOf(e);
          if (had) return { message: `${this.what(had)} ${had.version} is installed already`, resultJson: this.change("install", had, { unchanged: true }) };
          const taken = this.installed.get(instKey(e.kind, e.name));
          if (taken && e.kind === "skill") throw new CommandError("invalid", `skill ${e.name}: ${SKILLS_DIR}/${e.name} is in the way (Code Foundry did not install it from ${SKILL_MARKETPLACE})`);
          await this.step("skill.install", e.kind === "plugin" ? 3 : 2);
          const i: Inst = { kind: e.kind, name: e.name, registry: SKILL_MARKETPLACE, version: e.version, lastUpdated: e.kind === "plugin" ? new Date() : e.lastUpdated, enabled: true, setupDone: !e.setupScript };
          this.installed.set(instKey(e.kind, e.name), i);
          this.bump();
          return { message: `installed ${this.what(i)} ${i.version} from ${SKILL_MARKETPLACE}${i.kind === "skill" ? ` (${this.dirOf(i)})` : ""}${this.setupLine(i)}`, resultJson: this.change("install", i, { needsSetup: !i.setupDone }) };
        },
      },
      {
        cmd: cmd("skill.enable", "Enable Skill", "Enable an installed marketplace plugin, or move a disabled skill back into ~/.claude/skills.", [nameArg, kindArg]),
        when: always,
        run: async (_c, a) => this.toggle("skill.enable", a, true),
      },
      {
        cmd: cmd("skill.disable", "Disable Skill", `Disable an installed marketplace plugin, or move a skill out of ~/.claude/skills. ${RESTART_WARNING}`, [nameArg, kindArg], (_c, a) => `Disable ${a.name ?? ""}? ${RESTART_WARNING}`),
        when: always,
        run: async (_c, a) => this.toggle("skill.disable", a, false),
      },
      {
        cmd: cmd("skill.update", "Update Skills", "Update a plugin or a skill, or every one with an update; --check only lists them.", [
          { ...nameArg, required: false, description: "The plugin or skill (default: every one with an update)" },
          kindArg,
          { name: "check", type: ArgType.BOOL, required: false, description: "Only list the updates" },
        ]),
        when: always,
        run: async (_c, a) => {
          this.record("skill.update", a, ["name", "kind", "check"]);
          const targets = a.name ? [this.inst(a.name, a.kind ?? "")] : [...this.installed.values()].filter((i) => this.offer(i) !== "" && (!a.kind || i.kind === a.kind));
          if (a.check === "true") {
            const offered = targets.filter((i) => this.offer(i) !== "");
            return { message: offered.map((i) => `${i.name}  ${i.kind}  ${i.version}  ${this.offer(i)}`).join("\n") || "every plugin and skill is up to date", resultJson: "[]" };
          }
          const changes: string[] = [];
          const lines: string[] = [];
          for (const i of targets) {
            this.local(i, "updated");
            const to = this.offer(i);
            if (!to) {
              lines.push(`${this.what(i)} ${i.version} is up to date`);
              changes.push(this.change("update", i, { unchanged: true }));
              continue;
            }
            await this.step("skill.update");
            const from = i.version;
            const e = this.entries.find((x) => x.kind === i.kind && x.name === i.name);
            i.version = to;
            i.lastUpdated = i.kind === "plugin" ? new Date() : (e?.lastUpdated ?? new Date());
            if (e?.setupScript) i.setupDone = false;
            lines.push(`updated ${this.what(i)} ${from} → ${to}${this.setupLine(i)}`);
            changes.push(this.change("update", i, { previousVersion: from, needsSetup: !i.setupDone }));
          }
          if (changes.length > 0) this.bump();
          return { message: lines.join("\n") || "every plugin and skill is up to date", resultJson: `[${changes.join(",")}]` };
        },
      },
      {
        cmd: cmd("skill.uninstall", "Uninstall Skill", `Uninstall a marketplace plugin or delete a skill Code Foundry installed. ${RESTART_WARNING}`, [nameArg, kindArg], (_c, a) => `Uninstall ${a.name ?? ""}? ${RESTART_WARNING}`),
        when: always,
        run: async (_c, a) => {
          this.record("skill.uninstall", a, ["name", "kind"]);
          const i = this.inst(a.name ?? "", a.kind ?? "");
          this.local(i, "uninstalled");
          await this.step("skill.uninstall");
          this.installed.delete(instKey(i.kind, i.name));
          this.bump();
          return { message: `uninstalled ${this.what(i)}`, resultJson: this.change("uninstall", i) };
        },
      },
      {
        cmd: cmd(
          "skill.remove",
          "Remove Local Skill",
          `Delete a local skill: a directory in ~/.claude/skills Code Foundry did not install. ${RESTART_WARNING}`,
          [{ name: "name", type: ArgType.STRING, required: true, description: "The local skill's directory name" }],
          (_c, a) => `Remove the local skill ${a.name ?? ""}? This deletes ${SKILLS_DIR}/${a.name ?? ""}. ${RESTART_WARNING}`,
        ),
        when: always,
        run: async (_c, a) => {
          this.record("skill.remove", a, ["name"]);
          const i = this.installed.get(instKey("skill", a.name ?? ""));
          if (!i) throw new CommandError("invalid", `no skill named "${a.name ?? ""}" in ${SKILLS_DIR}`);
          if (i.registry) throw new CommandError("invalid", `skill ${i.name} was installed by Code Foundry; uninstall it instead`);
          await this.step("skill.remove", 1);
          this.installed.delete(instKey("skill", i.name));
          this.bump();
          return { message: `removed local skill ${i.name}`, resultJson: this.change("remove", i) };
        },
      },
      {
        cmd: cmd("skill.setup", "Run Skill Setup", "Run a skill's setup script in a terminal in the bottom panel of the active thread or worktree.", [
          { name: "name", type: ArgType.STRING, required: true, description: "The skill's name" },
        ]),
        when: always,
        run: async (ctx, a) => {
          this.record("skill.setup", a, ["name"]);
          if (!ctx?.activeThreadId && !ctx?.activeWorktreePath && !ctx?.activeProjectId) throw new CommandError("invalid", "select a thread or project first");
          const i = this.inst(a.name ?? "", "skill");
          this.local(i, "set up");
          const e = this.entries.find((x) => x.kind === "skill" && x.name === i.name);
          if (!e?.setupScript) throw new CommandError("invalid", `skill ${i.name} has no setup script`);
          const script = e.setupScript.slice(e.path.length + 1);
          await this.step("skill.setup", 1);
          const t = this.deps.startSetup(ctx, i.name, this.dirOf(i), script);
          if (!t) throw new CommandError("invalid", "select a thread or project first");
          return { message: `running ${i.name}'s setup (${script}) in terminal ${t.id}`, resultJson: JSON.stringify(t) };
        },
      },
      {
        cmd: cmd("skill.refresh", "Refresh Skill Marketplaces", "Update every marketplace Claude Code has and read them again. It also runs every hour.", []),
        when: always,
        run: async (_c, a) => {
          this.record("skill.refresh", a, []);
          if (this.noRegistries) {
            this.bump();
            return { message: `Claude Code has no plugin marketplace; add your organisation's with: claude plugin marketplace add <owner>/<repo> (for example the ${SKILL_MARKETPLACE} repository)`, resultJson: "[]" };
          }
          await new Promise((r) => setTimeout(r, STEP_MS * 3));
          const err = this.refreshNow();
          const n = this.registries().registries?.[0];
          const line = `marketplace ${SKILL_MARKETPLACE} (${SKILL_MARKETPLACE_REPO}): ${String(n?.plugins ?? 0)} plugin(s), ${String(n?.skills ?? 0)} skill(s)`;
          return { message: err ? `${line}\n  error: ${err}` : line, resultJson: JSON.stringify([{ name: SKILL_MARKETPLACE, repo: SKILL_MARKETPLACE_REPO, error: err }]) };
        },
      },
    ];
  }

  private async toggle(name: string, a: Record<string, string>, enable: boolean): Promise<InvokeOut> {
    this.record(name, a, ["name", "kind"]);
    const i = this.inst(a.name ?? "", a.kind ?? "");
    this.local(i, enable ? "enabled" : "disabled");
    const op = enable ? "enable" : "disable";
    if (i.enabled === enable) return { message: `${this.what(i)} is ${op}d already`, resultJson: this.change(op, i, { unchanged: true }) };
    await this.step(name);
    i.enabled = enable;
    this.bump();
    return { message: `${op}d ${this.what(i)}${i.kind === "skill" ? ` (${this.dirOf(i)})` : ""}`, resultJson: this.change(op, i) };
  }

  /** POST /__mock/skills: the failure and registry controls (see the file comment). */
  control(q: URLSearchParams): Record<string, unknown> {
    const fail = q.get("fail");
    if (fail) {
      const msg = q.get("error") ?? "";
      if (msg) this.failures.set(fail, msg);
      else this.failures.delete(fail);
    }
    let changed = false;
    if (q.has("registries")) {
      this.noRegistries = q.get("registries") === "none";
      changed = true;
    }
    if (q.has("listError")) {
      this.listError = q.get("listError") ?? "";
      changed = true;
    }
    if (q.has("pluginsError")) {
      this.pluginsError = q.get("pluginsError") ?? "";
      changed = true;
    }
    if (changed || q.get("epoch") === "1") this.bump();
    return this.state();
  }

  /** GET /__mock/skills. */
  state(): Record<string, unknown> {
    return {
      epoch: this.epoch,
      calls: this.calls,
      failures: Object.fromEntries(this.failures),
      installed: [...this.installed.values()].map((i) => ({ kind: i.kind, name: i.name, version: i.version, enabled: i.enabled, setupDone: i.setupDone, local: !i.registry })),
    };
  }
}

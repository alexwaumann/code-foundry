import type { CSSProperties, ReactNode } from "react";
import {
  AlarmClock,
  Archive,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePen,
  Gauge,
  GitMerge,
  Info,
  Layers,
  Monitor,
  Moon,
  Paperclip,
  Pin,
  ShieldCheck,
  SquareTerminal,
  Sun,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CLAUDE_ORANGE, ClaudeMark } from "@/components/icons/ClaudeMark";
import { Chip } from "@/components/thread/Chip";
import { ThreadMarkdown } from "@/components/thread/Code";
import { UserBubble } from "@/components/thread/UserBubble";
import "@/components/thread/thread.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/**
 * The Themes page's gallery (docs/notes/theme-engine-4-picker.md): enough of the app on one
 * screen to judge a theme. Rendered inside a ThemeScope, so every token is the previewed
 * theme's. Real components where they take static props (UserBubble, ThreadMarkdown with
 * its code block, the shadcn controls); the sidebar rows, tool rows, composer, menu and
 * dialog are store-bound or portalled, so they are their markup with the same classes.
 * The page renders it `inert`: a picture, not a second app.
 */
export function ThemeGallery() {
  return (
    <div className="flex flex-col gap-3 p-3 text-body-sm" data-testid="theme-gallery">
      <div className="flex h-[432px] gap-1.5 overflow-hidden rounded-lg border border-cf-divider bg-cf-canvas p-1.5">
        <MiniSidebar />
        <MiniThread />
      </div>
      <TerminalStrip />
      {/* Three columns of stacked cards, so no card waits for a taller neighbour. */}
      <div className="grid grid-cols-3 items-start gap-3">
        <div className="flex min-w-0 flex-col gap-3">
          <Card label="Buttons">
            <Buttons />
          </Card>
          <Card label="Inputs">
            <Inputs />
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <Card label="Badges · chips">
            <Badges />
          </Card>
          <Card label="Text">
            <TextSamples />
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <Card label="Menu">
            <Menu />
          </Card>
          <Card label="Dialog">
            <DialogCard />
          </Card>
        </div>
      </div>
      <Card label="Feedback">
        <Feedback />
      </Card>
    </div>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-cf-divider bg-cf-surface p-3" aria-label={label}>
      <h3 className="mb-2 text-overline">{label}</h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- sidebar

/** SidebarRow's markup (components/sidebar/SidebarRow.tsx) with sample threads. */
function Row({ name, selected, pinned, chip, line2 }: { name: string; selected?: boolean; pinned?: boolean; chip?: ReactNode; line2: ReactNode }) {
  return (
    <div
      className={cn(
        "flex h-[41px] shrink-0 items-center gap-1.5 rounded-md px-2 text-body-sm select-none",
        selected ? "bg-cf-sidebar-row-selected text-cf-sidebar-foreground" : "text-cf-sidebar-foreground/90",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{name}</span>
          <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-1">
            {chip}
            {pinned && <Pin className="size-3 shrink-0 text-cf-text-muted" aria-hidden />}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1 text-caption-sm">
          <span className="min-w-0 truncate">{line2}</span>
        </div>
      </div>
    </div>
  );
}

function Place({ project, branch }: { project: string; branch: string }) {
  return (
    <>
      {project} <span className="opacity-60">@</span> <span className="font-mono">{branch}</span>
    </>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mt-1 flex h-[22px] shrink-0 items-center gap-1.5 px-2 text-cf-text-muted">
      <span className="truncate text-overline">{label}</span>
      <span className="shrink-0 text-overline font-normal tabular-nums opacity-70">{count}</span>
      <ChevronDown className="ml-auto size-3" aria-hidden />
    </div>
  );
}

function MiniSidebar() {
  return (
    <div className="flex w-[210px] shrink-0 flex-col gap-px overflow-hidden bg-cf-sidebar text-cf-sidebar-foreground" data-testid="gallery-sidebar">
      <Row name="Theme engine tokens" selected pinned line2={<Place project="code-foundry" branch="cf/theme-engine" />} />
      <Row name="Fix stale PR badge" line2={<span className="text-cf-warning-text">Asked a question</span>} />
      <Row name="Release build" line2={<span className="text-cf-error-text">Error · exit status 2</span>} />
      <Row
        name="Usage page polish"
        chip={<span className="flex shrink-0 items-center rounded-sm bg-cf-success-surface px-1 text-caption-sm font-medium text-cf-success-text tabular-nums">2 PRs</span>}
        line2={<span className="text-cf-success-text">Finished 3m ago</span>}
      />
      <Row
        name="Docs typo sweep"
        chip={
          <span className="flex max-w-24 min-w-0 items-center gap-0.5 rounded-sm bg-cf-highlight-surface px-1 text-caption-sm font-medium text-cf-highlight-text">
            <Layers className="size-2.5" aria-hidden />
            <span className="truncate">site</span>
          </span>
        }
        line2={<Place project="code-foundry" branch="main" />}
      />
      <SectionHeader label="Working" count={1} />
      <Row
        name="Rendered threads daemon"
        line2={
          <>
            <span className="text-cf-info-text">
              <Bot className="mr-0.5 inline size-2.5 align-[-1px]" aria-hidden />3 agents
            </span>
            <span aria-hidden> · </span>
            <span className="text-cf-info-text">Working</span>
            <span aria-hidden> · </span>code-foundry
          </>
        }
      />
      <SectionHeader label="Snoozed" count={1} />
      <div className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 text-cf-sidebar-foreground/90">
        <AlarmClock className="size-3 shrink-0 text-cf-text-muted" aria-hidden />
        <span className="truncate">Bump wails</span>
        <span className="ml-auto shrink-0 pl-1 text-caption-sm tabular-nums">2h</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- thread

const MARKDOWN = [
  "The **bright** slots carry status on dark themes; see `derive()` and the [contrast notes](https://github.com/alexwaumann/code-foundry).",
  "",
  "```ts",
  "export function derive(g: Ghostty): Vars {",
  "  const dark = lightness(g.bg) < 0.6; // pane = bg",
  '  return { pane: g.bg, warning: g.palette[dark ? 11 : 3], name: "ghostty" };',
  "}",
  "```",
].join("\n");

/** A work-log row (components/thread/rows.tsx ToolRow's markup). */
function ToolRow({ icon: Icon, children, meta }: { icon: typeof SquareTerminal; children: ReactNode; meta: ReactNode }) {
  return (
    <div className="row">
      <span className="ico">
        <Icon aria-hidden />
      </span>
      <span className="lbl">{children}</span>
      <span className="meta">{meta}</span>
      <ChevronRight className="chev" aria-hidden />
    </div>
  );
}

function MiniThread() {
  return (
    <div className="cf-thread flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-cf-divider bg-cf-surface" data-testid="gallery-thread">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-cf-divider px-3">
        <span className="size-1.5 rounded-full bg-cf-success" aria-hidden />
        <span className="truncate text-label">Theme engine tokens</span>
        <span className="truncate text-caption">idle · Opus 4.8 · high</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-1">
        <UserBubble text="Map the Ghostty palette onto our tokens." composerText="" attachments={[]} createdAtMs={null} />
        <div className="thead">
          <span className="fold text-caption">
            <span className="ico">
              <ChevronDown aria-hidden />
            </span>
            <span>Worked for 1m 12s</span>
            <span className="sep">·</span>
            <span>3 steps</span>
            <span className="sep">·</span>
            <span>$0.04</span>
          </span>
        </div>
        <ToolRow
          icon={SquareTerminal}
          meta={
            <>
              <span className="chip ok">ok</span>
              <span>4.1s</span>
            </>
          }
        >
          Ran <span className="mono cmd">make check</span>
        </ToolRow>
        <ToolRow
          icon={FilePen}
          meta={
            <span>
              <span className="add">+42</span>
              <span className="del"> −7</span>
            </span>
          }
        >
          Edited <b>convert.ts</b>
        </ToolRow>
        <ToolRow icon={SquareTerminal} meta={<span className="chip fail">exit 1</span>}>
          Ran <span className="mono cmd">go test ./internal/api</span>
        </ToolRow>
        <div className="a-md final mt-1">
          <ThreadMarkdown>{MARKDOWN}</ThreadMarkdown>
        </div>
      </div>
      <Composer />
    </div>
  );
}

/** ThreadComposer's card (.ccard) with its pickers and send button. */
function Composer() {
  const picker = "max-w-64 text-cf-text-muted";
  return (
    <div className="shrink-0 px-3 pb-3">
      <div className="ccard docked">
        <div className="col-span-2 min-h-10 px-4 pt-2.5 pb-1 text-body text-cf-text-muted">Reply or ask anything. @ files and threads, / skills and commands</div>
        <div className="col-start-1 flex min-w-0 items-center gap-0.5 px-2 pb-2">
          <Button variant="ghost" size="xs" className={picker} tabIndex={-1}>
            <ClaudeMark style={{ color: CLAUDE_ORANGE }} /> Opus 4.8 <ChevronDown className="opacity-60" />
          </Button>
          <Button variant="ghost" size="xs" className={picker} tabIndex={-1}>
            <Gauge /> High <ChevronDown className="opacity-60" />
          </Button>
          <Button variant="ghost" size="xs" className={picker} tabIndex={-1}>
            <ShieldCheck /> Auto <ChevronDown className="opacity-60" />
          </Button>
          <span className="ml-auto flex size-7 items-center justify-center rounded-md text-cf-text-muted">
            <Paperclip className="size-4" aria-hidden />
          </span>
        </div>
        <div className="col-start-2 flex items-end pr-2 pb-2">
          <span className="flex size-8 items-center justify-center rounded-full bg-cf-accent text-cf-accent-foreground">
            <ArrowUp className="size-4" aria-hidden />
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- terminal

const ansi = (n: number): CSSProperties => ({ color: `var(--terminal-ansi-${String(n)})` });

/** The bottom panel's shell, without xterm: a prompt, some status words and ANSI 0-15 as cells. */
function TerminalStrip() {
  return (
    <div className="rounded-lg border border-cf-divider bg-cf-surface px-3 py-2 text-caption-sm font-mono leading-5" style={{ color: "var(--terminal-fg)" }} data-testid="gallery-terminal">
      <div className="truncate">
        <span style={ansi(4)}>~/code-foundry</span> <span style={ansi(5)}>cf/theme-engine*</span> <span style={ansi(2)}>❯</span> git status -sb
      </div>
      <div className="truncate">
        <span style={ansi(1)}> M</span> index.css <span style={ansi(1)}>??</span> <span style={{ background: "var(--terminal-selection)" }}>selected text</span>{" "}
        <span style={ansi(2)}>ok</span> internal/store <span style={ansi(1)}>FAIL</span> internal/api <span style={ansi(3)}>warn</span> gofmt{" "}
        <span style={ansi(8)}># comment</span>{" "}
        <span className="inline-block h-4 w-2 align-[-3px]" style={{ background: "var(--terminal-cursor)" }} aria-hidden />
      </div>
      <div className="mt-1.5 grid grid-cols-16 gap-1" data-testid="gallery-ansi">
        {Array.from({ length: 16 }, (_, n) => (
          <div key={n} className="flex flex-col items-center gap-0.5">
            <span className="h-4 w-full rounded-sm border border-cf-divider" style={{ background: `var(--terminal-ansi-${String(n)})` }} data-ansi={n} />
            <span className="text-caption-sm leading-3 tabular-nums">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- controls

function Buttons() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" tabIndex={-1}>
        <GitMerge /> Merge
      </Button>
      <Button size="sm" variant="secondary" tabIndex={-1}>
        Cancel
      </Button>
      <Button size="sm" variant="outline" tabIndex={-1}>
        Review <ChevronDown />
      </Button>
      <Button size="sm" variant="destructive" tabIndex={-1}>
        <Trash2 /> Delete
      </Button>
      <Button size="sm" disabled>
        Disabled
      </Button>
      <Button size="sm" variant="link" className="px-1" tabIndex={-1}>
        View diff
      </Button>
    </div>
  );
}

function Inputs() {
  return (
    <div className="flex flex-col gap-2">
      <Input readOnly tabIndex={-1} aria-label="Branch" value="cf/theme-engine" className="h-8" />
      {/* Focused: the focus-visible ring, drawn statically. */}
      <Input readOnly tabIndex={-1} aria-label="Focused" value="Gruvbox" className="h-8 border-cf-focus ring-[3px] ring-cf-focus/50" />
      <Input readOnly tabIndex={-1} aria-label="Folder" aria-invalid value="~/not/a/repo" className="h-8" />
      <div className="flex items-center gap-2">
        <Select value="opus">
          <SelectTrigger size="sm" className="w-32" aria-label="Model" tabIndex={-1}>
            <SelectValue>Opus 4.8</SelectValue>
          </SelectTrigger>
        </Select>
        <label className="flex items-center gap-1.5 text-body-sm">
          <Checkbox checked tabIndex={-1} /> Archive
        </label>
        <label className="flex items-center gap-1.5 text-body-sm">
          <Checkbox checked={false} tabIndex={-1} /> Sound
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Switch checked tabIndex={-1} aria-label="On" />
        <Switch checked={false} tabIndex={-1} aria-label="Off" />
        <RadioGroup variant="segmented" value="system" aria-label="Scheme sample" className="ml-auto">
          <RadioGroupChoice value="system" tabIndex={-1}>
            <Monitor /> System
          </RadioGroupChoice>
          <RadioGroupChoice value="light" tabIndex={-1}>
            <Sun /> Light
          </RadioGroupChoice>
          <RadioGroupChoice value="dark" tabIndex={-1}>
            <Moon /> Dark
          </RadioGroupChoice>
        </RadioGroup>
      </div>
    </div>
  );
}

function Badges() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Failed</Badge>
      </div>
      {/* The sidebar's status chips and the thread's result chips. */}
      <div className="cf-thread flex flex-wrap items-center gap-1.5">
        <span className="rounded-sm bg-cf-success-surface px-1 text-caption-sm font-medium text-cf-success-text">+3 checks</span>
        <span className="rounded-sm bg-cf-warning-surface px-1 text-caption-sm font-medium text-cf-warning-text">needs login</span>
        <span className="rounded-sm bg-cf-info-surface px-1 text-caption-sm font-medium text-cf-info-text">working</span>
        <span className="rounded-sm bg-cf-highlight-surface px-1 text-caption-sm font-medium text-cf-highlight-text">skill</span>
        <span className="rounded-sm bg-cf-error-surface px-1 text-caption-sm font-medium text-cf-error-text">exit 1</span>
        <Chip>worktree</Chip>
      </div>
      <div className="cf-thread flex flex-wrap items-center gap-1.5">
        <span className="chip ok">ok</span>
        <span className="chip fail">denied</span>
        <span className="chip tool">Bash</span>
        <span className="chip muted">draft</span>
        <Kbd>⌘K</Kbd>
        <Kbd size="sm">esc</Kbd>
      </div>
    </div>
  );
}

function TextSamples() {
  return (
    <div className="flex flex-col gap-1 text-body-sm">
      <p>Foreground: thread titles, body text</p>
      <p className="text-cf-text-muted">Muted: hints, timestamps, branches</p>
      <p>
        <span className="rounded-sm bg-cf-control px-1 text-cf-text">secondary</span> · <span className="text-link underline underline-offset-2">a link</span> ·{" "}
        <span className="font-mono">mono 00o1lI</span>
      </p>
      <p>
        <span className="text-cf-info-text">info</span> · <span className="text-cf-warning-text">warning</span> · <span className="text-cf-success-text">success</span> ·{" "}
        <span className="text-cf-error-text">destructive</span> · <span className="text-cf-highlight-text">highlight</span>
      </p>
      <div className="mt-1 flex items-center gap-1.5">
        {/* A tooltip, open (TooltipContent's classes). */}
        <span className="rounded-lg border bg-cf-surface-overlay px-2.5 py-1.5 text-body-sm text-cf-text shadow-lg">Snoozed until 6:00 PM</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- floating surfaces, inline

const MENU_ITEM = "relative flex items-center gap-2 rounded-md px-2 py-1.5 text-label select-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/** DropdownMenuContent and its items' classes, rendered open in place. */
function Menu() {
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="outline" size="xs" tabIndex={-1}>
        <ClaudeMark style={{ color: CLAUDE_ORANGE }} /> Opus 4.8 <ChevronDown className="opacity-60" />
      </Button>
      <div className="w-full rounded-lg border bg-cf-surface-overlay p-1 text-cf-text shadow-lg" role="presentation">
        <div className="px-2 py-1.5 text-caption-sm font-medium">Model</div>
        <div className={MENU_ITEM}>
          <Check className="text-cf-text-muted" aria-hidden /> Opus 4.8
          <span className="ml-auto pl-4 text-caption-sm tracking-widest">⌘1</span>
        </div>
        <div className={cn(MENU_ITEM, "bg-cf-control-hover pl-8 text-cf-text")}>
          Sonnet 5<span className="ml-auto pl-4 text-caption-sm tracking-widest">⌘2</span>
        </div>
        <div className={cn(MENU_ITEM, "pl-8")}>
          Haiku 4.5<span className="ml-auto pl-4 text-caption-sm tracking-widest">⌘3</span>
        </div>
        <div className="-mx-1 my-1 h-px bg-cf-border" />
        <div className={cn(MENU_ITEM, "text-cf-error-text")}>
          <Archive aria-hidden /> Archive thread
        </div>
      </div>
    </div>
  );
}

/** DialogContent's card, inline (not a modal). */
function DialogCard() {
  return (
    <div className="rounded-md bg-cf-canvas p-2">
      <div className="rounded-lg border bg-cf-surface-overlay p-3 text-cf-text shadow-2xl">
        <p className="text-heading">Archive 2 busy threads?</p>
        <p className="mt-1 text-caption">Claude stops in them and their shells close. You can unarchive them later.</p>
        <Input readOnly tabIndex={-1} aria-label="Reason" placeholder="Reason (optional)" className="mt-2 h-8" />
        <div className="mt-2.5 flex justify-end gap-2">
          <Button variant="outline" size="xs" tabIndex={-1}>
            Cancel
          </Button>
          <Button variant="destructive" size="xs" tabIndex={-1}>
            Archive
          </Button>
        </div>
      </div>
    </div>
  );
}

function Alert({ tone, icon: Icon, heading, children }: { tone: "warning" | "destructive" | "info"; icon: typeof Info; heading: string; children: ReactNode }) {
  const tones = {
    warning: "border-cf-warning/40 bg-cf-warning-surface [&>svg]:text-cf-warning-text",
    destructive: "border-cf-error/40 bg-cf-error-surface [&>svg]:text-cf-error-text",
    info: "border-cf-info/40 bg-cf-info-surface [&>svg]:text-cf-info-text",
  } as const;
  return (
    <div className={cn("flex min-w-0 flex-1 items-start gap-2 rounded-md border px-3 py-2 text-body-sm", tones[tone])} role="presentation">
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{heading}</p>
        <p className="mt-0.5 text-cf-text-muted">{children}</p>
      </div>
    </div>
  );
}

function Feedback() {
  return (
    <div className="flex gap-2">
      <Alert tone="warning" icon={TriangleAlert} heading="Needs login">
        Run /mcp, then reconnect.
      </Alert>
      <Alert tone="destructive" icon={CircleAlert} heading="Push failed">
        <span className="font-mono">rejected (non-fast-forward)</span>
      </Alert>
      <Alert tone="info" icon={Info} heading="Update ready">
        v0.9.0 (tip 3) installs on restart.
      </Alert>
    </div>
  );
}

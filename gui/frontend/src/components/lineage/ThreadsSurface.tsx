import { useState, type ReactNode } from "react";
import { CornerDownRight, LoaderCircle, Network } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { capIds, lineageStatusTones, lineageStatusWords, lineageTail, relatedCount, type LineageStatus } from "@/lib/lineage";
import type { StatusTone } from "@/lib/statusLine";
import { shortAge } from "@/lib/thread";
import { threadRowModel, type WorkspaceLookup } from "@/lib/threadRow";
import { cn } from "@/lib/utils";
import { useChildIds, useCreator, useLineageCounts, useLineageStatus, useSiblingIds } from "@/stores/lineage";
import { useReposStore } from "@/stores/repos";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";

const NO_WORKSPACES: WorkspaceLookup = { byId: {} };

/** The sidebar's status colours (SidebarRow toneClasses). */
const TONE: Readonly<Record<StatusTone, string>> = {
  muted: "text-muted-foreground",
  sky: "text-info",
  amber: "text-warning",
  emerald: "text-success",
  red: "text-destructive",
};

const DOT: Readonly<Record<Exclude<LineageStatus, "working">, string>> = {
  input: "bg-warning",
  finished: "bg-success",
  error: "bg-destructive",
  idle: "border-[1.5px] border-muted-foreground opacity-60",
  archived: "border-[1.5px] border-muted-foreground opacity-60",
  snoozed: "border-[1.5px] border-muted-foreground opacity-60",
};

/** The thread this panel belongs to: the selected thread ("" otherwise). */
function useThreadId(): string {
  return useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : ""));
}

/** Opens a thread exactly as a sidebar click does. */
function openThread(id: string): void {
  useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
}

/** A spinner while working, else a dot in the status colour (hollow when idle, archived or snoozed). */
function StatusMark({ status }: { status: LineageStatus }) {
  return (
    <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
      {status === "working" ? <LoaderCircle className="size-3 animate-spin text-info" /> : <span className={cn("block size-2 rounded-full", DOT[status])} />}
    </span>
  );
}

/** "project @ branch" (mono branch), the sidebar's place; "No project" or the No git badge without git. */
function Place({ id }: { id: string }) {
  const where = useThreadsStore(
    useShallow((st) => {
      const x = st.byId[id];
      return { repoId: x?.repoId ?? "", worktreePath: x?.worktreePath ?? "", workspaceId: x?.workspaceId ?? "", pendingWorktreePath: "" };
    }),
  );
  const m = useReposStore(
    useShallow((st) => {
      const r = threadRowModel(where, st, NO_WORKSPACES);
      return { project: r.project, branch: r.branch, noGit: r.noGit, noProject: r.noProject };
    }),
  );
  return (
    <span className="min-w-0 truncate" data-testid="lineage-place">
      {m.project}
      {m.noProject ? null : m.noGit ? (
        <>
          {" "}
          <NoGitBadge className="align-[1px]" tip={false} />
        </>
      ) : (
        <>
          {" "}
          <span className="opacity-60">@</span> <span className="text-code">{m.branch}</span>
        </>
      )}
    </span>
  );
}

/** Time since the thread was created ("41m", "3h"), on the shared 30 s clock. */
function Age({ id }: { id: string }) {
  const at = useThreadsStore((s) => s.byId[id]?.createdAtMs ?? null);
  const now = useNow(30_000);
  if (at === null) return null;
  return (
    <span className="ml-auto shrink-0 pl-2 text-caption-sm tabular-nums" data-testid="lineage-age">
      {shortAge(at, now)}
    </span>
  );
}

/**
 * One related thread: status mark, name and its status word; "project @ branch" and its
 * age; its brief as a muted quote (two lines at most). A row opens its thread like a
 * sidebar click; the current thread's row is highlighted and not clickable.
 */
function LineageRow({ id, me }: { id: string; me?: boolean }) {
  const name = useThreadsStore((s) => s.byId[id]?.name ?? "");
  const brief = useThreadsStore((s) => s.byId[id]?.brief ?? "");
  const status = useLineageStatus(id);
  const archived = status === "archived";
  const body = (
    <>
      <div className={cn("flex min-w-0 items-center gap-2 text-body-sm", archived && "opacity-60")}>
        <StatusMark status={status} />
        <span className="min-w-0 flex-1 truncate">
          <span className={cn("font-medium", !name && "text-muted-foreground")} data-testid="lineage-name">
            {name || id}
          </span>
          {me && <span className="ml-1.5 text-caption-sm">this thread</span>}
        </span>
        <span className={cn("shrink-0 text-caption-sm tabular-nums", TONE[lineageStatusTones[status]])} data-testid="lineage-status">
          {lineageStatusWords[status]}
        </span>
      </div>
      <div className={cn("flex min-w-0 items-center pl-5 text-caption", archived && "opacity-60")} data-testid="lineage-meta">
        <Place id={id} />
        <Age id={id} />
      </div>
      {brief && (
        <Tip label={brief} whenTruncated>
          <div className={cn("mt-0.5 ml-5 line-clamp-2 border-l-2 border-border pl-2 text-body-sm break-words text-foreground/70", archived && "opacity-60")} data-testid="lineage-brief">
            {brief}
          </div>
        </Tip>
      )}
    </>
  );
  const common = "relative flex w-full min-w-0 flex-col gap-[3px] border-t border-pane-border px-4 pt-[9px] pb-2.5 text-left @max-[340px]:px-3";
  const data = { "data-testid": "lineage-row", "data-thread": id, "data-status": status, "data-me": me || undefined };
  if (me)
    return (
      <li className={cn(common, "bg-primary/7 dark:bg-primary/10")} aria-current="true" {...data}>
        <span className="absolute -top-px -bottom-px left-0 w-0.5 bg-primary" aria-hidden />
        {body}
      </li>
    );
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        className={cn(common, "cursor-default outline-none hover:bg-accent/50 focus-visible:bg-accent/50")}
        onClick={() => {
          openThread(id);
        }}
        {...data}
      >
        {body}
      </button>
    </li>
  );
}

/** The creator's row when it was removed: its recorded name, "Removed", inert. */
function RemovedCreatorRow({ name }: { name: string }) {
  return (
    <li className="flex min-w-0 flex-col border-t border-pane-border px-4 pt-[9px] pb-2.5 @max-[340px]:px-3" data-testid="lineage-row" data-removed="true">
      <div className="flex min-w-0 items-center gap-2 text-body-sm text-muted-foreground">
        <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
          <span className="block size-2 rounded-full border border-dashed border-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1 truncate" data-testid="lineage-name">
          {name}
        </span>
        <span className="shrink-0 text-caption-sm" data-testid="lineage-status">
          Removed
        </span>
      </div>
    </li>
  );
}

/** An overline label and its count, then the rows between hairlines. */
function Section({ id, label, count, children }: { id: string; label: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col" data-testid={`threads-section-${id}`}>
      <h3 className="flex items-center gap-1.5 px-4 pt-3 pb-1.5 text-overline @max-[340px]:px-3">
        {label}
        {count !== undefined && (
          <span className="font-normal tracking-normal tabular-nums opacity-70" data-testid={`threads-section-${id}-count`}>
            {count}
          </span>
        )}
      </h3>
      <ul className="flex min-w-0 flex-col border-b border-pane-border">{children}</ul>
    </section>
  );
}

/** The creator's other threads, five at most until "+N more" is clicked. */
function Siblings({ threadId }: { threadId: string }) {
  const ids = useSiblingIds(threadId);
  const [expanded, setExpanded] = useState(false);
  if (ids.length === 0) return null;
  const { shown, more } = capIds(ids, expanded);
  return (
    <Section id="siblings" label="Siblings" count={ids.length}>
      {shown.map((id) => (
        <LineageRow key={id} id={id} />
      ))}
      {more > 0 && (
        <li className="flex min-w-0">
          <button
            type="button"
            className="flex w-full cursor-default items-center border-t border-pane-border px-4 py-2 pl-9 text-left text-caption outline-none hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 @max-[340px]:px-3"
            data-testid="lineage-more"
            onClick={() => {
              setExpanded(true);
            }}
          >
            +{more} more
          </button>
        </li>
      )}
    </Section>
  );
}

function Children({ threadId }: { threadId: string }) {
  const ids = useChildIds(threadId);
  if (ids.length === 0) return null;
  return (
    <Section id="children" label="Children" count={ids.length}>
      {ids.map((id) => (
        <LineageRow key={id} id={id} />
      ))}
    </Section>
  );
}

function CreatedBy({ threadId }: { threadId: string }) {
  const creator = useCreator(threadId);
  if (creator === null) return null;
  return <Section label="Created by" id="creator">{creator.exists ? <LineageRow id={creator.id} /> : <RemovedCreatorRow name={creator.name} />}</Section>;
}

function Header({ threadId }: { threadId: string }) {
  const c = useLineageCounts(threadId);
  const related = relatedCount(c);
  const tail = lineageTail(c);
  return (
    <header className="flex min-w-0 flex-col gap-0.5 border-b border-pane-border px-4 pt-2 pb-2.5 @max-[340px]:px-3" data-testid="threads-header">
      <h2 className="flex min-w-0 items-center gap-1.5 text-heading">
        <Network className="size-4 shrink-0 text-info" aria-hidden />
        <span className="min-w-0 truncate">Threads</span>
        {related > 0 && (
          <span className="ml-auto shrink-0 text-caption tabular-nums" data-testid="threads-count">
            {related} related
          </span>
        )}
      </h2>
      {related > 0 && (
        <span className="flex min-h-5 min-w-0 items-center gap-1.5 text-caption" data-testid="threads-subline">
          {c.creator && <CornerDownRight className="size-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 truncate">
            {c.creator === "created" ? (
              <>
                Created by <span className="font-medium text-foreground">{c.creatorName}</span>
              </>
            ) : c.creator === "removed" ? (
              "Created by a removed thread"
            ) : (
              "Created by you"
            )}
            {tail && ` · ${tail}`}
          </span>
        </span>
      )}
    </header>
  );
}

/**
 * The side panel's Threads surface (/tmp/cf-lineage-sketch variant C,
 * docs/notes/agents-3-lineage-gui.md): the selected thread's lineage in flat sections,
 * Created by, This thread, Siblings (capped) and Children, each related thread with its
 * status, place, age and brief, in spawn order. Derived from the thread list; archived
 * threads included, muted. A thread no agent made and that made none says so instead.
 */
export function ThreadsSurface() {
  const threadId = useThreadId();
  const known = useThreadsStore((s) => threadId !== "" && threadId in s.byId);
  const c = useLineageCounts(threadId);
  if (!known)
    return (
      <p className="px-4 py-3 text-body text-muted-foreground @max-[340px]:px-3" data-testid="threads-missing">
        Select a thread to see the threads related to it.
      </p>
    );
  const empty = relatedCount(c) === 0;
  return (
    <div className="@container flex min-w-0 flex-col pb-4" data-testid="threads-surface" data-thread={threadId}>
      <Header threadId={threadId} />
      {empty ? (
        <div className="flex flex-col gap-1.5 px-4 py-3.5 @max-[340px]:px-3" data-testid="threads-empty">
          <p className="text-body-sm">Created by you. No threads created from here.</p>
          <p className="text-caption">
            When an agent in this thread runs <code className="text-code text-foreground">code-foundry thread new</code>, the threads it starts show here, with their status.
          </p>
        </div>
      ) : (
        <>
          <CreatedBy threadId={threadId} />
          <Section id="this" label="This thread">
            <LineageRow id={threadId} me />
          </Section>
          <Siblings threadId={threadId} />
          <Children threadId={threadId} />
        </>
      )}
    </div>
  );
}

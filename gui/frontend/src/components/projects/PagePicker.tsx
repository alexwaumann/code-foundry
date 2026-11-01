import { ChevronDown, ChevronRight } from "lucide-react";
import { shortAge } from "@/components/prs/format";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { addProject } from "@/stores/projectActions";
import { useProjectsStore } from "@/stores/projects";
import { projectPage, PROJECTS_INDEX, useUiStore, workspacePage } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { KindIcon, WorkspaceIcon } from "./bits";
import { useProjectKind } from "@/components/icons/projectKind";
import { useProjectLastMs, useProjectOrder, useWorkspaceLastMs, useWorkspaceOrder } from "./useOrder";

/** "Projects ›": the crumb back to the index (muted; a click goes there). */
export function ProjectsCrumb() {
  return (
    <>
      <button
        type="button"
        className="shrink-0 rounded-sm text-body-sm text-cf-text-muted hover:text-cf-text"
        data-testid="projects-crumb"
        onClick={() => {
          useUiStore.getState().select(PROJECTS_INDEX);
        }}
      >
        Projects
      </button>
      <ChevronRight className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
    </>
  );
}

function AgeText({ ms }: { ms: number | null }) {
  const now = useNow(30_000);
  return <span className="ml-auto pl-4 text-caption text-cf-text-muted tabular-nums">{ms === null ? "" : shortAge(ms, now)}</span>;
}

function ProjectItem({ id, current }: { id: string; current: boolean }) {
  const name = useProjectsStore((s) => s.byId[id]?.name ?? id);
  const kind = useProjectKind(id);
  const last = useProjectLastMs(id);
  return (
    <DropdownMenuItem
      data-testid="page-picker-project"
      data-project={id}
      data-current={current || undefined}
      className={cn(current && "bg-cf-control-active")}
      onSelect={() => {
        if (!current) useUiStore.getState().select(projectPage(id));
      }}
    >
      <KindIcon kind={kind} />
      <span className="min-w-0 truncate">{name}</span>
      <AgeText ms={last} />
    </DropdownMenuItem>
  );
}

function WorkspaceItem({ id, current }: { id: string; current: boolean }) {
  const name = useWorkspacesStore((s) => s.byId[id]?.name ?? id);
  const last = useWorkspaceLastMs(id);
  return (
    <DropdownMenuItem
      data-testid="page-picker-workspace"
      data-workspace={id}
      data-current={current || undefined}
      className={cn(current && "bg-cf-control-active")}
      onSelect={() => {
        if (!current) useUiStore.getState().select(workspacePage(id));
      }}
    >
      <WorkspaceIcon />
      <span className="min-w-0 truncate">{name}</span>
      <AgeText ms={last} />
    </DropdownMenuItem>
  );
}

/**
 * The page's name with a chevron: a menu of every project (by last activity, as the index
 * orders them), then every workspace, then Add project…; picking one shows its page.
 */
export function PagePicker({ icon, name, currentProject = "", currentWorkspace = "" }: { icon: React.ReactNode; name: string; currentProject?: string; currentWorkspace?: string }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex max-w-[50%] min-w-0 shrink-0 items-center gap-2 rounded-md px-1 py-0.5 hover:bg-cf-control-hover aria-expanded:bg-cf-control-hover"
          data-testid="page-picker"
          aria-label={`${name}: switch project or workspace`}
        >
          {icon}
          <span className="min-w-0 truncate text-heading" data-testid="page-name">
            {name}
          </span>
          <ChevronDown className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <PickerContent currentProject={currentProject} currentWorkspace={currentWorkspace} />
    </DropdownMenu>
  );
}

/** The menu's items, mounted only while it is open (so the closed header subscribes to nothing more). */
function PickerContent({ currentProject, currentWorkspace }: { currentProject: string; currentWorkspace: string }) {
  const projects = useProjectOrder();
  const workspaces = useWorkspaceOrder();
  return (
    <DropdownMenuContent
      align="start"
      className="max-h-[70vh] min-w-72 overflow-y-auto"
      data-testid="page-picker-menu"
      onCloseAutoFocus={(e) => {
        // Back to the page's list, not the trigger (the page's keys live there).
        e.preventDefault();
        document.querySelector<HTMLElement>('[data-testid="projects-page"] [data-focus-root]')?.focus({ preventScroll: true });
      }}
    >
      {projects.map((id) => (
        <ProjectItem key={id} id={id} current={id === currentProject} />
      ))}
      {workspaces.length > 0 && <DropdownMenuSeparator />}
      {workspaces.map((id) => (
        <WorkspaceItem key={id} id={id} current={id === currentWorkspace} />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-cf-text-muted"
        data-testid="page-picker-add-project"
        onSelect={() => {
          addProject();
        }}
      >
        Add project
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

import { useRef, useState } from "react";
import { Ellipsis, GitBranchPlus, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { useNoProjectThread } from "@/components/thread/useNoProject";
import { composeLike } from "@/stores/compose";
import { openSaveWorkspace, useCanSaveAsWorkspace } from "@/stores/saveWorkspace";

/**
 * The thread header's "More" menu: "New thread on this branch" (thread.new-like's
 * presentation: the composer prefilled with this thread's set, branch, primary,
 * workspace and mode) and, for a thread of two or more projects that matches no saved
 * workspace, "Save as workspace…" (stores/saveWorkspace.ts). None for a thread without a
 * project. What was picked runs once the menu has closed and handed focus back.
 */
export function ThreadMenu({ threadId }: { threadId: string }) {
  const noProject = useNoProjectThread(threadId);
  const canSave = useCanSaveAsWorkspace(threadId);
  const [open, setOpen] = useState(false);
  const picked = useRef<(() => void) | null>(null);
  if (noProject) return null;
  const pick = (run: () => void) => {
    picked.current = run;
    setOpen(false);
  };
  const label = "More";
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            tabIndex={-1}
            data-testid="pane-thread-menu"
            className="[--wails-draggable:no-drag] aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text dark:aria-expanded:bg-cf-control-hover/50"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
          >
            <Ellipsis aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        data-testid="pane-thread-menu-items"
        onCloseAutoFocus={(e) => {
          const run = picked.current;
          picked.current = null;
          if (!run) return;
          e.preventDefault();
          run();
        }}
      >
        <DropdownMenuItem
          data-testid="menu-new-like"
          onSelect={() => {
            pick(() => {
              composeLike(threadId);
            });
          }}
        >
          <GitBranchPlus />
          New thread on this branch
        </DropdownMenuItem>
        {canSave && (
          <DropdownMenuItem
            data-testid="menu-save-workspace"
            onSelect={() => {
              pick(() => {
                openSaveWorkspace(threadId);
              });
            }}
          >
            <Layers />
            Save as workspace…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

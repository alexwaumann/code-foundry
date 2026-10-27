import { TriangleAlert } from "lucide-react";
import { COLLISION_DETAIL, collisionBanner, collisionTip, type Collision } from "@/lib/collisionHints";

/**
 * The one banner above the composer card while another running thread has a checkout this
 * draft would work in (lib/collisionHints collisionBanner): never a list, never a blocker.
 * `onNewBranch` (absent when the draft cannot take a new branch, or already does) switches
 * Work in to a new branch with its own worktrees.
 */
export function CollisionBanner({ list, setSize, onNewBranch, disabled }: { list: readonly Collision[]; setSize: number; onNewBranch?: () => void; disabled?: boolean }) {
  if (list.length === 0) return null;
  const { lead, branch, tail } = collisionBanner(list, setSize);
  return (
    // Frosted like the card below it, so the backdrop does not show through the tint.
    <div role="status" className="mb-2 flex items-start gap-2.5 rounded-lg border border-cf-warning/35 bg-cf-warning/7 px-3 py-2 text-body-sm backdrop-blur-xl" data-testid="composer-collision">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-cf-warning-text" aria-hidden />
      <p className="min-w-0 flex-1 text-pretty" data-testid="composer-collision-text">
        <span className="font-medium">
          {lead}
          {branch && <span className="font-mono">{branch}</span>}
          {tail}
        </span>{" "}
        <span className="text-cf-text-muted">{COLLISION_DETAIL}</span>
      </p>
      {onNewBranch && (
        <button
          type="button"
          disabled={disabled}
          data-compose-stop
          data-testid="composer-collision-new-branch"
          className="shrink-0 rounded-sm text-link outline-none focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:pointer-events-none disabled:opacity-50"
          onClick={onNewBranch}
        >
          Use a new branch
        </button>
      )}
    </div>
  );
}

/**
 * A tooltip's lines for collisions (the Work in pill's: every one; a member chip's: its
 * project's): "<project> · <branch> is open in <thread> (working | idle)".
 */
export function CollisionTip({ list }: { list: readonly Collision[] }) {
  return (
    <span className="flex flex-col gap-0.5">
      {list.map((c) => {
        const t = collisionTip(c);
        return (
          <span key={c.projectId} data-testid="composer-collision-tip-line">
            {t.place} is open in <span className="font-semibold">{t.thread}</span> ({t.status})
          </span>
        );
      })}
    </span>
  );
}

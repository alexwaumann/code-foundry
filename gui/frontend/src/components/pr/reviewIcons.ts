import { Check, CircleCheck, CircleX, MessageSquare, type LucideIcon } from "lucide-react";
import type { Verdict, YourReview } from "./review";

/**
 * Each verdict's icons: `icon` in the Review menu and the composer's label, `button` on
 * the composer's submit button. They differ only for Approve, whose button has the plain
 * check of the sketch.
 */
export const verdictIcons: Record<Verdict, { icon: LucideIcon; button: LucideIcon }> = {
  approve: { icon: CircleCheck, button: Check },
  "request-changes": { icon: CircleX, button: CircleX },
  comment: { icon: MessageSquare, button: MessageSquare },
};

/** The header chip's icon for the viewer's latest review. */
export const yourReviewIcon: Record<YourReview, LucideIcon> = { approved: CircleCheck, changes_requested: CircleX, commented: MessageSquare };

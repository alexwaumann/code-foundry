import { CircleCheck, CircleX, MessageSquare } from "lucide-react";
import type { Verdict, YourReview } from "./review";

/** Each verdict's icon in the Review menu and its composer's label. */
export const verdictIcon: Record<Verdict, typeof CircleCheck> = { approve: CircleCheck, "request-changes": CircleX, comment: MessageSquare };

/** The header chip's icon for the viewer's latest review. */
export const yourReviewIcon: Record<YourReview, typeof CircleCheck> = { approved: CircleCheck, changes_requested: CircleX, commented: MessageSquare };

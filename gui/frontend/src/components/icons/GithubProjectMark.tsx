import type { SVGProps } from "react";
import { cn } from "@/lib/utils";
import { GithubMark } from "./GithubMark";

/** A GitHub project's kind icon: the GitHub mark in the info tint, which a caller's colour does not override (projectKind.ts). */
export function GithubProjectMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return <GithubMark {...props} className={cn(className, "text-cf-info-text/90")} />;
}

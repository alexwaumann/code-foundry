import type { SVGProps } from "react";

/** Claude's orange. */
export const CLAUDE_ORANGE = "#d97757";

/**
 * The Claude starburst as a line icon: twelve rays of uneven length around the centre of a
 * 24×24 box, round caps, stroke 2.6 (lucide-like sizing via className). Colour comes from
 * `currentColor`; callers usually set CLAUDE_ORANGE.
 */
export function ClaudeMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...props}
    >
      <path d="M12.0 9.4L12.0 2.0" />
      <path d="M13.3 9.7L15.8 5.5" />
      <path d="M14.3 10.7L19.8 7.5" />
      <path d="M14.6 12.0L20.0 12.0" />
      <path d="M14.3 13.3L20.7 17.0" />
      <path d="M13.3 14.3L15.5 18.1" />
      <path d="M12.0 14.6L12.0 21.5" />
      <path d="M10.7 14.3L8.0 18.9" />
      <path d="M9.7 13.3L3.3 17.0" />
      <path d="M9.4 12.0L4.5 12.0" />
      <path d="M9.7 10.7L4.2 7.5" />
      <path d="M10.7 9.7L8.0 5.1" />
    </svg>
  );
}

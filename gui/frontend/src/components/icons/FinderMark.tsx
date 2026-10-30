import type { SVGProps } from "react";

/**
 * Finder as a lucide-style line icon (the thread info card's "Open in Finder";
 * docs/sketches/thread-info): a rounded square with two eyes and a smile. 24×24, stroke 2,
 * round caps, `currentColor`. Size via className.
 */
export function FinderMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...props}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 9v1" />
      <path d="M16 9v1" />
      <path d="M8 15c1.5 1.5 6.5 1.5 8 0" />
    </svg>
  );
}

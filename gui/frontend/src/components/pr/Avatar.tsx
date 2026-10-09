import { useState } from "react";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { avatarFor } from "./model";

/**
 * A GitHub avatar. Falls back to the login's initial (a team icon for "org/team", "?"
 * for a deleted account) when there is no URL or the image fails to load (offline).
 */
export function Avatar({ login, src = "", size = 20, className }: { login: string; src?: string; size?: number; className?: string }) {
  const url = avatarFor(login, src);
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size };
  if (url && failed !== url) {
    return (
      <img
        src={url}
        alt=""
        style={style}
        className={cn("shrink-0 rounded-full bg-muted object-cover", className)}
        loading="lazy"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => {
          setFailed(url);
        }}
      />
    );
  }
  const team = login.includes("/");
  return (
    <span
      aria-hidden
      style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.45)) }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground uppercase", className)}
    >
      {team ? <Users style={{ width: size * 0.6, height: size * 0.6 }} /> : login ? login.charAt(0) : "?"}
    </span>
  );
}

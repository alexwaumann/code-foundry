/**
 * The app's Tailwind theme for pages (docs/notes/page-library.md), read from index.css at
 * build time so a page's utility names are the app's without a second copy: the
 * `@theme inline` block (bg-cf-*, the shadcn names, the radius scale) and the type roles
 * (`@utility text-body`, …). vite.pagelib.config.ts puts them in /cf/ui.css and in
 * /cf/tailwind.js's runtime theme; the values are var()s of the slots /cf/theme.css sets.
 * The dark variant stays Tailwind's (prefers-color-scheme): a frame's scheme is the app's.
 */

/** The body of the `{` at open, and the index after its matching `}`. */
function block(css: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
  }
  throw new Error("index.css: unbalanced braces");
}

/** Roles a page has no use for: the sidebar's app name. */
const SKIPPED_ROLES = new Set(["text-brand"]);

/** index.css's `@theme inline { … }`, its `@utility text-*` roles and its `cf-*` keyframes, as CSS text. */
export function appTheme(indexCss: string): string {
  const head = "@theme inline {";
  const at = indexCss.indexOf(head);
  if (at < 0) throw new Error("index.css: no @theme inline block");
  const theme = block(indexCss, at + head.length - 1);
  const out = [head + theme.body + "}"];
  const re = /@utility (text-[a-z0-9-]+)\s*\{/g;
  for (let m = re.exec(indexCss); m; m = re.exec(indexCss)) {
    const { body, end } = block(indexCss, m.index + m[0].length - 1);
    re.lastIndex = end;
    if (!SKIPPED_ROLES.has(m[1] ?? "")) out.push(`@utility ${m[1] ?? ""} {${body}}`);
  }
  if (out.length < 2) throw new Error("index.css: no type roles");
  // The app's own animations (Progress's indeterminate bar reads cf-indeterminate).
  const kf = /@keyframes (cf-[a-z0-9-]+)\s*\{/g;
  for (let m = kf.exec(indexCss); m; m = kf.exec(indexCss)) {
    const { body, end } = block(indexCss, m.index + m[0].length - 1);
    kf.lastIndex = end;
    out.push(`@keyframes ${m[1] ?? ""} {${body}}`);
  }
  return out.join("\n") + "\n";
}

/** The `--color-cf-*` names index.css's @theme exposes (bg-cf-surface, text-cf-text-muted, …). */
export function cfColours(indexCss: string): string[] {
  return [...new Set([...indexCss.matchAll(/--color-(cf-[a-z0-9-]+):/g)].map((m) => m[1] ?? ""))];
}

/** The type roles a page may use (index.css's, without the sidebar's). */
export function typeRoleNames(indexCss: string): string[] {
  return [...indexCss.matchAll(/@utility (text-[a-z0-9-]+)\s*\{/g)].map((m) => m[1] ?? "").filter((r) => !SKIPPED_ROLES.has(r));
}

const SPACE = "0,0.5,1,1.5,2,2.5,3,4,5,6,8,10,12,16";

/**
 * Utilities /cf/ui.css carries beyond what the components use, so a React page's own layout
 * works without the runtime: the cf colours (and hover), the type roles, the radius scale
 * and the everyday layout, spacing and sizing classes. Anything else needs /cf/tailwind.js.
 * Tailwind's `@source inline()` brace syntax.
 */
export function pageSafelist(indexCss: string): string {
  const colours = cfColours(indexCss).join(",");
  const patterns = [
    `{,hover:}{bg,text,border}-{${colours}}`,
    `{fill,stroke}-{${colours}}`,
    `{bg,text,border}-{background,foreground,card,card-foreground,popover,muted,muted-foreground,primary,primary-foreground,secondary,accent,destructive,border}`,
    `{${typeRoleNames(indexCss).join(",")}}`,
    "rounded{,-t,-b,-l,-r}-{none,sm,md,lg,pane,2xl,full}",
    "{block,inline-block,inline,flex,inline-flex,grid,inline-grid,contents,hidden,table}",
    "flex-{row,col,wrap,1,auto,none} {grow,shrink,shrink-0,grow-0}",
    "items-{start,center,end,stretch,baseline} justify-{start,center,end,between,around,evenly} self-{start,center,end,stretch} content-{start,center,between}",
    `{gap,gap-x,gap-y}-{${SPACE}}`,
    `{p,px,py,pt,pb,pl,pr}-{${SPACE}}`,
    `{m,mx,my,mt,mb,ml,mr}-{${SPACE},auto}`,
    "{space-x,space-y}-{1,2,3,4,6}",
    "{w,h}-{full,auto,fit,screen,px,0,1,2,3,4,5,6,8,10,12,16,20,24,32,40,48,64,80,96}",
    "{min-w,min-h}-{0,full,fit} max-w-{xs,sm,md,lg,xl,2xl,3xl,4xl,5xl,6xl,7xl,full,prose,none} max-h-{full,screen,64,80,96}",
    "size-{3,3.5,4,5,6,8,10,12}",
    "{,sm:,md:,lg:}grid-cols-{1,2,3,4,5,6,12} {,sm:,md:,lg:}col-span-{1,2,3,4,6,full} {sm:,md:,lg:}{flex,hidden,block,flex-row,flex-col}",
    "overflow-{auto,hidden,visible,x-auto,y-auto} truncate whitespace-{nowrap,normal,pre-wrap} break-{words,all} line-clamp-{1,2,3}",
    "text-{left,center,right} font-{normal,medium,semibold,bold} tabular-nums uppercase italic underline no-underline",
    "border{,-0,-2,-t,-b,-l,-r,-x,-y} border-{dashed,solid} divide-{x,y} divide-cf-{border,divider}",
    "shadow{,-xs,-sm,-md,-lg,-xl,-none} opacity-{0,50,60,70,80,100}",
    "{relative,absolute,fixed,sticky,static} {inset,top,bottom,left,right}-{0,2,4} z-{0,10,20,50}",
    "cursor-{pointer,default,not-allowed} select-{none,text} pointer-events-none sr-only",
    "transition{,-colors,-opacity,-transform} duration-{150,200,300} animate-{spin,pulse}",
    "{hover:,}underline {hover:,}opacity-80 disabled:opacity-50",
  ];
  return patterns.map((p) => `@source inline("${p}");`).join("\n") + "\n";
}

/**
 * CSS for inside @pierre/diffs' shadow root, given to every CodeFile and CodeDiff as the
 * library's `unsafeCSS`: the page's stylesheets stop at the shadow boundary (custom
 * properties inherit, so the theme's slots are read here).
 *
 * Code is text to copy. The body's `-webkit-user-select: none` inherits into the shadow
 * root, so only the code column opts back in: line numbers stay out of a selection even
 * when a drag starts on them. The library marks its gutter, separators and buffers
 * `user-select: none`, which WebKit ignores without the prefix, hence the prefixed rule for
 * those inside the column. The selection takes the app's colour; in the File tab's editor
 * the library's own unlayered `::selection` (transparent: it draws its selection itself)
 * wins over this layered one.
 *
 * The File tab's find paints its matches in here with the Custom Highlight API
 * (components/files/fileFindPaint.ts); a `::highlight` rule applies only in its own tree,
 * so the thread find's tints (thread/find/find.css) are repeated for the shadow root.
 */
export const CODE_SHADOW_CSS = `
[data-content] { -webkit-user-select: text; user-select: text; cursor: text; }
[data-content-buffer], [data-separator-wrapper], [data-separator-content], [data-merge-conflict-action-separator], [data-annotation-content] { -webkit-user-select: none; user-select: none; cursor: default; }
::selection { background-color: var(--cf-selection); }
::highlight(cf-file-find) { background-color: color-mix(in oklab, var(--cf-warning) 26%, transparent); }
::highlight(cf-file-find-current) { background-color: var(--cf-warning); color: var(--cf-warning-foreground); }
`;

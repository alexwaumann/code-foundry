/**
 * A pull request's `owner/repo #number`, the number a step brighter: the page header's top
 * line and the merge and review dialogs' quiet line say it in this one form.
 */
export function RepoRef({ slug, number }: { slug: string; number: number }) {
  return (
    <>
      {slug} <span className="text-cf-text-secondary">#{number}</span>
    </>
  );
}

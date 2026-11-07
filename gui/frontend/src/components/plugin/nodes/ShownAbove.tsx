/** What a thread or terminal node shows when an earlier node of the view already shows it (components/plugin/live.ts useRepeated). */
export function ShownAbove() {
  return (
    <p className="m-auto px-4 py-2 text-center text-caption" data-testid="plugin-repeat">
      Shown above.
    </p>
  );
}

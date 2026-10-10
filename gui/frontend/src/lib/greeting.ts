/** The start page's heading for a local hour (0–23): morning before 12, afternoon before 18. */
export function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

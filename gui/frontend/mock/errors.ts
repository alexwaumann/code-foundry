/** A command failure with the Connect code the daemon would use (mock/server.ts maps kind to it). */
export class CommandError extends Error {
  constructor(
    readonly kind: "unavailable" | "invalid" | "notfound",
    message: string,
  ) {
    super(message);
  }
}

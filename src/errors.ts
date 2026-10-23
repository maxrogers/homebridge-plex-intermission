/** A short, readable description of anything thrown. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

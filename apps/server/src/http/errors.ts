/**
 * Errors leave the server as a stable code with values, never as a sentence,
 * a stack trace or SQL (ARC-08, SCR-04). Codes are the web application's
 * catalogue keys (cahier des charges, Annex F).
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly values: Record<string, string | number> = {},
  ) {
    super(code)
    this.name = "AppError"
  }
}

export const notFound = () => new AppError(404, "err_notFound")

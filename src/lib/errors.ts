/**
 * Errors surfaced to the model. `code` is machine-readable; `hint` tells the assistant what to do next.
 * `upgrade_url` is set when a plan limit was hit so the assistant can relay it.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'ambiguous'
      | 'invalid'
      | 'locked'
      | 'plan_limit'
      | 'forbidden'
      | 'conflict'
      | 'upstream'
      | 'not_configured',
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  toJSON() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

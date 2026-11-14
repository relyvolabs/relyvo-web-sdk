/** One error type for every failure this SDK produces. */
export class RelyvoError extends Error {
  /** Stable machine code. RPC failures carry the chat service's code. */
  readonly code: string;
  /** Transport-level cause, when there is one. */
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RelyvoError";
    this.code = code;
    this.cause = cause;
  }
}

export function isRelyvoError(error: unknown): error is RelyvoError {
  return error instanceof RelyvoError;
}

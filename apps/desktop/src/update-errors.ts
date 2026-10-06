export class UpdateHandoffError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "UpdateHandoffError";
  }
}

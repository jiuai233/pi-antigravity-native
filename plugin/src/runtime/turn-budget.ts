/** Renewable model-step budget, excluding time blocked on Pi bridge results. */
export class AgyTurnBudget {
  #remaining: number;
  #timeoutMs: number;
  lastToolCompletedAtMs: number | undefined;
  #startedAt = Date.now();
  #waiting = new Set<string>();
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  #onTimeout: () => void;

  constructor(timeoutMs: number, onTimeout: () => void) {
    this.#onTimeout = onTimeout;
    this.#remaining = this.#timeoutMs = timeoutMs;
    this.#arm();
  }

  get paused(): boolean {
    return this.#waiting.size > 0;
  }

  remainingMs(): number {
    const elapsed = this.paused || this.#disposed ? 0 : Date.now() - this.#startedAt;
    return Math.max(0, this.#remaining - elapsed);
  }

  pause(callId: string): void {
    if (this.#disposed || this.#waiting.has(callId)) return;
    if (!this.paused) this.#remaining = this.remainingMs();
    this.#waiting.add(callId);
    if (this.#waiting.size !== 1) return;
    clearTimeout(this.#timer);
    for (const listener of this.#listeners) listener();
  }

  resume(callId: string, completed = false): void {
    if (this.#disposed || !this.#waiting.delete(callId)) return;
    if (completed) this.renew();
    if (this.paused) return;
    this.#startedAt = Date.now();
    clearTimeout(this.#timer);
    this.#arm();
    for (const listener of this.#listeners) listener();
  }

  /** A reported tool result starts the next model step's budget. Bytes alone do not. */
  renew(): void {
    if (this.#disposed) return;
    this.lastToolCompletedAtMs = Date.now();
    this.#remaining = this.#timeoutMs;
    this.#startedAt = Date.now();
    clearTimeout(this.#timer);
    if (!this.paused) this.#arm();
    for (const listener of this.#listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  dispose(): void {
    this.#remaining = this.remainingMs();
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#listeners.clear();
  }

  #arm(): void {
    this.#timer = setTimeout(this.#onTimeout, this.#remaining);
  }
}

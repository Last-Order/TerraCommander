interface LazyServiceOptions<T> {
  create: (signal: AbortSignal) => T | Promise<T>;
  dispose: (instance: T) => void | Promise<void>;
}

export class ServiceClosedError extends Error {
  constructor() {
    super('This application service is closed.');
    this.name = 'ServiceClosedError';
  }
}

/** Owns one shared initialization attempt and, on success, one service instance. */
export class LazyService<T> {
  private readonly lifetime = new AbortController();
  private initialization: Promise<T> | undefined;
  private instance: { value: T } | undefined;
  private disposal: Promise<void> | undefined;

  constructor(private readonly options: LazyServiceOptions<T>) {}

  async get(signal?: AbortSignal): Promise<T> {
    this.assertAccessible(signal);
    const pending = this.initialization ?? this.initialize();
    const instance = await this.waitForInitialization(pending, signal);
    this.assertAccessible(signal);
    return instance;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;

    // Reserve cleanup before aborting: abort listeners can re-enter dispose().
    this.disposal = Promise.resolve().then(() => this.disposeInstance());
    this.lifetime.abort(new ServiceClosedError());
    return this.disposal;
  }

  private initialize(): Promise<T> {
    // Defer factory work until the shared promise is installed. A synchronous
    // factory and concurrent first callers follow the same ownership rules.
    const pending = Promise.resolve().then(async () => {
      this.lifetime.signal.throwIfAborted();
      const value = await this.options.create(this.lifetime.signal);
      this.instance = { value };
      // A late result belongs to cleanup, never to a waiting business caller.
      this.lifetime.signal.throwIfAborted();
      return value;
    });
    this.initialization = pending;
    void pending.catch(() => {
      if (!this.lifetime.signal.aborted && this.initialization === pending) {
        this.initialization = undefined;
      }
    });
    return pending;
  }

  private waitForInitialization(pending: Promise<T>, caller?: AbortSignal): Promise<T> {
    const signal = caller ? AbortSignal.any([caller, this.lifetime.signal]) : this.lifetime.signal;

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(this.cancellationError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void pending.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) reject(this.cancellationError());
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(signal.aborted ? this.cancellationError() : error);
        },
      );
    });
  }

  private cancellationError(): Error {
    return this.lifetime.signal.aborted
      ? new ServiceClosedError()
      : new DOMException('The service request was cancelled.', 'AbortError');
  }

  private assertAccessible(signal?: AbortSignal): void {
    if (this.lifetime.signal.aborted || signal?.aborted) throw this.cancellationError();
  }

  private async disposeInstance(): Promise<void> {
    try {
      // Initialization errors belong to get(). Cleanup still waits for a factory
      // that ignores cancellation and returns an instance after shutdown starts.
      await this.initialization?.catch(() => undefined);
      const instance = this.instance;
      this.instance = undefined;
      if (instance) await this.options.dispose(instance.value);
    } finally {
      this.instance = undefined;
      this.initialization = undefined;
    }
  }
}

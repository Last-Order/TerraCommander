import type { OperationContext } from '../../storage/core/contracts';
import { assertNotCancelled, AccountError } from './errors';

/** Cancelling one waiter must not cancel a refresh shared by other operations. */
export function waitForAccountOperation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  void work.catch(() => undefined);
  assertNotCancelled(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      try {
        assertNotCancelled(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function accountOperationScope(
  context: OperationContext,
  lifetime: AbortSignal,
  timeoutMs?: number,
): { context: OperationContext; dispose(): void } {
  const deadline = new AbortController();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          deadline.abort(new AccountError('Timeout'));
        }, timeoutMs);
  timer?.unref();

  const signals = [lifetime, deadline.signal];
  if (context.signal) signals.push(context.signal);
  return {
    context: { ...context, signal: AbortSignal.any(signals) },
    dispose: () => clearTimeout(timer),
  };
}

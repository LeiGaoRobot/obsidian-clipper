import { AiError, isAiError } from './errors';

// Cancellation helpers shared by the background, the runtime and the Reader. A cancelled request
// always rejects with AiError('cancelled'), so callers check `code` instead of matching names or
// messages. Pure: no DOM, storage or browser runtime imports.

/** Throws AiError('cancelled') when `signal` is already aborted. */
export function throwIfRequestAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AiError('cancelled');
}

/** True for AiError('cancelled') and for a DOM `AbortError` (a `fetch` abort). */
export function isCancellation(error: unknown): boolean {
	if (isAiError(error)) return error.code === 'cancelled';
	return error instanceof Error && error.name === 'AbortError';
}

/**
 * Settles with `promise`, or rejects with AiError('cancelled') as soon as `signal` aborts. The
 * underlying work is not stopped; the caller stops waiting for it.
 */
export function raceWithRequestCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	throwIfRequestAborted(signal);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			callback();
		};
		const onAbort = () => settle(() => reject(new AiError('cancelled')));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			value => settle(() => resolve(value)),
			error => settle(() => reject(error))
		);
	});
}

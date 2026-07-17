export class RequestCancelledError extends Error {
	constructor() {
		super('The request was cancelled.');
		this.name = 'AbortError';
	}
}

export function throwIfRequestAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new RequestCancelledError();
}

export function isRequestCancelled(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const candidate = error as { name?: unknown; message?: unknown };
	return candidate.name === 'AbortError'
		|| candidate.name === 'RequestCancelledError'
		|| candidate.message === 'The request was cancelled.';
}

export function raceWithRequestCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	throwIfRequestAborted(signal);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			reject(new RequestCancelledError());
		};
		const finish = (callback: (value: T) => void, value: T) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			callback(value);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			value => finish(resolve, value),
			error => {
				if (settled) return;
				settled = true;
				signal.removeEventListener('abort', onAbort);
				reject(error);
			}
		);
	});
}

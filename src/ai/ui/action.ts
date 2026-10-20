import { toAiError, type AiError } from '../errors';

// The one run / cancel / retry state machine behind every AI entry point (popup Interpreter, AI
// edit, Reader). Pure: no DOM, storage, or browser imports, so any context can bundle it. It never
// starts a run on its own; `start` and `retry` are called only from explicit user actions.

export type AiActionStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface AiActionProgress {
	completed: number;
	total: number;
	/** A backoff after a retryable provider error. */
	retry?: { delayMs: number; attempt: number };
}

export interface AiActionState<P = AiActionProgress> {
	status: AiActionStatus;
	/** When the latest run started, for the view's elapsed time. */
	startedAt?: number;
	/** The latest progress report; kept after the run ends, e.g. for Continue remaining (n of m). */
	progress?: P;
	error?: AiError;
}

export type AiActionRun<T, P = AiActionProgress> = (signal: AbortSignal, report: (progress: P) => void) => Promise<T>;

export interface AiAction<T, P = AiActionProgress> {
	readonly state: AiActionState<P>;
	/**
	 * Aborts a previous run, then runs `run`. Resolves with its value when it is `done`, or with
	 * undefined once it ends otherwise: cancelled, failed, superseded by a newer `start`, or disposed.
	 */
	start(run: AiActionRun<T, P>): Promise<T | undefined>;
	/** Runs the last `run` again with a fresh signal and no progress. Undefined when nothing ran yet. */
	retry(): Promise<T | undefined>;
	/** Aborts the running run; the state becomes `cancelled` at once and its settlement is ignored. */
	cancel(): void;
	/** Cancels, then ignores every later settlement, `start`, and `retry`. */
	dispose(): void;
}

export interface AiActionOptions<P = AiActionProgress> {
	/** Called on every transition with the state it replaced, so a view can clear what it drew. */
	onChange?: (state: AiActionState<P>, previous: AiActionState<P>) => void;
	now?: () => number;
}

interface Attempt<T> {
	controller: AbortController;
	/** Settles the attempt's `start` promise; the first call wins. */
	finish: (value: T | undefined) => void;
}

export function createAiAction<T, P = AiActionProgress>(options: AiActionOptions<P> = {}): AiAction<T, P> {
	const now = options.now ?? Date.now;
	let state: AiActionState<P> = { status: 'idle' };
	let current: Attempt<T> | undefined;
	let lastRun: AiActionRun<T, P> | undefined;
	let disposed = false;

	const set = (next: AiActionState<P>) => {
		const previous = state;
		state = next;
		options.onChange?.(next, previous);
	};

	// The ended state of the latest run: its start time and last progress stay for the view.
	const ended = (status: Exclude<AiActionStatus, 'idle' | 'running'>, error?: AiError): AiActionState<P> => ({
		status,
		...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
		...(state.progress !== undefined ? { progress: state.progress } : {}),
		...(error ? { error } : {})
	});

	/** Ends the running attempt: aborts it and settles its `start` promise with undefined. */
	const stop = (): boolean => {
		const attempt = current;
		if (!attempt) return false;
		current = undefined;
		attempt.controller.abort();
		attempt.finish(undefined);
		return true;
	};

	const cancel = () => {
		if (stop()) set(ended('cancelled'));
	};

	const start = (run: AiActionRun<T, P>): Promise<T | undefined> => {
		if (disposed) return Promise.resolve(undefined);
		// A superseded run is aborted without a `cancelled` transition: the new run replaces it.
		stop();
		lastRun = run;
		let finish!: (value: T | undefined) => void;
		const settled = new Promise<T | undefined>(resolve => {
			let done = false;
			finish = value => {
				if (done) return;
				done = true;
				resolve(value);
			};
		});
		const attempt: Attempt<T> = { controller: new AbortController(), finish };
		current = attempt;
		const { signal } = attempt.controller;
		set({ status: 'running', startedAt: now() });

		const report = (progress: P) => {
			if (current !== attempt) return;
			set({ ...state, progress });
		};
		let running: Promise<T>;
		try {
			running = Promise.resolve(run(signal, report));
		} catch (error) {
			running = Promise.reject(error);
		}
		running.then(
			value => {
				if (current !== attempt) return;
				current = undefined;
				set(ended('done'));
				finish(value);
			},
			error => {
				if (current !== attempt) return;
				current = undefined;
				const aiError = toAiError(error);
				set(signal.aborted || aiError.code === 'cancelled' ? ended('cancelled') : ended('error', aiError));
				finish(undefined);
			}
		);
		return settled;
	};

	return {
		get state() {
			return state;
		},
		start,
		retry() {
			return lastRun ? start(lastRun) : Promise.resolve(undefined);
		},
		cancel,
		dispose() {
			cancel();
			disposed = true;
		}
	};
}

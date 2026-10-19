import { inferConnectionKind, isCliKind } from '../../ai/connection-kind';
import {
	AI_CONNECTIONS_KEY,
	AI_CONNECTION_STATUS_KEY,
	AI_CREDENTIALS_KEY,
	AI_INTERPRETER_KEY,
	AI_PROFILES_KEY,
	AI_PROMPT_CONTEXT_KEY,
	AI_ROUTING_KEY,
	type AiSettingsSnapshot,
	type AiSettingsStore,
	type AiStorageKey
} from '../../ai/settings';
import type {
	AiRouting,
	AiSettingsView,
	AiTask,
	CliConnectionKind,
	Connection,
	ConnectionStatus,
	ModelProfile,
	ModelProfileOptions
} from '../../ai/types';
import type { CodexReasoningEffort } from '../../types/types';

// The AI settings section's state and mutations. It holds the current view, and every mutation
// writes through the v2 store (the only AI settings writer) before the view changes, so a refused
// write leaves the view as it is stored. Mutations run one at a time. DOM-free.

export interface AiSettingsState {
	view: AiSettingsView;
	connectionStatus: Record<string, ConnectionStatus>;
	/** `derived` while no v2 items exist on this device; the store then refuses every write. */
	mode: 'stored' | 'derived';
}

export interface ConnectionDraft {
	/** Catalog entry the connection was created from; keeps its wire protocol. */
	presetId?: string;
	label: string;
	baseUrl: string;
	/** The API key typed in the dialog. Blank removes the key on this device. */
	apiKey: string;
	apiKeyRequired: boolean;
	/** Blank (undefined) uses the default for the connection kind. */
	maxConcurrency?: number;
}

export interface ProfileDraft {
	connectionId: string;
	label: string;
	model: string;
	/** Codex only. */
	reasoningEffort?: CodexReasoningEffort;
}

export type AiSettingsChangeListener = (keys: readonly AiStorageKey[]) => void;

/** A write the store skipped because v2 settings do not exist on this device yet. */
export class AiSettingsNotWritableError extends Error {
	constructor() {
		super('AI settings are not set up on this device yet.');
		this.name = 'AiSettingsNotWritableError';
	}
}

/** `loadSnapshot` reported that the v1 → v2 bootstrap writes failed. */
export class AiSettingsBootstrapFailedError extends Error {
	readonly cause: unknown;

	constructor(cause: unknown) {
		super('AI settings could not be set up on this device.');
		this.name = 'AiSettingsBootstrapFailedError';
		this.cause = cause;
	}
}

export interface AiSettingsControllerOptions {
	store: AiSettingsStore;
	/** New ids for connections and profiles. Injected by tests. */
	createId?: (prefix: 'connection' | 'cli' | 'profile') => string;
	/** Called with the error a mutation or load ended with, and with `undefined` once it clears. */
	onError?: (error: unknown) => void;
}

export interface AiSettingsController {
	readonly state: AiSettingsState;
	/** The error the last load or mutation ended with, if any. */
	readonly error: unknown;
	load(): Promise<AiSettingsSnapshot>;
	/** Reloads from storage after another context changed the keys, then notifies listeners. */
	reload(keys: readonly AiStorageKey[]): Promise<void>;
	subscribe(listener: AiSettingsChangeListener): () => void;
	clearError(): void;

	addApiConnection(draft: ConnectionDraft): Promise<Connection | undefined>;
	updateConnection(connectionId: string, draft: ConnectionDraft): Promise<boolean>;
	/** Also deletes its profiles, its credential, its status entry, and routing entries using them. */
	deleteConnection(connectionId: string): Promise<boolean>;
	/** One connection per CLI kind, created with a default enabled profile. */
	addCliConnection(kind: CliConnectionKind): Promise<Connection | undefined>;

	addProfile(draft: ProfileDraft): Promise<ModelProfile | undefined>;
	updateProfile(profileId: string, draft: ProfileDraft): Promise<boolean>;
	setProfileEnabled(profileId: string, enabled: boolean): Promise<boolean>;
	duplicateProfile(profileId: string, label: string): Promise<ModelProfile | undefined>;
	deleteProfile(profileId: string): Promise<boolean>;

	setDefaultProfile(profileId: string | undefined): Promise<boolean>;
	/** `undefined` clears the entry so the task uses the default. */
	setTaskProfile(task: AiTask, profileId: string | undefined): Promise<boolean>;
	setResponseLanguage(language: string): Promise<boolean>;
	setInterpreterEnabled(enabled: boolean): Promise<boolean>;
	setAutoRun(autoRun: boolean): Promise<boolean>;
	setPromptContext(text: string): Promise<boolean>;
}

function defaultCreateId(prefix: string): string {
	const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
		: Math.random().toString(36).slice(2, 14);
	return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function emptyState(): AiSettingsState {
	return {
		view: {
			enabled: false,
			connections: [],
			profiles: [],
			routing: { taskProfiles: {} },
			interpreter: { autoRun: false, defaultPromptContext: '' },
			credentials: {},
			nativeMessaging: 'none'
		},
		connectionStatus: {},
		mode: 'derived'
	};
}

const ALL_KEYS: readonly AiStorageKey[] = [
	AI_CONNECTIONS_KEY,
	AI_PROFILES_KEY,
	AI_ROUTING_KEY,
	AI_INTERPRETER_KEY,
	AI_PROMPT_CONTEXT_KEY,
	AI_CREDENTIALS_KEY,
	AI_CONNECTION_STATUS_KEY
];

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The routing with every reference to `profileIds` removed. */
function routingWithout(routing: AiRouting, profileIds: ReadonlySet<string>): AiRouting {
	const taskProfiles: Partial<Record<AiTask, string>> = {};
	for (const [task, id] of Object.entries(routing.taskProfiles) as [AiTask, string][]) {
		if (!profileIds.has(id)) taskProfiles[task] = id;
	}
	const next: AiRouting = { ...routing, taskProfiles };
	if (next.defaultProfileId && profileIds.has(next.defaultProfileId)) delete next.defaultProfileId;
	return next;
}

function profileOptions(
	current: ModelProfileOptions | undefined,
	kind: Connection['kind'] | undefined,
	effort: CodexReasoningEffort | undefined
): ModelProfileOptions | undefined {
	const options: ModelProfileOptions = { ...(current ?? {}) };
	delete options.reasoningEffort;
	if (kind === 'cli-codex' && effort) options.reasoningEffort = effort;
	return Object.keys(options).length > 0 ? options : undefined;
}

export function createAiSettingsController(options: AiSettingsControllerOptions): AiSettingsController {
	const { store } = options;
	const createId = options.createId ?? defaultCreateId;
	const listeners = new Set<AiSettingsChangeListener>();
	let state = emptyState();
	let currentError: unknown;
	let queue: Promise<unknown> = Promise.resolve();

	function setError(error: unknown): void {
		currentError = error;
		options.onError?.(error);
	}

	function notify(keys: readonly AiStorageKey[]): void {
		const unique = [...new Set(keys)];
		if (unique.length === 0) return;
		for (const listener of [...listeners]) listener(unique);
	}

	function setView(patch: Partial<AiSettingsView>): void {
		state = { ...state, view: { ...state.view, ...patch } };
	}

	function applySnapshot(snapshot: AiSettingsSnapshot): void {
		state = { view: snapshot.view, connectionStatus: snapshot.connectionStatus, mode: snapshot.mode };
	}

	/**
	 * In derived mode the view is computed from v1 and the store refuses writes. Reload first: a
	 * bootstrapping store may have created v2 since, and a mutation must never build on the
	 * derived view.
	 */
	async function ensureStored(changed: AiStorageKey[]): Promise<void> {
		if (state.mode === 'stored') return;
		const snapshot = await store.loadSnapshot();
		applySnapshot(snapshot);
		changed.push(...ALL_KEYS);
		if (snapshot.mode !== 'stored') throw new AiSettingsNotWritableError();
	}

	/** Runs one mutation at a time; reports its error and resolves `fallback` when it throws. */
	function enqueue<T>(fallback: T, run: (changed: AiStorageKey[]) => Promise<T>): Promise<T> {
		const result = queue.then(async () => {
			const changed: AiStorageKey[] = [];
			try {
				await ensureStored(changed);
				const value = await run(changed);
				if (currentError !== undefined) setError(undefined);
				return value;
			} catch (error) {
				setError(error);
				return fallback;
			} finally {
				notify(changed);
			}
		});
		queue = result.catch(() => undefined);
		return result;
	}

	function requireWritten(written: boolean): void {
		if (!written) throw new AiSettingsNotWritableError();
	}

	// Each writer below performs one store call and updates the view only after it succeeds.
	async function writeConnections(items: Connection[], changed: AiStorageKey[]): Promise<void> {
		requireWritten(await store.saveConnections(items));
		setView({ connections: items });
		changed.push(AI_CONNECTIONS_KEY);
	}

	async function writeProfiles(items: ModelProfile[], changed: AiStorageKey[]): Promise<void> {
		requireWritten(await store.saveProfiles(items));
		setView({ profiles: items });
		changed.push(AI_PROFILES_KEY);
	}

	async function writeRouting(routing: AiRouting, changed: AiStorageKey[]): Promise<void> {
		if (same(routing, state.view.routing)) return;
		requireWritten(await store.saveRouting(routing));
		setView({ routing });
		changed.push(AI_ROUTING_KEY);
	}

	async function writeCredential(connectionId: string, apiKey: string, changed: AiStorageKey[]): Promise<void> {
		const key = apiKey.trim();
		if ((state.view.credentials[connectionId] ?? '') === key) return;
		await (key ? store.setCredential(connectionId, key) : store.deleteCredential(connectionId));
		const credentials = { ...state.view.credentials };
		if (key) credentials[connectionId] = key;
		else delete credentials[connectionId];
		setView({ credentials });
		changed.push(AI_CREDENTIALS_KEY);
	}

	async function deleteStatus(connectionId: string, changed: AiStorageKey[]): Promise<void> {
		await store.deleteConnectionStatus(connectionId);
		if (!Object.prototype.hasOwnProperty.call(state.connectionStatus, connectionId)) return;
		const connectionStatus = { ...state.connectionStatus };
		delete connectionStatus[connectionId];
		state = { ...state, connectionStatus };
		changed.push(AI_CONNECTION_STATUS_KEY);
	}

	/** A new profile becomes the default when no usable default exists. */
	async function adoptAsDefault(profileId: string, changed: AiStorageKey[]): Promise<void> {
		const current = state.view.routing.defaultProfileId;
		if (current && state.view.profiles.some(profile => profile.id === current)) return;
		await writeRouting({ ...state.view.routing, defaultProfileId: profileId }, changed);
	}

	function buildConnection(base: Partial<Connection> & { id: string }, draft: ConnectionDraft): Connection {
		const label = draft.label.trim();
		const baseUrl = draft.baseUrl.trim();
		const presetId = draft.presetId || base.presetId;
		const kind = inferConnectionKind({ presetId, baseUrl, name: label });
		const connection: Connection = {
			...base,
			id: base.id,
			kind,
			label,
			baseUrl,
			apiKeyRequired: draft.apiKeyRequired
		};
		if (presetId) connection.presetId = presetId;
		else delete connection.presetId;
		if (draft.maxConcurrency !== undefined) connection.maxConcurrency = draft.maxConcurrency;
		else delete connection.maxConcurrency;
		// A detected structured-output mode belongs to the endpoint it was detected on.
		if (base.baseUrl !== undefined && (base.baseUrl !== baseUrl || base.kind !== kind)) {
			delete connection.structuredOutput;
		}
		return connection;
	}

	function findProfile(profileId: string): ModelProfile | undefined {
		return state.view.profiles.find(profile => profile.id === profileId);
	}

	function connectionKind(connectionId: string): Connection['kind'] | undefined {
		return state.view.connections.find(connection => connection.id === connectionId)?.kind;
	}

	return {
		get state() {
			return state;
		},
		get error() {
			return currentError;
		},

		async load() {
			const snapshot = await store.loadSnapshot();
			applySnapshot(snapshot);
			setError(snapshot.bootstrapError !== undefined ? new AiSettingsBootstrapFailedError(snapshot.bootstrapError) : undefined);
			return snapshot;
		},

		reload(keys) {
			const result = queue.then(async () => {
				try {
					applySnapshot(await store.loadSnapshot());
				} catch (error) {
					setError(error);
					return;
				}
				notify(keys);
			});
			queue = result.catch(() => undefined);
			return result;
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		clearError() {
			if (currentError !== undefined) setError(undefined);
		},

		addApiConnection(draft) {
			return enqueue<Connection | undefined>(undefined, async changed => {
				const connection = buildConnection({ id: createId('connection') }, draft);
				await writeConnections([...state.view.connections, connection], changed);
				await writeCredential(connection.id, draft.apiKey, changed);
				return connection;
			});
		},

		updateConnection(connectionId, draft) {
			return enqueue(false, async changed => {
				const current = state.view.connections.find(connection => connection.id === connectionId);
				if (!current || isCliKind(current.kind)) return false;
				const next = buildConnection(current, draft);
				const keyChanged = (state.view.credentials[connectionId] ?? '') !== draft.apiKey.trim();
				if (!same(next, current)) {
					await writeConnections(state.view.connections.map(item => item.id === connectionId ? next : item), changed);
				}
				await writeCredential(connectionId, draft.apiKey, changed);
				// A Test result describes the old endpoint or key.
				if (keyChanged || next.baseUrl !== current.baseUrl) await deleteStatus(connectionId, changed);
				return true;
			});
		},

		deleteConnection(connectionId) {
			return enqueue(false, async changed => {
				if (!state.view.connections.some(connection => connection.id === connectionId)) return false;
				const removed = new Set(state.view.profiles
					.filter(profile => profile.connectionId === connectionId)
					.map(profile => profile.id));
				// Routing first, then profiles, then the connection: an interrupted cascade leaves
				// at worst unused items, never a route to a deleted profile.
				await writeRouting(routingWithout(state.view.routing, removed), changed);
				if (removed.size > 0) {
					await writeProfiles(state.view.profiles.filter(profile => !removed.has(profile.id)), changed);
				}
				await writeConnections(state.view.connections.filter(connection => connection.id !== connectionId), changed);
				await writeCredential(connectionId, '', changed);
				await deleteStatus(connectionId, changed);
				return true;
			});
		},

		addCliConnection(kind) {
			return enqueue<Connection | undefined>(undefined, async changed => {
				if (state.view.connections.some(connection => connection.kind === kind)) return undefined;
				const connection: Connection = { id: createId('cli'), kind, label: '' };
				const profile: ModelProfile = { id: createId('profile'), connectionId: connection.id, label: '', enabled: true };
				await writeConnections([...state.view.connections, connection], changed);
				await writeProfiles([...state.view.profiles, profile], changed);
				await adoptAsDefault(profile.id, changed);
				return connection;
			});
		},

		addProfile(draft) {
			return enqueue<ModelProfile | undefined>(undefined, async changed => {
				const kind = connectionKind(draft.connectionId);
				if (!kind) return undefined;
				const model = draft.model.trim();
				const options = profileOptions(undefined, kind, draft.reasoningEffort);
				const profile: ModelProfile = {
					id: createId('profile'),
					connectionId: draft.connectionId,
					...(model ? { model } : {}),
					label: draft.label.trim(),
					...(options ? { options } : {}),
					enabled: true
				};
				await writeProfiles([...state.view.profiles, profile], changed);
				await adoptAsDefault(profile.id, changed);
				return profile;
			});
		},

		updateProfile(profileId, draft) {
			return enqueue(false, async changed => {
				const current = findProfile(profileId);
				if (!current) return false;
				const model = draft.model.trim();
				const options = profileOptions(current.options, connectionKind(current.connectionId), draft.reasoningEffort);
				const next: ModelProfile = { ...current, label: draft.label.trim() };
				if (model) next.model = model;
				else delete next.model;
				if (options) next.options = options;
				else delete next.options;
				if (same(next, current)) return true;
				await writeProfiles(state.view.profiles.map(profile => profile.id === profileId ? next : profile), changed);
				return true;
			});
		},

		setProfileEnabled(profileId, enabled) {
			return enqueue(false, async changed => {
				const current = findProfile(profileId);
				if (!current) return false;
				if (current.enabled === enabled) return true;
				await writeProfiles(
					state.view.profiles.map(profile => profile.id === profileId ? { ...profile, enabled } : profile),
					changed
				);
				return true;
			});
		},

		duplicateProfile(profileId, label) {
			return enqueue<ModelProfile | undefined>(undefined, async changed => {
				const current = findProfile(profileId);
				if (!current) return undefined;
				const copy: ModelProfile = { ...current, id: createId('profile'), label: label.trim() };
				if (current.options) copy.options = { ...current.options };
				await writeProfiles([...state.view.profiles, copy], changed);
				return copy;
			});
		},

		deleteProfile(profileId) {
			return enqueue(false, async changed => {
				if (!findProfile(profileId)) return false;
				await writeRouting(routingWithout(state.view.routing, new Set([profileId])), changed);
				await writeProfiles(state.view.profiles.filter(profile => profile.id !== profileId), changed);
				return true;
			});
		},

		setDefaultProfile(profileId) {
			return enqueue(false, async changed => {
				const routing: AiRouting = { ...state.view.routing };
				if (profileId) routing.defaultProfileId = profileId;
				else delete routing.defaultProfileId;
				await writeRouting(routing, changed);
				return true;
			});
		},

		setTaskProfile(task, profileId) {
			return enqueue(false, async changed => {
				const taskProfiles = { ...state.view.routing.taskProfiles };
				if (profileId) taskProfiles[task] = profileId;
				else delete taskProfiles[task];
				await writeRouting({ ...state.view.routing, taskProfiles }, changed);
				return true;
			});
		},

		setResponseLanguage(language) {
			return enqueue(false, async changed => {
				const routing: AiRouting = { ...state.view.routing };
				const trimmed = language.trim();
				if (trimmed) routing.responseLanguage = trimmed;
				else delete routing.responseLanguage;
				await writeRouting(routing, changed);
				return true;
			});
		},

		setInterpreterEnabled(enabled) {
			return enqueue(false, async changed => {
				if (state.view.enabled === enabled) return true;
				requireWritten(await store.saveInterpreter({ enabled, autoRun: state.view.interpreter.autoRun }));
				setView({ enabled });
				changed.push(AI_INTERPRETER_KEY);
				return true;
			});
		},

		setAutoRun(autoRun) {
			return enqueue(false, async changed => {
				if (state.view.interpreter.autoRun === autoRun) return true;
				requireWritten(await store.saveInterpreter({ enabled: state.view.enabled, autoRun }));
				setView({ interpreter: { ...state.view.interpreter, autoRun } });
				changed.push(AI_INTERPRETER_KEY);
				return true;
			});
		},

		setPromptContext(text) {
			return enqueue(false, async changed => {
				if (state.view.interpreter.defaultPromptContext === text) return true;
				requireWritten(await store.savePromptContext(text));
				setView({ interpreter: { ...state.view.interpreter, defaultPromptContext: text } });
				changed.push(AI_PROMPT_CONTEXT_KEY);
				return true;
			});
		}
	};
}

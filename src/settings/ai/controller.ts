import { clearConnectionStatus } from '../../ai/client';
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
import { statusFromTestResult } from '../../ai/test-connection';
import type {
	AiRouting,
	AiSettingsView,
	AiTask,
	AiTestResult,
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
	/**
	 * `derived` while no v2 items exist on this device; the store then refuses every write until
	 * the first mutation creates v2 through `ensureV2`.
	 */
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

/**
 * The connection or profile a dialog edits no longer exists, for example because another device
 * deleted it while the dialog was open. Nothing was written.
 */
export class AiSettingsItemMissingError extends Error {
	readonly item: 'connection' | 'profile';

	constructor(item: 'connection' | 'profile') {
		super(`The ${item} no longer exists.`);
		this.name = 'AiSettingsItemMissingError';
		this.item = item;
	}
}

export interface AddConnectionOptions {
	/**
	 * Called once the connection itself is stored, before its key is written. If the key write
	 * then fails, the caller edits this connection on retry instead of adding a second one.
	 */
	onCreated?: (connection: Connection) => void;
}

export interface AiSettingsControllerOptions {
	store: AiSettingsStore;
	/** New ids for connections and profiles. Injected by tests. */
	createId?: (prefix: 'connection' | 'cli' | 'profile') => string;
	/** Called with the error a mutation or load ended with, and with `undefined` once it clears. */
	onError?: (error: unknown) => void;
	/**
	 * Removes a connection's entry from this device's `ai_connection_status`. Defaults to the
	 * gateway's `status-clear`, which keeps the gateway the key's only writer. Injected by tests.
	 */
	clearConnectionStatus?: (connectionId: string) => Promise<void>;
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

	addApiConnection(draft: ConnectionDraft, options?: AddConnectionOptions): Promise<Connection | undefined>;
	/** Fails with `AiSettingsItemMissingError` when the connection no longer exists. */
	updateConnection(connectionId: string, draft: ConnectionDraft): Promise<boolean>;
	/** Also deletes its profiles, its credential, its status entry, and routing entries using them. */
	deleteConnection(connectionId: string): Promise<boolean>;
	/** One connection per CLI kind, created with a default enabled profile. */
	addCliConnection(kind: CliConnectionKind): Promise<Connection | undefined>;

	/** Fails with `AiSettingsItemMissingError` when the connection no longer exists. */
	addProfile(draft: ProfileDraft): Promise<ModelProfile | undefined>;
	/**
	 * Fails with `AiSettingsItemMissingError` when the profile no longer exists. A model change
	 * also clears the connection's status entry, which described the old model.
	 */
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
	/**
	 * Saves the prompt context for a page that is going away: in `stored` mode the storage write is
	 * dispatched before this returns (no queue, no pre-read) and it returns `true`; it supersedes a
	 * queued `setPromptContext`. In `derived` mode it does nothing and returns `false`, and the
	 * caller falls back to `setPromptContext`.
	 */
	flushPromptContext(text: string): boolean;

	/** True while a mutation is queued or running; Test waits for saves to land. */
	readonly saving: boolean;
	/** Called whenever `saving` changes. Returns the unsubscribe function. */
	onSavingChange(listener: (saving: boolean) => void): () => void;
	/**
	 * Shows a finished Test: its status (the gateway already stored it on this device) and, when
	 * the Test detected a structured-output mode, writes it to the synced connection.
	 */
	applyTestResult(result: AiTestResult): Promise<boolean>;
	/** The model ids the last Test in this page listed for a connection, if any. */
	listedModels(connectionId: string): readonly string[] | undefined;
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
	const clearStatus = options.clearConnectionStatus ?? (connectionId => clearConnectionStatus(connectionId));
	const createId = options.createId ?? defaultCreateId;
	const listeners = new Set<AiSettingsChangeListener>();
	let state = emptyState();
	let currentError: unknown;
	let queue: Promise<unknown> = Promise.resolve();
	let pending = 0;
	const savingListeners = new Set<(saving: boolean) => void>();
	const listings = new Map<string, readonly string[]>();
	// Counts prompt-context saves, so `flushPromptContext` supersedes queued ones.
	let promptContextSaves = 0;

	function setPending(delta: number): void {
		const before = pending > 0;
		pending += delta;
		if (before === pending > 0) return;
		for (const listener of [...savingListeners]) listener(pending > 0);
	}

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
	 * In derived mode the view is computed from v1 (or is the defaults) and the store refuses
	 * writes. The first write therefore asks the store to create v2: it runs a pending v1
	 * migration, or on a fresh install writes the defaults. Then it reloads, so a mutation never
	 * builds on the derived view.
	 */
	async function ensureStored(changed: AiStorageKey[]): Promise<void> {
		if (state.mode === 'stored') return;
		changed.push(...ALL_KEYS);
		await store.ensureV2();
		const snapshot = await store.loadSnapshot();
		applySnapshot(snapshot);
		if (snapshot.mode !== 'stored') throw new AiSettingsNotWritableError();
	}

	/** Runs one mutation at a time; reports its error and resolves `fallback` when it throws. */
	function enqueue<T>(fallback: T, run: (changed: AiStorageKey[]) => Promise<T>): Promise<T> {
		setPending(1);
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
				setPending(-1);
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

	/** Asks the gateway, the only writer of `ai_connection_status`, to remove the entry. */
	async function deleteStatus(connectionId: string, changed: AiStorageKey[]): Promise<void> {
		await clearStatus(connectionId);
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

		addApiConnection(draft, addOptions = {}) {
			return enqueue<Connection | undefined>(undefined, async changed => {
				const connection = buildConnection({ id: createId('connection') }, draft);
				await writeConnections([...state.view.connections, connection], changed);
				addOptions.onCreated?.(connection);
				await writeCredential(connection.id, draft.apiKey, changed);
				return connection;
			});
		},

		updateConnection(connectionId, draft) {
			return enqueue(false, async changed => {
				const current = state.view.connections.find(connection => connection.id === connectionId);
				if (!current) throw new AiSettingsItemMissingError('connection');
				if (isCliKind(current.kind)) return false;
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
				if (!kind) throw new AiSettingsItemMissingError('connection');
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
				if (!current) throw new AiSettingsItemMissingError('profile');
				const model = draft.model.trim();
				const options = profileOptions(current.options, connectionKind(current.connectionId), draft.reasoningEffort);
				const next: ModelProfile = { ...current, label: draft.label.trim() };
				if (model) next.model = model;
				else delete next.model;
				if (options) next.options = options;
				else delete next.options;
				if (same(next, current)) return true;
				await writeProfiles(state.view.profiles.map(profile => profile.id === profileId ? next : profile), changed);
				// A Test result and a structured-output downgrade describe the old model.
				if (next.model !== current.model) await deleteStatus(current.connectionId, changed);
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

		get saving() {
			return pending > 0;
		},

		onSavingChange(listener) {
			savingListeners.add(listener);
			return () => savingListeners.delete(listener);
		},

		listedModels(connectionId) {
			return listings.get(connectionId);
		},

		applyTestResult(result) {
			if (result.listedModels) listings.set(result.connectionId, [...result.listedModels]);
			return enqueue(false, async changed => {
				const id = result.connectionId;
				const current = state.view.connections.find(connection => connection.id === id);
				if (!current) return false;
				state = {
					...state,
					connectionStatus: { ...state.connectionStatus, [id]: statusFromTestResult(result, state.connectionStatus[id]) }
				};
				changed.push(AI_CONNECTION_STATUS_KEY);
				const mode = result.structuredOutput;
				if (mode && current.structuredOutput !== mode) {
					await writeConnections(
						state.view.connections.map(connection => connection.id === id ? { ...connection, structuredOutput: mode } : connection),
						changed
					);
				}
				return true;
			});
		},

		setPromptContext(text) {
			const save = ++promptContextSaves;
			const current = () => save === promptContextSaves;
			return enqueue(false, async changed => {
				if (!current() || state.view.interpreter.defaultPromptContext === text) return true;
				requireWritten(await store.savePromptContext(text));
				if (!current()) return true;
				setView({ interpreter: { ...state.view.interpreter, defaultPromptContext: text } });
				changed.push(AI_PROMPT_CONTEXT_KEY);
				return true;
			});
		},

		flushPromptContext(text) {
			if (state.mode !== 'stored') return false;
			promptContextSaves++;
			if (state.view.interpreter.defaultPromptContext === text) return true;
			const previous = state.view.interpreter.defaultPromptContext;
			const write = store.savePromptContextNow(text);
			setView({ interpreter: { ...state.view.interpreter, defaultPromptContext: text } });
			notify([AI_PROMPT_CONTEXT_KEY]);
			write.then(() => {
				if (currentError !== undefined) setError(undefined);
			}, error => {
				// Nothing was stored: show why, and the stored text again unless a newer save replaced it.
				if (state.view.interpreter.defaultPromptContext === text) {
					setView({ interpreter: { ...state.view.interpreter, defaultPromptContext: previous } });
					notify([AI_PROMPT_CONTEXT_KEY]);
				}
				setError(error);
			});
			return true;
		}
	};
}

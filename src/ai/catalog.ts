import catalogData from '../../providers.json';
import { PRESET_KINDS } from './preset-kinds';
import type { ConnectionKind } from './types';

export { PRESET_KINDS };

export interface CatalogModel {
	id: string;
	name: string;
	recommended?: boolean;
}

export interface CatalogEntry {
	id: string;
	name: string;
	kind: ConnectionKind;
	baseUrl: string;
	apiKeyUrl?: string;
	/** `providers.json` omits the flag for most key-based presets, so only `false` opts out. */
	apiKeyRequired: boolean;
	modelsList?: string;
	popularModels: readonly CatalogModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function normalizeModel(value: unknown): CatalogModel | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return undefined;
	return Object.freeze({
		id: value.id,
		name: typeof value.name === 'string' && value.name ? value.name : value.id,
		...(value.recommended === true ? { recommended: true } : {})
	});
}

function normalizeEntry(id: string, value: unknown): CatalogEntry | undefined {
	if (!isRecord(value) || typeof value.baseUrl !== 'string') return undefined;
	const apiKeyUrl = optionalString(value.apiKeyUrl);
	const modelsList = optionalString(value.modelsList);
	const popularModels = (Array.isArray(value.popularModels) ? value.popularModels : [])
		.map(normalizeModel)
		.filter((model): model is CatalogModel => model !== undefined);
	return Object.freeze({
		id,
		name: typeof value.name === 'string' && value.name ? value.name : id,
		kind: PRESET_KINDS[id] ?? 'openai-compatible',
		baseUrl: value.baseUrl,
		...(apiKeyUrl ? { apiKeyUrl } : {}),
		apiKeyRequired: value.apiKeyRequired !== false,
		...(modelsList ? { modelsList } : {}),
		popularModels: Object.freeze(popularModels)
	});
}

/** Normalizes a `providers.json`-shaped object. Exported for tests; callers use `CATALOG`. */
export function normalizeCatalog(data: unknown): CatalogEntry[] {
	if (!isRecord(data)) return [];
	const entries: CatalogEntry[] = [];
	for (const key of Object.keys(data)) {
		if (key === 'version') continue;
		const entry = normalizeEntry(key, data[key]);
		if (entry) entries.push(entry);
	}
	return entries;
}

const rawCatalog: unknown = catalogData;

export const CATALOG_VERSION: string = isRecord(rawCatalog) && typeof rawCatalog.version === 'string'
	? rawCatalog.version
	: '';

/** The bundled provider catalog, in `providers.json` order. Entries are frozen. */
export const CATALOG: readonly CatalogEntry[] = Object.freeze(normalizeCatalog(rawCatalog));

export function getCatalogEntry(id: string): CatalogEntry | undefined {
	return CATALOG.find(entry => entry.id === id);
}

/** The preset whose base URL equals `baseUrl` exactly (surrounding whitespace ignored). */
export function findCatalogEntryByBaseUrl(baseUrl: unknown): CatalogEntry | undefined {
	if (typeof baseUrl !== 'string') return undefined;
	const url = baseUrl.trim();
	if (!url) return undefined;
	return CATALOG.find(entry => entry.baseUrl === url);
}

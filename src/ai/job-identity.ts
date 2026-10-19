import type { TranscriptSegment } from './contracts';

// Durable transcript job ids, shared by the client (which proposes an id) and the gateway (which
// recomputes it). Pure and synchronous: Reader pages on insecure origins have no crypto.subtle.

export type TranscriptJobTask = 'translate' | 'reading';

/** Which transcript a job belongs to: a feature namespace and a caller-defined scope (video, language). */
export interface TranscriptJobIdentity {
	namespace: string;
	scope: string;
}

export interface ParsedJobId {
	task: TranscriptJobTask;
	namespace: string;
	hash: string;
}

const JOB_ID_PREFIX = 'job:';
const TASKS: ReadonlySet<string> = new Set<TranscriptJobTask>(['translate', 'reading']);

// cyrb53 (public domain, bryc): a fast 53-bit string hash. Not cryptographic; it only has to
// keep distinct transcripts apart. scripts/transcript-e2e-fixture.mjs carries a copy.
function cyrb53(text: string, seed = 0): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let index = 0; index < text.length; index += 1) {
		const char = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ char, 2654435761);
		h2 = Math.imul(h2 ^ char, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A base-36 hash of the scope and the segment texts in order. */
export function hashSegments(scope: string, texts: readonly string[]): string {
	return cyrb53(JSON.stringify([scope, texts])).toString(36);
}

/** Job segments are addressed by source index, so results map to arrays without a lookup. */
export function hasIndexIds(segments: readonly TranscriptSegment[]): boolean {
	return segments.every((segment, index) => segment.id === index);
}

/** `job:${task}:${namespace}:${hash}`. Throws when a segment id is not its index. */
export function transcriptJobId(
	task: TranscriptJobTask,
	identity: TranscriptJobIdentity,
	segments: readonly TranscriptSegment[]
): string {
	if (!hasIndexIds(segments)) throw new RangeError('Transcript job segment ids must equal their index.');
	const hash = hashSegments(identity.scope, segments.map(segment => segment.text));
	return `${JOB_ID_PREFIX}${task}:${identity.namespace}:${hash}`;
}

/** Splits a job id; the namespace may itself contain colons, the hash never does. */
export function parseJobId(jobId: string): ParsedJobId | undefined {
	if (!jobId.startsWith(JOB_ID_PREFIX)) return undefined;
	const rest = jobId.slice(JOB_ID_PREFIX.length);
	const taskEnd = rest.indexOf(':');
	const hashStart = rest.lastIndexOf(':');
	if (taskEnd < 0 || hashStart <= taskEnd) return undefined;
	const task = rest.slice(0, taskEnd);
	const namespace = rest.slice(taskEnd + 1, hashStart);
	const hash = rest.slice(hashStart + 1);
	if (!TASKS.has(task) || !namespace || !/^[0-9a-z]+$/.test(hash)) return undefined;
	return { task: task as TranscriptJobTask, namespace, hash };
}

import type {
	LearningSelection,
	LearningVocabularyEntry,
	TranscriptReadingProgress,
	TranscriptReadingSegments,
	TranscriptTranslationProgress
} from '../../utils/language-learning';
import type { TranscriptJobTask } from '../../ai/job-identity';
import type { AiTask, ConnectionKind } from '../../ai/types';
import type { AiActionRun } from '../../ai/ui/action';
import type { TaskBar } from './task-bar';

// The Reader's transcript learning contracts: the tools the runtime supplies, and the controller
// `wireTranscriptLanguageLearning` returns.

export interface TranscriptLanguageLearning {
	translateTranscript: (
		segments: string[],
		onProgress?: (progress: TranscriptTranslationProgress) => void,
		signal?: AbortSignal
	) => Promise<string[]>;
	translateTranscriptToJapanese?: (
		segments: string[],
		onProgress?: (progress: TranscriptTranslationProgress) => void,
		signal?: AbortSignal
	) => Promise<string[]>;
	annotateJapaneseTranscript: (
		segments: string[],
		onProgress?: (progress: TranscriptReadingProgress) => void,
		signal?: AbortSignal
	) => Promise<TranscriptReadingSegments>;
	explainSelection: (selection: LearningSelection, signal?: AbortSignal) => Promise<string>;
	getExecutionInfo?: (task: TranscriptJobTask) => Promise<TranscriptExecutionInfo>;
	/** Every enabled profile, for the error card's engine switch. */
	listProfiles?: () => Promise<TranscriptProfileOption[]>;
	loadTranscriptTranslations?: (segments: string[]) => Promise<string[] | undefined>;
	loadJapaneseTranscriptTranslations?: (segments: string[]) => Promise<string[] | undefined>;
	loadJapaneseReadings?: (segments: string[]) => Promise<TranscriptReadingSegments | undefined>;
	saveTranscriptTranslations?: (segments: string[], translations: string[]) => Promise<void>;
	saveJapaneseReadings?: (segments: string[], readings: TranscriptReadingSegments) => Promise<void>;
	clearJapaneseReadings?: (segments: string[]) => Promise<void>;
	isVocabularyFavorite?: (selection: LearningSelection) => Promise<boolean>;
	toggleVocabularyFavorite?: (selection: LearningSelection, explanation: string) => Promise<boolean>;
	copyLearningText?: (text: string) => Promise<boolean>;
	saveVocabularyToObsidian?: (selection: LearningSelection, explanation: string) => Promise<void>;
	listVocabulary?: () => Promise<LearningVocabularyEntry[]>;
	removeVocabulary?: (id: string) => Promise<void>;
	removeVocabularyMany?: (ids: string[]) => Promise<void>;
	clearVocabulary?: () => Promise<void>;
	exportVocabulary?: () => Promise<string>;
	importVocabulary?: (json: string) => Promise<number>;
	saveJapaneseReadingOverride?: (surface: string, reading: string) => Promise<void>;
	listJapaneseReadingDictionary?: () => Promise<Array<{ surface: string; reading: string; updatedAt: number }>>;
	removeJapaneseReadingOverride?: (surface: string) => Promise<void>;
	clearJapaneseReadingDictionary?: () => Promise<void>;
	exportJapaneseReadingDictionary?: () => Promise<string>;
	importJapaneseReadingDictionary?: (json: string) => Promise<number>;
	/** Routes the failed task to a profile before Switch and retry. */
	setTaskProfile?: (task: ReaderAiTask, profileId: string) => Promise<void>;
}

/** The Reader tasks whose failure the error card can recover by switching the task's profile. */
export type ReaderAiTask = Extract<AiTask, 'translate' | 'reading' | 'explain'>;

export interface TranscriptProfileOption {
	id: string;
	/** `connection · model`, the task bar's engine label. */
	label: string;
	/** The profile's own name and its connection's name, for the error card's grouped select. */
	name?: string;
	group?: string;
	kind: ConnectionKind;
}

export type TranscriptTaskRange = 'current' | 'next-five-minutes' | 'all';

/** The profile routing names for a transcript task; absent when the task has none. */
export interface TranscriptExecutionInfo {
	profileId?: string;
	kind?: ConnectionKind;
	label: string;
	/** `TRANSCRIPT_GROUP_BUDGETS[kind][task]`, which drives the batch estimate. */
	promptCharLimit: number;
}

export interface TranscriptLanguageLearningController {
	ready: Promise<void>;
	toggleBilingual: () => Promise<void>;
	toggleJapaneseReadings: () => Promise<void>;
	regenerateJapaneseReadings: () => Promise<void>;
	cancelActiveRequest: () => void;
	explain: (selection: LearningSelection, returnFocus?: HTMLElement) => Promise<void>;
	setTaskRange: (range: TranscriptTaskRange) => void;
	showVocabulary: () => Promise<void>;
}

export interface TranscriptLanguageLearningOptions {
	doc: Document;
	transcript: HTMLElement;
	segments: HTMLElement[];
	controls: HTMLElement;
	tools: TranscriptLanguageLearning;
	/** The resolved response language; the Reader falls back to the browser language itself. */
	responseLanguage: string;
	restoreBilingualSubtitles?: boolean;
	restoreJapaneseReadings?: boolean;
	onPreferenceChange?: (
		key: 'bilingualSubtitles' | 'japaneseReadings',
		value: boolean
	) => void;
	cancelPendingSeek: () => void;
}

/** A transcript flow the transcript action can run: its button, idle label, card title, and task. */
export interface TranscriptFlow {
	button: HTMLButtonElement;
	label: string;
	title: string;
	/** The task an error that names none is attributed to. */
	task: ReaderAiTask;
}

/** The restore of saved work at wiring time; user actions wait for it. */
export interface TranscriptRestoreState {
	promise: Promise<void>;
	complete: boolean;
}

/** What the transcript features share, instead of closing over one wiring function. */
export interface TranscriptFeatureContext {
	doc: Document;
	transcript: HTMLElement;
	segments: HTMLElement[];
	originalTexts: string[];
	tools: TranscriptLanguageLearning;
	responseLanguage: string;
	/** Aborted on cleanup: late work changes nothing. */
	signal: AbortSignal;
	taskBar: TaskBar;
	restore: TranscriptRestoreState;
	/** Starts `run` on the transcript action (aborting the run before it) for `flow`. */
	runTranscriptTask: (flow: TranscriptFlow, run: AiActionRun<void>) => Promise<void>;
	onPreferenceChange?: TranscriptLanguageLearningOptions['onPreferenceChange'];
}

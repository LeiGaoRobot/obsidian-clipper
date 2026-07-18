import { getMessage } from './i18n';
import type { LearningVocabularyEntry } from './language-learning';
import type { JapaneseReadingDictionaryEntry } from './japanese-reading-dictionary';

interface LanguageLearningCenterTools {
	listVocabulary?: () => Promise<LearningVocabularyEntry[]>;
	removeVocabulary?: (id: string) => Promise<void>;
	removeVocabularyMany?: (ids: string[]) => Promise<void>;
	clearVocabulary?: () => Promise<void>;
	exportVocabulary?: () => Promise<string>;
	importVocabulary?: (json: string) => Promise<number>;
	copyLearningText?: (text: string) => Promise<boolean>;
	saveVocabularyToObsidian?: (selection: LearningVocabularyEntry, explanation: string) => Promise<void>;
	listJapaneseReadingDictionary?: () => Promise<JapaneseReadingDictionaryEntry[]>;
	saveJapaneseReadingOverride?: (surface: string, reading: string) => Promise<void>;
	removeJapaneseReadingOverride?: (surface: string) => Promise<void>;
	clearJapaneseReadingDictionary?: () => Promise<void>;
	exportJapaneseReadingDictionary?: () => Promise<string>;
	importJapaneseReadingDictionary?: (json: string) => Promise<number>;
}

interface LanguageLearningCenterOptions {
	doc: Document;
	container: HTMLElement;
	tools: LanguageLearningCenterTools;
	onFeedback?: (message: string) => void;
	confirmAction?: (message: string) => boolean;
}

export interface LanguageLearningCenterController {
	ready: Promise<void>;
	refresh: () => Promise<void>;
}

function createButton(doc: Document, className: string, label: string): HTMLButtonElement {
	const button = doc.createElement('button');
	button.type = 'button';
	button.className = `language-learning-card-action ${className}`;
	button.textContent = label;
	return button;
}

function createFileInput(doc: Document, onImport: (content: string) => Promise<void>): HTMLInputElement {
	const input = doc.createElement('input');
	input.type = 'file';
	input.accept = 'application/json,.json';
	input.hidden = true;
	input.addEventListener('change', async () => {
		const file = input.files?.[0];
		if (!file) return;
		await onImport(await file.text());
		input.value = '';
	});
	return input;
}

export function renderLanguageLearningCenter({
	doc,
	container,
	tools,
	onFeedback = () => {},
	confirmAction = message => window.confirm(message)
}: LanguageLearningCenterOptions): LanguageLearningCenterController {
	let activeTab: 'vocabulary' | 'readings' = 'vocabulary';
	let vocabulary: LearningVocabularyEntry[] = [];
	let dictionary: JapaneseReadingDictionaryEntry[] = [];
	const selectedVocabulary = new Set<string>();

	const root = doc.createElement('div');
	root.className = 'language-learning-center';
	const tabs = doc.createElement('div');
	tabs.className = 'language-learning-center-tabs';
	tabs.setAttribute('role', 'tablist');
	const vocabularyTab = createButton(doc, '', getMessage('readerVocabularyTab'));
	vocabularyTab.dataset.learningCenterTab = 'vocabulary';
	const readingsTab = createButton(doc, '', getMessage('readerReadingDictionaryTab'));
	readingsTab.dataset.learningCenterTab = 'readings';
	const content = doc.createElement('div');
	content.className = 'language-learning-center-content';
	tabs.append(vocabularyTab, readingsTab);
	root.append(tabs, content);
	container.replaceChildren(root);

	const setTabState = () => {
		for (const button of [vocabularyTab, readingsTab]) {
			const selected = button.dataset.learningCenterTab === activeTab;
			button.classList.toggle('is-enabled', selected);
			button.setAttribute('aria-selected', String(selected));
		}
	};

	const renderVocabulary = () => {
		content.replaceChildren();
		const toolbar = doc.createElement('div');
		toolbar.className = 'language-learning-center-toolbar';
		const search = doc.createElement('input');
		search.type = 'search';
		search.className = 'language-learning-center-search';
		search.placeholder = getMessage('readerLearningCenterSearch');
		const filter = doc.createElement('select');
		filter.className = 'language-learning-center-filter';
		for (const [value, label] of [
			['all', 'readerVocabularyFilterAll'],
			['word', 'readerVocabularyFilterWords'],
			['sentence', 'readerVocabularyFilterSentences']
		]) {
			const option = doc.createElement('option');
			option.value = value;
			option.textContent = getMessage(label);
			filter.appendChild(option);
		}
		const actions = doc.createElement('div');
		actions.className = 'language-learning-center-actions';
		const removeSelected = createButton(doc, 'language-learning-center-remove-selected', getMessage('readerRemoveSelected'));
		const saveSelected = createButton(doc, 'language-learning-center-save-selected', getMessage('readerSaveSelectedToObsidian'));
		const exportButton = createButton(doc, '', getMessage('export'));
		const importButton = createButton(doc, '', getMessage('import'));
		const clearButton = createButton(doc, '', getMessage('readerClearAll'));
		const list = doc.createElement('div');
		list.className = 'language-learning-center-list';
		const count = doc.createElement('span');
		count.className = 'language-learning-center-count';

		const renderList = () => {
			list.replaceChildren();
			const query = search.value.trim().toLocaleLowerCase();
			const kind = filter.value;
			const visible = vocabulary.filter(entry => (kind === 'all' || entry.kind === kind)
				&& (!query || `${entry.text}\n${entry.context}\n${entry.explanation}`.toLocaleLowerCase().includes(query)));
			count.textContent = getMessage('readerLearningCenterCount', [String(visible.length), String(vocabulary.length)]);
			removeSelected.disabled = selectedVocabulary.size === 0;
			saveSelected.disabled = selectedVocabulary.size === 0;
			if (visible.length === 0) {
				const empty = doc.createElement('p');
				empty.className = 'language-learning-center-empty';
				empty.textContent = getMessage('readerSavedVocabularyEmpty');
				list.appendChild(empty);
				return;
			}
			for (const entry of visible) {
				const item = doc.createElement('article');
				item.className = 'language-learning-center-entry language-learning-vocabulary-entry';
				const checkbox = doc.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.checked = selectedVocabulary.has(entry.id);
				checkbox.setAttribute('aria-label', getMessage('readerSelectVocabulary', entry.text));
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) selectedVocabulary.add(entry.id);
					else selectedVocabulary.delete(entry.id);
					removeSelected.disabled = selectedVocabulary.size === 0;
					saveSelected.disabled = selectedVocabulary.size === 0;
				});
				const body = doc.createElement('div');
				const title = doc.createElement('strong');
				title.textContent = entry.text;
				const explanation = doc.createElement('p');
				explanation.textContent = entry.explanation;
				const itemActions = doc.createElement('div');
				itemActions.className = 'language-learning-vocabulary-actions';
				const copy = createButton(doc, 'language-learning-vocabulary-copy', getMessage('copyToClipboard'));
				copy.addEventListener('click', async () => {
					await tools.copyLearningText?.([entry.text, entry.explanation].join('\n\n'));
				});
				const save = createButton(doc, 'language-learning-vocabulary-save', getMessage('addToObsidian'));
				save.addEventListener('click', async event => {
					if (!event.isTrusted) return;
					await tools.saveVocabularyToObsidian?.(entry, entry.explanation);
					onFeedback(getMessage('readerSavedToObsidian'));
				});
				const remove = createButton(doc, 'language-learning-vocabulary-remove', getMessage('remove'));
				remove.addEventListener('click', async () => {
					await tools.removeVocabulary?.(entry.id);
					selectedVocabulary.delete(entry.id);
					await refresh();
				});
				itemActions.append(copy, save, remove);
				body.append(title, explanation, itemActions);
				item.append(checkbox, body);
				list.appendChild(item);
			}
		};

		search.addEventListener('input', renderList);
		filter.addEventListener('change', renderList);
		removeSelected.addEventListener('click', async () => {
			await tools.removeVocabularyMany?.([...selectedVocabulary]);
			selectedVocabulary.clear();
			await refresh();
			onFeedback(getMessage('readerRemovedSelected'));
		});
		saveSelected.addEventListener('click', async event => {
			if (!event.isTrusted) return;
			for (const entry of vocabulary.filter(item => selectedVocabulary.has(item.id))) {
				await tools.saveVocabularyToObsidian?.(entry, entry.explanation);
			}
			onFeedback(getMessage('readerSavedToObsidian'));
		});
		exportButton.addEventListener('click', async () => {
			const json = await tools.exportVocabulary?.();
			if (json) await tools.copyLearningText?.(json);
			onFeedback(getMessage('readerCopiedExport'));
		});
		const fileInput = createFileInput(doc, async json => {
			const imported = await tools.importVocabulary?.(json) || 0;
			await refresh();
			onFeedback(getMessage('readerImportedCount', String(imported)));
		});
		importButton.addEventListener('click', () => fileInput.click());
		clearButton.addEventListener('click', async () => {
			if (!confirmAction(getMessage('readerClearVocabularyConfirm'))) return;
			await tools.clearVocabulary?.();
			selectedVocabulary.clear();
			await refresh();
		});
		toolbar.append(search, filter, count);
		actions.append(removeSelected, saveSelected, exportButton, importButton, clearButton, fileInput);
		content.append(toolbar, actions, list);
		renderList();
	};

	const renderReadings = () => {
		content.replaceChildren();
		const form = doc.createElement('div');
		form.className = 'language-learning-center-reading-form';
		const surface = doc.createElement('input');
		surface.className = 'language-learning-center-surface';
		surface.placeholder = getMessage('readerDictionarySurface');
		const reading = doc.createElement('input');
		reading.className = 'language-learning-center-reading';
		reading.placeholder = getMessage('readerDictionaryReading');
		const add = createButton(doc, 'language-learning-center-add-reading', getMessage('add'));
		add.addEventListener('click', async () => {
			if (!surface.value.trim() || !reading.value.trim()) return;
			await tools.saveJapaneseReadingOverride?.(surface.value, reading.value);
			surface.value = '';
			reading.value = '';
			await refresh();
		});
		form.append(surface, reading, add);
		const actions = doc.createElement('div');
		actions.className = 'language-learning-center-actions';
		const exportButton = createButton(doc, '', getMessage('export'));
		const importButton = createButton(doc, '', getMessage('import'));
		const clearButton = createButton(doc, '', getMessage('readerClearAll'));
		exportButton.addEventListener('click', async () => {
			const json = await tools.exportJapaneseReadingDictionary?.();
			if (json) await tools.copyLearningText?.(json);
			onFeedback(getMessage('readerCopiedExport'));
		});
		const fileInput = createFileInput(doc, async json => {
			const imported = await tools.importJapaneseReadingDictionary?.(json) || 0;
			await refresh();
			onFeedback(getMessage('readerImportedCount', String(imported)));
		});
		importButton.addEventListener('click', () => fileInput.click());
		clearButton.addEventListener('click', async () => {
			if (!confirmAction(getMessage('readerClearDictionaryConfirm'))) return;
			await tools.clearJapaneseReadingDictionary?.();
			await refresh();
		});
		actions.append(exportButton, importButton, clearButton, fileInput);
		const list = doc.createElement('div');
		list.className = 'language-learning-center-list';
		if (dictionary.length === 0) {
			const empty = doc.createElement('p');
			empty.className = 'language-learning-center-empty';
			empty.textContent = getMessage('readerReadingDictionaryEmpty');
			list.appendChild(empty);
		} else {
			for (const entry of dictionary) {
				const item = doc.createElement('article');
				item.className = 'language-learning-center-entry';
				const text = doc.createElement('span');
				text.textContent = `${entry.surface} · ${entry.reading}`;
				const remove = createButton(doc, '', getMessage('remove'));
				remove.addEventListener('click', async () => {
					await tools.removeJapaneseReadingOverride?.(entry.surface);
					await refresh();
				});
				item.append(text, remove);
				list.appendChild(item);
			}
		}
		content.append(form, actions, list);
	};

	const render = () => {
		setTabState();
		if (activeTab === 'vocabulary') renderVocabulary();
		else renderReadings();
	};
	const refresh = async () => {
		[vocabulary, dictionary] = await Promise.all([
			tools.listVocabulary?.() || Promise.resolve([]),
			tools.listJapaneseReadingDictionary?.() || Promise.resolve([])
		]);
		render();
	};
	vocabularyTab.addEventListener('click', () => { activeTab = 'vocabulary'; render(); });
	readingsTab.addEventListener('click', () => { activeTab = 'readings'; render(); });

	return { ready: refresh(), refresh };
}

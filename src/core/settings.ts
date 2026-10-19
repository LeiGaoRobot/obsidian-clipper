import { 
	deleteTemplate,
	duplicateTemplate,
	findTemplateById, 
	getEditingTemplateIndex, 
	loadTemplates, 
	saveTemplateSettings, 
	templates,
	cleanupTemplateStorage,
	rebuildTemplateList
} from '../managers/template-manager';
import { updateTemplateList, showTemplateEditor, initializeAddPropertyButton, initializeTemplateValidation } from '../managers/template-ui';
import { initializeGeneralSettings } from '../managers/general-settings';
import { showSettingsSection, initializeSidebar, type SettingsSection } from '../managers/settings-section-ui';
import type { AiSettingsSection } from '../settings/ai/index';
import { initializeReaderSettings } from '../managers/reader-settings';
import { initializeAutoSave } from '../utils/auto-save';
import { handleTemplateDrag, initializeDragAndDrop } from '../utils/drag-and-drop';
import { exportTemplate, showTemplateImportModal, copyTemplateToClipboard } from '../utils/import-export';
import { createIcons } from 'lucide';
import { icons } from '../icons/icons';
import { updateUrl, getUrlParameters } from '../utils/routing';
import { addBrowserClassToHtml } from '../utils/browser-detection';
import { initializeMenu } from '../managers/menu';
import { addMenuItemListener } from '../managers/menu';
import { translatePage, getCurrentLanguage, setLanguage, getAvailableLanguages, getMessage, setupLanguageAndDirection } from '../utils/i18n';
import { applyPagePickBranding } from '../utils/pagepick-branding';

declare global {
	interface Window {
		cleanupTemplateStorage: () => Promise<void>;
		rebuildTemplateList: () => Promise<void>;
	}
}

let aiSettingsPromise: Promise<AiSettingsSection> | null = null;

/**
 * Loads the AI section (lazy `settings-ai` chunk) once. It also drives the template editor's
 * prompt-context visibility, so the templates section loads it too. Storage work only: loading
 * never sends a model request.
 */
function ensureAiSettings(): Promise<AiSettingsSection> {
	aiSettingsPromise ??= import(/* webpackChunkName: 'settings-ai' */ '../settings/ai/index')
		.then(module => module.initializeAiSettings())
		.then(section => {
			// Saves a pending prompt-context edit when the page goes away.
			window.addEventListener('pagehide', () => section.dispose(), { once: true });
			return section;
		})
		.catch(error => {
			aiSettingsPromise = null;
			throw error;
		});
	return aiSettingsPromise;
}

/** `interpreter` is the section's former name, still used by older links. */
function settingsSectionFromUrl(section: string | null): SettingsSection | undefined {
	if (section === 'interpreter') return 'ai';
	return section === 'general' || section === 'ai' || section === 'properties' || section === 'highlighter' || section === 'reader'
		? section
		: undefined;
}

window.cleanupTemplateStorage = cleanupTemplateStorage;
window.rebuildTemplateList = rebuildTemplateList;

document.addEventListener('DOMContentLoaded', async () => {
	const newTemplateBtn = document.getElementById('new-template-btn') as HTMLButtonElement;

	// Apply section from URL params immediately to avoid flash (DOM only, no side effects)
	const { section: initialSection } = getUrlParameters();
	const targetSection = settingsSectionFromUrl(initialSection) ?? 'general';
	document.addEventListener('settings-section-change', event => {
		const section = (event as CustomEvent<{ section?: string }>).detail?.section;
		if (section === 'ai' || section === 'templates') {
			void ensureAiSettings().catch(error => {
				console.error('Error initializing AI settings:', error);
			});
		}
	});
	document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
	document.querySelectorAll('#sidebar li[data-section]').forEach(i => i.classList.remove('active'));
	document.getElementById(`${targetSection}-section`)?.classList.add('active');
	document.querySelector(`#sidebar li[data-section="${targetSection}"]`)?.classList.add('active');

	async function initializeSettings(): Promise<void> {
		try {
			await translatePage();
			applyPagePickBranding();

			await initializeGeneralSettings();
			await initializeReaderSettings();
			
			if (targetSection === 'ai') {
				try {
					await ensureAiSettings();
				} catch (error) {
					console.error('Error initializing AI settings, continuing without them:', error);
				}
			}
			
			// Load templates with error handling
			let loadedTemplates;
			try {
				loadedTemplates = await loadTemplates();
				updateTemplateList(loadedTemplates);
			} catch (error) {
				console.error('Error loading templates:', error);
				// Continue with empty template list
				updateTemplateList([]);
			}
			initializeTemplateListeners();
			await handleUrlParameters();
			initializeSidebar();
			initializeAutoSave();
			initializeMenu('more-actions-btn', 'template-actions-menu');

			createIcons({ icons });

			// Initialize language selector
			const languageSelect = document.getElementById('language-select') as HTMLSelectElement;
			if (languageSelect) {
				await initializeLanguageSelector(languageSelect);
			}
		} catch (error) {
			console.error('Error during settings initialization:', error);
			// Show a basic error message but continue with minimal functionality
			const errorContainer = document.querySelector('#content');
			if (errorContainer) {
				errorContainer.textContent = '';

				const errorDiv = document.createElement('div');
				errorDiv.style.padding = '20px';
				errorDiv.style.textAlign = 'center';
				
				const heading = document.createElement('h2');
				heading.textContent = 'Settings error';
				errorDiv.appendChild(heading);
				
				const message = document.createElement('p');
				message.textContent = 'There was an error loading your settings. This may be due to corrupted data.';
				errorDiv.appendChild(message);
				
				errorContainer.appendChild(errorDiv);
			}
			
			// Try to initialize at least the sidebar for navigation
			try {
				initializeSidebar();
			} catch (sidebarError) {
				console.error('Failed to initialize sidebar:', sidebarError);
			}
		}
	}

	async function initializeLanguageSelector(languageSelect: HTMLSelectElement): Promise<void> {
		try {
			await setupLanguageAndDirection();
			await translatePage();
			applyPagePickBranding();
			
			// Populate language options
			const languages = getAvailableLanguages();
			const currentLanguage = await getCurrentLanguage();
			
			// Clear existing options
			languageSelect.textContent = '';
			
			// Add language options
			languages.forEach((lang: { code: string; name: string }) => {
				const option = document.createElement('option');
				option.value = lang.code;
				option.textContent = lang.code === '' ? getMessage('systemDefault') : lang.name;
				if (lang.code === currentLanguage) {
					option.selected = true;
				}
				languageSelect.appendChild(option);
			});

			// Add change listener
			languageSelect.addEventListener('change', async () => {
				try {
					await setLanguage(languageSelect.value);
					window.location.reload(); // Force reload the current page
				} catch (error) {
					console.error('Failed to change language:', error);
				}
			});
		} catch (error) {
			console.error('Failed to initialize language selector:', error);
		}
	}

	function initializeTemplateListeners(): void {
		if (newTemplateBtn) {
			newTemplateBtn.addEventListener('click', () => {
				showTemplateEditor(null);
			});
		}

		addMenuItemListener('#duplicate-template-btn', 'template-actions-menu', duplicateCurrentTemplate);
		addMenuItemListener('#delete-template-btn', 'template-actions-menu', deleteCurrentTemplate);
		addMenuItemListener('.export-template-btn', 'template-actions-menu', exportTemplate);
		addMenuItemListener('.import-template-btn', 'template-actions-menu', showTemplateImportModal);
		addMenuItemListener('#copy-template-json-btn', 'template-actions-menu', copyCurrentTemplateToClipboard);
	}

	function duplicateCurrentTemplate(): void {
		const editingTemplateIndex = getEditingTemplateIndex();
		if (editingTemplateIndex !== -1) {
			const currentTemplate = templates[editingTemplateIndex];
			const newTemplate = duplicateTemplate(currentTemplate.id);
			saveTemplateSettings().then(() => {
				updateTemplateList();
				showTemplateEditor(newTemplate);
				updateUrl('templates', newTemplate.id);
			}).catch(error => {
				console.error('Failed to duplicate template:', error);
				alert(getMessage('failedToDuplicateTemplate'));
			});
		}
	}

	async function deleteCurrentTemplate(): Promise<void> {
		const editingTemplateIndex = getEditingTemplateIndex();
		if (editingTemplateIndex !== -1) {
			const currentTemplate = templates[editingTemplateIndex];
			if (confirm(getMessage('confirmDeleteTemplate', [currentTemplate.name]))) {
				const success = await deleteTemplate(currentTemplate.id);
				if (success) {
					// Reload templates after deletion
					await loadTemplates();
					updateTemplateList();
					if (templates.length > 0) {
						showTemplateEditor(templates[0]);
					} else {
						showSettingsSection('general');
					}
				} else {
					alert(getMessage('failedToDeleteTemplate'));
				}
			}
		}
	}

	async function handleUrlParameters(): Promise<void> {
		const { section, templateId } = getUrlParameters();

		const settingsSection = settingsSectionFromUrl(section);
		if (settingsSection) {
			showSettingsSection(settingsSection);
		} else if (templateId) {
			const template = findTemplateById(templateId);
			if (template) {
				showTemplateEditor(template);
			} else {
				console.error(`Template with id ${templateId} not found`);
				showSettingsSection('general');
			}
		} else {
			showSettingsSection('general');
		}
	}

	function copyCurrentTemplateToClipboard(): void {
		const editingTemplateIndex = getEditingTemplateIndex();
		if (editingTemplateIndex !== -1) {
			const currentTemplate = templates[editingTemplateIndex];
			copyTemplateToClipboard(currentTemplate);
		}
	}

	const templateForm = document.getElementById('template-settings-form');
	if (templateForm) {
		initializeAddPropertyButton();
		initializeTemplateValidation();
		initializeDragAndDrop();
		handleTemplateDrag();
	}

	await addBrowserClassToHtml();
	await initializeSettings();
});

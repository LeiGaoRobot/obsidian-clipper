import type { TranscriptLayoutMode } from '../types/types';
import {
	TRANSCRIPT_LAYOUT_MODES,
	syncTranscriptControlsPanel,
	updateTranscriptPlayerHeight
} from '../utils/transcript-layout';

function getPreviewElements(doc: Document) {
	const root = doc.querySelector<HTMLElement>('.transcript-study-layout');
	return {
		root,
		player: root?.querySelector<HTMLElement>('.player-container') || null,
		controls: root?.querySelector<HTMLElement>('.player-toggles') || null,
		transcript: root?.querySelector<HTMLElement>('.youtube.transcript') || null
	};
}

export function setTranscriptPreviewLayout(doc: Document, mode: TranscriptLayoutMode): void {
	const { root, player, controls, transcript } = getPreviewElements(doc);
	if (!root || !player || !controls || !transcript) return;
	for (const item of TRANSCRIPT_LAYOUT_MODES) {
		doc.documentElement.classList.toggle(`transcript-layout-${item}`, item === mode);
		root.classList.toggle(`transcript-layout-${item}`, item === mode);
		root.querySelector(`[data-transcript-layout="${item}"]`)
			?.setAttribute('aria-pressed', String(item === mode));
	}
	doc.documentElement.dataset.previewLayout = mode;
	if (mode === 'reading') player.appendChild(controls);
	else root.insertBefore(controls, transcript);
	updateTranscriptPlayerHeight(root, player);
}

function initializeTranscriptLayoutPreview(doc: Document): void {
	const { root, player, transcript } = getPreviewElements(doc);
	if (!root || !player || !transcript) return;
	const moreControls = root.querySelector<HTMLDetailsElement>('.player-controls-more');
	const morePanel = root.querySelector<HTMLElement>('.player-controls-panel');
	const morePanelTitle = root.querySelector<HTMLElement>('#preview-controls-title');
	const controlsBackdrop = doc.createElement('div');
	controlsBackdrop.className = 'player-controls-backdrop';
	controlsBackdrop.setAttribute('aria-hidden', 'true');
	const updateMoreControls = () => {
		if (!moreControls || !morePanel) return;
		const isMobile = (doc.defaultView?.innerWidth || 0) <= 768;
		const controls = root.querySelector<HTMLElement>('.player-toggles');
		if (!controls) return;
		syncTranscriptControlsPanel({
			doc,
			root,
			details: moreControls,
			panel: morePanel,
			controls,
			isMobile
		});
		const modalOpen = moreControls.open && isMobile;
		if (modalOpen) {
			morePanel.setAttribute('role', 'dialog');
			morePanel.setAttribute('aria-modal', 'true');
			if (morePanelTitle) morePanel.setAttribute('aria-labelledby', morePanelTitle.id);
			root.insertBefore(controlsBackdrop, morePanel);
		} else {
			morePanel.removeAttribute('role');
			morePanel.removeAttribute('aria-modal');
			morePanel.removeAttribute('aria-labelledby');
			controlsBackdrop.remove();
		}
		doc.documentElement.dataset.previewControls = moreControls.open ? 'open' : 'closed';
		doc.documentElement.dataset.previewPanelHost = morePanel.parentElement === root ? 'root' : 'details';
	};
	controlsBackdrop.addEventListener('click', () => {
		if (moreControls) moreControls.open = false;
		updateMoreControls();
	});

	root.addEventListener('click', event => {
		const target = event.target as HTMLElement;
		const layoutButton = target.closest<HTMLButtonElement>('[data-transcript-layout]');
		if (layoutButton) {
			setTranscriptPreviewLayout(doc, layoutButton.dataset.transcriptLayout as TranscriptLayoutMode);
			return;
		}

		const compactButton = target.closest<HTMLButtonElement>('[data-preview-compact]');
		if (compactButton) {
			const compact = player.classList.toggle('is-compact');
			compactButton.classList.toggle('is-enabled', compact);
			compactButton.setAttribute('aria-pressed', String(compact));
			compactButton.textContent = compact
				? compactButton.dataset.expandedLabel || ''
				: compactButton.dataset.compactLabel || '';
			return;
		}

		const closeControls = target.closest<HTMLButtonElement>('[data-preview-close-controls]');
		if (closeControls) {
			if (moreControls) moreControls.open = false;
			updateMoreControls();
			return;
		}

		const toggleButton = target.closest<HTMLButtonElement>('[data-preview-toggle]');
		if (toggleButton) {
			const enabled = toggleButton.classList.toggle('is-enabled');
			toggleButton.setAttribute('aria-pressed', String(enabled));
			if (toggleButton.dataset.previewToggle === 'bilingual') {
				transcript.classList.toggle('show-bilingual-transcript', enabled);
			}
			if (toggleButton.dataset.previewToggle === 'readings') {
				transcript.classList.toggle('show-japanese-readings', enabled);
			}
			return;
		}

		const pressedButton = target.closest<HTMLButtonElement>('[data-preview-pressed]');
		if (pressedButton) {
			pressedButton.setAttribute(
				'aria-pressed',
				String(pressedButton.getAttribute('aria-pressed') !== 'true')
			);
		}
	});

	root.addEventListener('change', event => {
		const input = (event.target as HTMLElement).closest<HTMLInputElement>('.player-toggle input');
		const label = input?.closest<HTMLElement>('.player-toggle');
		if (!input || !label) return;
		label.classList.toggle('is-enabled', input.checked);
		label.setAttribute('aria-checked', String(input.checked));
	});

	moreControls?.addEventListener('toggle', updateMoreControls);
	doc.defaultView?.addEventListener('resize', updateMoreControls);

	const previewUrl = new URL(doc.defaultView?.location.href || 'http://localhost');
	const requestedLayout = previewUrl.searchParams.get('layout');
	const initialLayout = TRANSCRIPT_LAYOUT_MODES.includes(requestedLayout as TranscriptLayoutMode)
		? requestedLayout as TranscriptLayoutMode
		: 'focus';
	setTranscriptPreviewLayout(doc, initialLayout);
	if (moreControls) moreControls.open = previewUrl.searchParams.get('controls') === 'open';
	updateMoreControls();
	doc.documentElement.dataset.previewReady = 'true';
}

if (typeof document !== 'undefined') initializeTranscriptLayoutPreview(document);

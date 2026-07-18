const root = document.querySelector<HTMLElement>('.transcript-study-layout');
const player = root?.querySelector<HTMLElement>('.player-container');
const controls = root?.querySelector<HTMLElement>('.player-toggles');
const transcript = root?.querySelector<HTMLElement>('.youtube.transcript');

function setLayout(mode: 'reading' | 'notebook' | 'focus'): void {
	if (!root || !player || !controls || !transcript) return;
	for (const item of ['reading', 'notebook', 'focus'] as const) {
		document.documentElement.classList.toggle(`transcript-layout-${item}`, item === mode);
		root.classList.toggle(`transcript-layout-${item}`, item === mode);
		root.querySelector(`[data-transcript-layout="${item}"]`)
			?.setAttribute('aria-pressed', String(item === mode));
	}
	if (mode === 'reading') player.appendChild(controls);
	else root.insertBefore(controls, transcript);
}

root?.addEventListener('click', event => {
	const target = event.target as HTMLElement;
	const layoutButton = target.closest<HTMLButtonElement>('[data-transcript-layout]');
	if (layoutButton) {
		setLayout(layoutButton.dataset.transcriptLayout as 'reading' | 'notebook' | 'focus');
		return;
	}

	const toggleButton = target.closest<HTMLButtonElement>('[data-preview-toggle]');
	if (toggleButton && transcript) {
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

root?.addEventListener('change', event => {
	const input = (event.target as HTMLElement).closest<HTMLInputElement>('.player-toggle input');
	const label = input?.closest<HTMLElement>('.player-toggle');
	if (!input || !label) return;
	label.classList.toggle('is-enabled', input.checked);
	label.setAttribute('aria-checked', String(input.checked));
});

document.documentElement.dataset.previewReady = 'true';

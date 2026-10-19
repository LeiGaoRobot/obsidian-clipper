// Shared DOM fixtures for the Reader transcript learning tests.

export function createTranscript(texts = ['Hello world.']) {
	document.body.innerHTML = `
		<div class="player-toggle-group"></div>
		<div class="youtube transcript">
			${texts.map((text, index) => `
				<div class="transcript-segment">
					<strong class="timestamp" data-timestamp="${index * 200}">${index}:00</strong>
					<div class="transcript-segment-text">${text}</div>
				</div>
			`).join('')}
		</div>
	`;
	return {
		controls: document.querySelector('.player-toggle-group') as HTMLElement,
		transcript: document.querySelector('.youtube.transcript') as HTMLElement,
		segments: Array.from(document.querySelectorAll('.transcript-segment')) as HTMLElement[]
	};
}

export function selectText(startNode: Node, start: number, endNode: Node, end: number) {
	const range = document.createRange();
	range.setStart(startNode, start);
	range.setEnd(endNode, end);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
}

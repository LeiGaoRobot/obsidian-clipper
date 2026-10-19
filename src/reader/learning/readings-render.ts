import { getMessage } from '../../utils/i18n';
import type { TranscriptReadingToken } from '../../utils/language-learning';
import { JAPANESE_KANJI } from './japanese';

// Rendering Japanese readings as ruby into transcript segments. DOM functions of `doc`, no state.

function populateTranscriptReadings(
	doc: Document,
	target: HTMLElement,
	tokens: TranscriptReadingToken[],
	editable: boolean,
	onReadingInput?: (tokenIndex: number, reading: string) => void
): void {
	target.replaceChildren();
	tokens.forEach((token, tokenIndex) => {
		if (!token.reading && !JAPANESE_KANJI.test(token.text)) {
			target.appendChild(doc.createTextNode(token.text));
			return;
		}
		const ruby = doc.createElement('ruby');
		const base = doc.createElement('span');
		const reading = doc.createElement('rt');
		base.textContent = token.text;
		reading.textContent = token.reading;
		reading.setAttribute('contenteditable', editable ? 'true' : 'false');
		if (editable) {
			reading.setAttribute('role', 'textbox');
			reading.setAttribute('aria-label', getMessage('readerReadingEditLabel', token.text));
			reading.setAttribute('aria-multiline', 'false');
			reading.setAttribute('tabindex', '0');
			reading.setAttribute('spellcheck', 'false');
			reading.addEventListener('input', () => {
				onReadingInput?.(tokenIndex, reading.textContent?.trim() || '');
			});
		}
		ruby.append(base, reading);
		if (!editable) {
			ruby.className = 'transcript-reading-token';
			ruby.setAttribute('role', 'button');
			ruby.setAttribute('tabindex', '0');
			ruby.setAttribute('aria-pressed', 'false');
			ruby.setAttribute('aria-label', getMessage('readerToggleReading', token.text));
			const toggleReading = () => {
				const hidden = ruby.classList.toggle('is-reading-hidden');
				ruby.setAttribute('aria-pressed', String(hidden));
			};
			ruby.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				toggleReading();
			});
			ruby.addEventListener('keydown', event => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				event.stopPropagation();
				toggleReading();
			});
		}
		target.appendChild(ruby);
	});
}

export function renderTranscriptReadings(
	doc: Document,
	textElement: Element,
	tokens: TranscriptReadingToken[],
	showReadings: boolean,
	editable: boolean,
	onReadingInput?: (tokenIndex: number, reading: string) => void
): void {
	const originalElement = doc.createElement('span');
	originalElement.className = 'transcript-segment-original';
	originalElement.setAttribute('data-original-text', tokens.map(token => token.text).join(''));
	if (showReadings) {
		populateTranscriptReadings(doc, originalElement, tokens, editable, onReadingInput);
	} else {
		originalElement.textContent = tokens.map(token => token.text).join('');
	}

	const translationElement = textElement.querySelector('.transcript-segment-translation');
	Array.from(textElement.childNodes).forEach(node => {
		if (node !== translationElement) node.remove();
	});
	if (translationElement) {
		textElement.insertBefore(originalElement, translationElement);
	} else {
		textElement.appendChild(originalElement);
	}
}

export function renderJapaneseTranslationReadings(
	doc: Document,
	textElement: Element,
	tokens: TranscriptReadingToken[],
	showReadings: boolean,
	editable: boolean,
	onReadingInput?: (tokenIndex: number, reading: string) => void
): void {
	let japaneseElement = textElement.querySelector<HTMLElement>('.transcript-segment-japanese');
	if (!japaneseElement) {
		japaneseElement = doc.createElement('div');
		japaneseElement.className = 'transcript-segment-japanese';
		textElement.appendChild(japaneseElement);
	}
	if (showReadings) {
		populateTranscriptReadings(doc, japaneseElement, tokens, editable, onReadingInput);
	}
	japaneseElement.hidden = !showReadings;
}

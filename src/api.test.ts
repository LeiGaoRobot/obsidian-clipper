// Node with the linkedom globals the CLI's esbuild banner installs (scripts/build-cli.mjs), so
// Defuddle and the Markdown converter see what `dist/cli.cjs` gives them. Under jsdom, Defuddle's
// style checks reject linkedom elements, which would hide the extraction this file tests.
import { beforeAll, describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import type { DocumentParser } from './api';
import type { Template } from './types/types';

let clip: typeof import('./api').clip;

beforeAll(async () => {
	const globals = globalThis as Record<string, unknown>;
	class LinkedomParser {
		parseFromString(source: string) {
			return parseHTML(source).document;
		}
	}
	globals.window ??= globalThis;
	globals.DOMParser ??= LinkedomParser;
	globals.document ??= parseHTML('<!DOCTYPE html><html><head></head><body></body></html>').document;
	({ clip } = await import('./api'));
});

const parser: DocumentParser = { parseFromString: html => parseHTML(html).document };
const url = 'https://example.com/tidal-gardens';
const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Tidal Gardens of the North Coast</title>
	<meta name="author" content="Ada Example">
	<meta name="description" content="A field guide to rock pools.">
</head>
<body>
	<header><nav><a href="/">Home</a></nav></header>
	<main><article>
		<h1>Tidal Gardens of the North Coast</h1>
		<p>Rock pools along the north coast hold anemones, limpets and small crabs that survive twice-daily exposure to air and sun.</p>
		<p>Visit at low tide, step only on bare rock, and return every stone you lift to the place where you found it.</p>
	</article></main>
	<footer>Copyright</footer>
</body>
</html>`;
const template: Template = {
	id: 't',
	name: 'T',
	behavior: 'create',
	noteNameFormat: '{{title}}',
	path: '',
	noteContentFormat: 'Words: {{words}}\n\n{{content}}',
	properties: [{ id: 'p1', name: 'author', value: '{{author}}', type: 'text' }]
};

describe('clip', () => {
	test.each([
		['parses the HTML itself', {}],
		['reuses a pre-parsed linkedom Document', { parsedDocument: parser.parseFromString(html, 'text/html') }]
	])('extracts the title, content and word count when it %s', async (_name, options) => {
		const result = await clip({ html, url, template, documentParser: parser, ...options });

		expect(result.noteName).toBe('Tidal Gardens of the North Coast');
		expect(result.variables['{{title}}']).toBe('Tidal Gardens of the North Coast');
		expect(result.variables['{{author}}']).toBe('Ada Example');
		expect(Number(result.variables['{{words}}'])).toBeGreaterThan(20);
		expect(result.content).toContain('Rock pools along the north coast hold anemones');
		expect(result.content).not.toContain('Copyright');
		expect(result.content).not.toContain('Partial conversion');
		expect(result.frontmatter).toContain('author: "Ada Example"');
		expect(result.content).toContain('Words: ');
	});

	test('formats typed properties, but leaves kept prompt placeholders to the caller', async () => {
		const typed: Template = {
			...template,
			properties: [
				{ id: 'p1', name: 'count', value: '{{"Top 3 things"}}', type: 'number' },
				{ id: 'p2', name: 'done', value: '{{"Is it done?"}}', type: 'checkbox' },
				{ id: 'p3', name: 'words', value: '{{words}} words', type: 'number' },
				{ id: 'p4', name: 'flag', value: 'true', type: 'checkbox' }
			]
		};

		const kept = await clip({ html, url, template: typed, documentParser: parser, keepPromptVariables: true });
		const removed = await clip({ html, url, template: typed, documentParser: parser });

		const [count, done, words, flag] = kept.properties.map(property => property.value);
		expect([count, done]).toEqual(['{{"Top 3 things"}}', '{{"Is it done?"}}']);
		expect(words).toMatch(/^\d+$/);
		expect(flag).toBe('true');
		expect(removed.properties.map(property => property.value)).toEqual(['', 'false', words, 'true']);
	});
});

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectories = ['dist', 'dist_firefox', 'dist_safari'];
const lazyChunks = [
	'popup-language-learning.js',
	'reader-content-extraction.js',
	'reader-language-learning.js',
	'reader-markdown.js',
	'reader-syntax-highlighting.js',
	'settings-interpreter.js',
	'src_utils_language-learning-runtime_ts.js',
	'vendors-node_modules_defuddle_dist_index_full_js.js'
];

function requireFile(filePath) {
	if (!existsSync(filePath) || statSync(filePath).size === 0) {
		throw new Error(`Missing built extension asset: ${path.relative(root, filePath)}`);
	}
	return readFileSync(filePath, 'utf8');
}

for (const outputDirectory of outputDirectories) {
	const output = path.join(root, outputDirectory);
	for (const chunk of lazyChunks) requireFile(path.join(output, 'chunks', chunk));

	for (const entry of ['popup.js', 'settings.js', 'reader-page.js', 'reader-script.js']) {
		const source = requireFile(path.join(output, entry));
		if (!source.includes('chunks/')) {
			throw new Error(`${outputDirectory}/${entry} does not contain the lazy-chunk loader.`);
		}
	}

	const background = requireFile(path.join(output, 'background.js'));
	if (background.includes('chunks/')) {
		throw new Error(`${outputDirectory}/background.js must remain a synchronous MV3 entry.`);
	}

	const manifest = JSON.parse(requireFile(path.join(output, 'manifest.json')));
	const resources = manifest.web_accessible_resources
		?.flatMap(entry => Array.isArray(entry.resources) ? entry.resources : [])
		?? [];
	if (!resources.includes('chunks/*.js')) {
		throw new Error(`${outputDirectory}/manifest.json does not expose generated Reader chunks.`);
	}
	if (!resources.includes('_locales/*/messages.json')) {
		throw new Error(`${outputDirectory}/manifest.json does not expose runtime locale messages.`);
	}
}

console.log('Extension bundle boundaries passed for Chrome, Firefox, and Safari.');

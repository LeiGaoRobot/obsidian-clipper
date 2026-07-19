import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectories = ['dist', 'dist_firefox', 'dist_safari'];
const verify = process.argv.includes('--verify');

const entryBudgets = {
	'background.js': 900_000,
	'content.js': 1_425_000,
	'highlights.js': 1_450_000,
	'popup.js': 1_350_000,
	'reader-page.js': 750_000,
	'reader-script.js': 400_000,
	'settings.js': 1_300_000
};

const chunkBudgets = {
	'popup-language-learning.js': 30_000,
	'reader-content-extraction.js': 380_000,
	'reader-language-learning.js': 160_000,
	'reader-markdown.js': 10_000,
	'reader-syntax-highlighting.js': 250_000,
	'settings-interpreter.js': 60_000,
	'src_utils_language-learning-runtime_ts.js': 40_000,
	'vendors-node_modules_defuddle_dist_index_full_js.js': 800_000
};

function listAssets(directory, prefix = '') {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const relative = path.join(prefix, entry.name);
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) return listAssets(absolute, relative);
		return /\.(?:js|css)$/.test(entry.name) ? [relative] : [];
	});
}

function formatBytes(bytes) {
	return bytes < 1024
		? `${bytes} B`
		: `${(bytes / 1024).toFixed(bytes >= 1024 * 1024 ? 0 : 1)} KiB`;
}

let failed = false;
for (const outputDirectory of outputDirectories) {
	const output = path.join(root, outputDirectory);
	if (!existsSync(output)) {
		if (verify) {
			console.error(`${outputDirectory}: build output is missing.`);
			failed = true;
		}
		continue;
	}

	console.log(`\n${outputDirectory}`);
	console.log('asset'.padEnd(52), 'raw'.padStart(10), 'gzip'.padStart(10), 'budget'.padStart(10));
	for (const asset of listAssets(output).sort()) {
		const absolute = path.join(output, asset);
		const raw = statSync(absolute).size;
		const gzip = gzipSync(readFileSync(absolute)).length;
		const normalized = asset.split(path.sep).join('/');
		const budget = entryBudgets[normalized]
			?? (normalized.startsWith('chunks/') ? chunkBudgets[path.basename(normalized)] : undefined);
		const overBudget = budget != null && raw > budget;
		console.log(
			normalized.padEnd(52),
			formatBytes(raw).padStart(10),
			formatBytes(gzip).padStart(10),
			(budget == null ? '—' : formatBytes(budget)).padStart(10),
			overBudget ? ' OVER' : ''
		);
		if (verify && overBudget) failed = true;
	}

	if (verify) {
		for (const asset of Object.keys(entryBudgets)) {
			if (!existsSync(path.join(output, asset))) {
				console.error(`${outputDirectory}: required entry ${asset} is missing.`);
				failed = true;
			}
		}
		for (const asset of Object.keys(chunkBudgets)) {
			if (!existsSync(path.join(output, 'chunks', asset))) {
				console.error(`${outputDirectory}: required chunk chunks/${asset} is missing.`);
				failed = true;
			}
		}
	}
}

if (failed) process.exitCode = 1;
else if (verify) console.log('\nExtension bundle budgets passed for Chrome, Firefox, and Safari.');

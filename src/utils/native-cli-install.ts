import { getMessage } from './i18n';

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildNativeCliInstallCommand(extensionId: string, workspaceRoot: string): string {
	return `npm --prefix ${shellQuote(workspaceRoot)} run install:native-host -- --extension-id ${extensionId}`;
}

interface NativeCliInstallGuideOptions {
	/** Where the guide's elements are looked up by id; a scoped lookup works too. */
	doc: Pick<Document, 'getElementById'>;
	extensionId: string;
	platform: string;
	isChrome: boolean;
	workspaceRoot?: string;
	copyText: (text: string) => Promise<void>;
}

export interface NativeCliInstallGuideController {
	pendingCopy: () => Promise<void>;
}

export function wireNativeCliInstallGuide({
	doc,
	extensionId,
	platform,
	isChrome,
	workspaceRoot,
	copyText
}: NativeCliInstallGuideOptions): NativeCliInstallGuideController {
	const description = doc.getElementById('native-cli-install-description');
	const commandElement = doc.getElementById('native-cli-install-command');
	const copyButton = doc.getElementById('native-cli-install-copy') as HTMLButtonElement | null;
	const status = doc.getElementById('native-cli-install-status');
	let copyPromise = Promise.resolve();

	if (!description || !commandElement || !copyButton || !status) {
		return { pendingCopy: () => copyPromise };
	}

	const supportedPlatform = isChrome && (platform === 'mac' || platform === 'linux');
	const supported = supportedPlatform && Boolean(workspaceRoot);
	const command = workspaceRoot ? buildNativeCliInstallCommand(extensionId, workspaceRoot) : '';
	commandElement.textContent = command;
	commandElement.hidden = !supported;
	copyButton.hidden = !supported;
	description.textContent = getMessage(
		supported
			? 'nativeCliInstallDescription'
			: supportedPlatform
				? 'nativeCliInstallSourceUnavailable'
				: 'nativeCliInstallUnsupported'
	);

	copyButton.addEventListener('click', () => {
		copyPromise = (async () => {
			status.classList.remove('is-success', 'is-error');
			try {
				await copyText(command);
				status.textContent = getMessage('nativeCliInstallCopied');
				status.classList.add('is-success');
			} catch {
				status.textContent = getMessage('nativeCliInstallCopyFailed');
				status.classList.add('is-error');
			}
		})();
	});

	return { pendingCopy: () => copyPromise };
}

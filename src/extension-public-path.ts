type ExtensionRuntime = {
	getURL(path: string): string;
};

const extensionGlobal = globalThis as typeof globalThis & {
	browser?: { runtime?: ExtensionRuntime };
	chrome?: { runtime?: ExtensionRuntime };
};
const runtime = extensionGlobal.browser?.runtime ?? extensionGlobal.chrome?.runtime;

if (runtime?.getURL) {
	__webpack_public_path__ = runtime.getURL('');
}

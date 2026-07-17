const CLIPPER_IFRAME_CONTAINER_ID = 'obsidian-clipper-container';

/**
 * Clone the page body when doing so will not recreate a live iframe document.
 *
 * Replacing the body with a clone removes page event listeners, but it also
 * recreates iframe elements. A sandboxed about:blank frame can report a
 * blocked-script error when that happens, so leave that live document intact.
 */
export function cloneBodyIfSafe(doc: Document): boolean {
	const body = doc.body;
	if (!body?.parentNode) {
		return false;
	}

	if (doc.getElementById(CLIPPER_IFRAME_CONTAINER_ID) || doc.querySelector('iframe[sandbox]')) {
		return false;
	}

	const newBody = body.cloneNode(true);
	body.parentNode.replaceChild(newBody, body);
	return true;
}

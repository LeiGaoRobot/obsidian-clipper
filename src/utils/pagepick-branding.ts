import browser from './browser-polyfill';
import { getExtensionBranding, PAGEPICK_NAME } from './extension-branding';

export function applyPagePickBranding(doc: Document = document): boolean {
	const manifest = browser.runtime.getManifest();
	const branding = getExtensionBranding();
	if (branding.name !== PAGEPICK_NAME) return false;

	doc.title = branding.name;

	const iconPath = manifest.icons?.['48'];
	if (iconPath) {
		const iconUrl = browser.runtime.getURL(iconPath);
		doc.querySelectorAll<SVGElement>('svg.logo').forEach(logo => {
			const icon = doc.createElement('img');
			icon.className = logo.getAttribute('class') || '';
			icon.src = iconUrl;
			icon.alt = '';
			icon.width = 20;
			icon.height = 20;
			logo.replaceWith(icon);
		});
	}

	const navbarTitle = doc.querySelector('#navbar-title > span');
	if (navbarTitle) navbarTitle.textContent = branding.name;

	const changelogLink = doc.querySelector<HTMLAnchorElement>('#changelog-link');
	if (changelogLink) {
		changelogLink.href = `${branding.homepageUrl.replace(/\/$/, '')}/releases`;
	}

	return true;
}

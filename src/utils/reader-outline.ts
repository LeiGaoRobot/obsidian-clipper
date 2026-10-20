const DEFAULT_TOP_PERCENT = 5;
const OUTLINE_ZONE_PERCENT = 15;
const MAX_TOP_PERCENT = 100 - OUTLINE_ZONE_PERCENT;

function negativeMargin(percent: number): string {
	return percent === 0 ? '0%' : `-${percent}%`;
}

export function buildOutlineRootMargin(stickyOffset: number, viewportHeight: number): string {
	const measuredTopPercent = stickyOffset > 0 && viewportHeight > 0
		? Math.round(stickyOffset / viewportHeight * 100 + 2)
		: DEFAULT_TOP_PERCENT;
	const topPercent = Number.isFinite(measuredTopPercent)
		? Math.min(MAX_TOP_PERCENT, Math.max(0, measuredTopPercent))
		: DEFAULT_TOP_PERCENT;
	const bottomPercent = MAX_TOP_PERCENT - topPercent;
	return `${negativeMargin(topPercent)} 0px ${negativeMargin(bottomPercent)} 0px`;
}

import type { AiStorageKey } from '../../ai/settings';
import type { AiSettingsState } from './controller';

/** One panel of the AI section, rendered into its static container in settings.html. */
export interface AiSettingsPanel {
	/** Storage keys whose changes can change what the panel shows. */
	readonly keys: readonly AiStorageKey[];
	/** What the panel shows, as plain data; equal states skip the render. */
	stateOf(state: AiSettingsState): unknown;
	render(state: AiSettingsState): void;
	dispose?(): void;
}

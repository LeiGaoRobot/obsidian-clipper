import type { PromptVariable } from '../types/types';

// The v1 `prompts_responses` envelope, moved verbatim from llm-client.ts so API adapters keep
// byte-identical prompts. Phase 3 replaces it with per-task output contracts.

export interface PromptResponse {
	key: string;
	prompt: string;
	user_response: any;
}

export const ENVELOPE_SYSTEM_PROMPT =
	`You are a helpful assistant. Please respond with one JSON object named \`prompts_responses\` — no explanatory text before or after. Use the keys provided, e.g. \`prompt_1\`, \`prompt_2\`, and fill in the values. Values should be Markdown strings unless otherwise specified. Make your responses concise. For example, your response should look like: {"prompts_responses":{"prompt_1":"tag1, tag2, tag3","prompt_2":"- bullet1\n- bullet 2\n- bullet3"}}`;

export function buildEnvelopePayload(promptVariables: PromptVariable[]): string {
	return JSON.stringify({
		prompts: promptVariables.reduce((acc, { key, prompt }) => {
			acc[key] = prompt;
			return acc;
		}, {} as { [key: string]: string })
	});
}

interface LLMResponse {
	prompts_responses: { [key: string]: string };
}

export function parseEnvelopeResponse(responseContent: string, promptVariables: PromptVariable[]): { promptResponses: PromptResponse[] } {
	try {
		let parsedResponse: LLMResponse;

		// If responseContent is already an object, convert to string
		if (typeof responseContent === 'object') {
			responseContent = JSON.stringify(responseContent);
		}

		// Helper function to sanitize JSON string
		const sanitizeJsonString = (str: string) => {
			// First, normalize all newlines to \n
			let result = str.replace(/\r\n/g, '\n');

			// Escape newlines properly
			result = result.replace(/\n/g, '\\n');

			// Escape quotes that are part of the content
			result = result.replace(/(?<!\\)"/g, '\\"');

			// Then unescape the quotes that are JSON structural elements
			result = result.replace(/(?<=[{[,:]\s*)\\"/g, '"')
				.replace(/\\"(?=\s*[}\],:}])/g, '"');

			return result
				// Replace curly quotes
				.replace(/[""]/g, '\\"')
				// Remove any bad control characters
				.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
				// Remove any whitespace between quotes and colons
				.replace(/"\s*:/g, '":')
				.replace(/:\s*"/g, ':"')
				// Fix any triple or more backslashes
				.replace(/\\{3,}/g, '\\\\');
		};

		// First try to parse the content directly
		try {
			const sanitizedContent = sanitizeJsonString(responseContent);
			parsedResponse = JSON.parse(sanitizedContent);
		} catch (e) {
			// If direct parsing fails, try to extract and parse the JSON content
			const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				throw new Error('No JSON object found in response');
			}

			// Try parsing with minimal sanitization first
			try {
				const minimalSanitized = jsonMatch[0]
					.replace(/[""]/g, '"')
					.replace(/\r\n/g, '\\n')
					.replace(/\n/g, '\\n');
				parsedResponse = JSON.parse(minimalSanitized);
			} catch (minimalError) {
				// If minimal sanitization fails, try full sanitization
				const sanitizedMatch = sanitizeJsonString(jsonMatch[0]);

				try {
					parsedResponse = JSON.parse(sanitizedMatch);
				} catch (fullError) {
					// Last resort: try to manually rebuild the JSON structure
					const prompts_responses: { [key: string]: string } = {};

					// Extract each prompt response separately
					promptVariables.forEach((variable, index) => {
						const promptKey = `prompt_${index + 1}`;
						const promptRegex = new RegExp(`"${promptKey}"\\s*:\\s*"([^]*?)(?:"\\s*,|"\\s*})`, 'g');
						const match = promptRegex.exec(jsonMatch[0]);
						if (match) {
							let content = match[1]
								.replace(/"/g, '\\"')
								.replace(/\r\n/g, '\\n')
								.replace(/\n/g, '\\n');
							prompts_responses[promptKey] = content;
						}
					});

					const rebuiltJson = JSON.stringify({ prompts_responses });
					parsedResponse = JSON.parse(rebuiltJson);
				}
			}
		}

		// Validate the response structure
		if (!parsedResponse?.prompts_responses) {
			return { promptResponses: [] };
		}

		// Convert escaped newlines to actual newlines in the responses
		Object.keys(parsedResponse.prompts_responses).forEach(key => {
			if (typeof parsedResponse.prompts_responses[key] === 'string') {
				parsedResponse.prompts_responses[key] = parsedResponse.prompts_responses[key]
					.replace(/\\n/g, '\n')
					.replace(/\r/g, '');
			}
		});

		// Map the responses to their prompts
		const promptResponses = promptVariables.map(variable => ({
			key: variable.key,
			prompt: variable.prompt,
			user_response: parsedResponse.prompts_responses[variable.key] || ''
		}));

		return { promptResponses };
	} catch (parseError) {
		console.error('Failed to parse LLM response:', parseError);
		return { promptResponses: [] };
	}
}

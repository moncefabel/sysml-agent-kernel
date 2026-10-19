import type { ToolSpec } from './llm/provider.js';

/**
 * The hitl loop configuration: the model may ask the requester one question at a time through
 * request_clarification, and a deterministic simulated human answers with a fixed reply per
 * scenario. The tool is handled by the harness, never by the kernel, and it is only offered in
 * this configuration, so default runs (and their cache keys) are unchanged.
 */

export const CLARIFICATION_TOOL: ToolSpec = {
  name: 'request_clarification',
  description: 'Ask the person who gave you the task one precise question, when the task is ambiguous and guessing could do the wrong thing. Returns their answer. Do not use it for information you can read from the model.',
  parameters: { type: 'object', properties: { question: { type: 'string', description: 'One precise question.' } }, required: ['question'], additionalProperties: false },
};

export const HITL_SYSTEM_ADDENDUM = '- If the task is ambiguous, call request_clarification with one precise question instead of guessing or ending your turn with a question.';

/** Fixed replies of the simulated human, by scenario id. */
export const CLARIFICATIONS: Record<string, string> = {
  'sc-hidden-port-type': 'Yes, you may retype an existing port, for example the filter inlet, if the model needs it. Only deleting an existing definition is forbidden.',
};

export const DEFAULT_CLARIFICATION = 'I have nothing to add. Use your best judgment within the task as written.';

/** At most this many questions are answered per run; later ones get a refusal reply. */
export const MAX_CLARIFICATIONS = 3;

export function simulatedHuman(scenarioId: string): string {
  return CLARIFICATIONS[scenarioId] ?? DEFAULT_CLARIFICATION;
}

/**
 * True when a final message asks the user something: its last paragraph contains a question
 * mark. Deterministic and deliberately simple; used only to label runs that did not succeed.
 */
export function endsWithQuestion(text: string | undefined): boolean {
  if (!text) return false;
  const paragraphs = text.trim().split(/\n\s*\n/);
  return paragraphs[paragraphs.length - 1].includes('?');
}

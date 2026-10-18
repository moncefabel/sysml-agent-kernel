import { probes, scenarios as mainSuite } from './scenarios.js';
import { injection, selfCorrection } from './suites.js';
import { runScenario } from './harness.js';
import { llmAgent, LLM_DEFAULTS } from './llm/loop.js';
import { referenceProvider } from './llm/mock.js';
import { groqRequestBody } from './llm/groq.js';

/**
 * Offline token estimate for a full LLM run, with no network call. Each scenario is driven
 * through the real agent loop by a mock model that follows the reference trajectory, so the
 * measured prompts are the exact Groq request bodies the loop would send (system prompt, tool
 * schemas, task, real kernel results). Characters are measured; tokens are derived at two ratios because no
 * tokenizer is available offline: 4 chars/token (English prose) and 3 (denser, JSON heavy).
 * The provider also adds a few tokens of chat template per message, which is not counted.
 */
const SUITES = { main: mainSuite, probes, selfcorrect: selfCorrection, injection } as const;
const suite = (process.argv[process.argv.indexOf('--suite') + 1] ?? 'main') as keyof typeof SUITES;
const scenarios = process.argv.includes('--suite') ? SUITES[suite] : mainSuite;
const pad = (v: unknown, n: number) => String(v).padStart(n);
const tok = (chars: number, ratio: number) => Math.ceil(chars / ratio);
let promptAll = 0, outAll = 0, callsAll = 0;

console.log('\nReference trajectory driven through the real agent loop (no network)\n');
console.log('scenario'.padEnd(26) + pad('calls', 6) + pad('prompt ch', 11) + pad('output ch', 11) + pad('last ctx ch', 13) + pad('tokens@4', 10) + pad('tokens@3', 10) + '  passes');
for (const s of scenarios) {
  const mock = referenceProvider(s);
  const row = await runScenario(s, llmAgent(mock));
  const prompts = mock.requests.map((r) => groqRequestBody('model', r).length);
  const p = prompts.reduce((a, b) => a + b, 0);
  const o = mock.responses.reduce((a, r) => a + JSON.stringify(r.message).length, 0);
  promptAll += p; outAll += o; callsAll += mock.requests.length;
  console.log(s.id.padEnd(26) + pad(mock.requests.length, 6) + pad(p, 11) + pad(o, 11) + pad(prompts.at(-1), 13)
    + pad(tok(p + o, 4), 10) + pad(tok(p + o, 3), 10) + '  ' + (row.success ? 'yes' : 'NO'));
}

const first = referenceProvider(scenarios[0]);
await runScenario(scenarios[0], llmAgent(first));
const fixed = groqRequestBody('model', { ...first.requests[0], messages: first.requests[0].messages.slice(0, 1) }).length;

console.log(`\nfull run, reference trajectory: ${callsAll} LLM calls, ${promptAll + outAll} chars`);
console.log(`  = ${tok(promptAll + outAll, 4)} tokens at 4 chars/token, ${tok(promptAll + outAll, 3)} at 3 chars/token`);
console.log(`fixed overhead resent on every call (system prompt + tool schemas): ${fixed} chars, ${tok(fixed, 4)} to ${tok(fixed, 3)} tokens`);
console.log(`hard ceiling enforced by the loop: ${scenarios.length} scenarios x ${LLM_DEFAULTS.scenarioTokenBudget} tokens = ${scenarios.length * LLM_DEFAULTS.scenarioTokenBudget} tokens`);
console.log('  (the budget is checked before each call with the chars/4 estimate, so one call can overshoot by that estimate\'s error)');

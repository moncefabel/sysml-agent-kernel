import type { AnyCheck, SuiteScenario } from './suites.js';

/** A satisfy relation exists whose requirement and subject resolve to these paths. */
export type SatisfiedByCheck = { type: 'satisfied_by'; requirement: string; subject: string };

/** Any scenario the harness runs: a SuiteScenario, or one using the large suite's check. */
export type EvalScenario = Omit<SuiteScenario, 'checks'> & { checks: Array<AnyCheck | SatisfiedByCheck> };

/**
 * Deterministic large model for the 'large' suite, built on the pattern of eval/bench.mjs
 * (part definitions with an attribute, two ports and a prev chain), split into areas so that
 * the root outline stays small. A fixed seed drives the attribute values and the requirement
 * allocations, so the model text is identical on every run.
 */
export const LARGE_SEED = 42;
export const AREAS = 20;
export const UNITS_PER_AREA = 80;
export const REQUIREMENTS = 40;

/** Park-Miller generator: small, deterministic, no dependency. */
function rng(seed: number) {
  let s = seed % 2147483647;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const unitName = (a: number, k: number) => `Unit_${pad(a)}_${pad(k)}`;
export const unitPath = (a: number, k: number) => `Plant::Area${pad(a)}::${unitName(a, k)}`;

export interface LargeModel { text: string; allocation: string[]; }

export function generateLargeModel(seed = LARGE_SEED): LargeModel {
  const rand = rng(seed);
  const lines = [
    'package Plant {',
    `    doc /* Synthetic plant model for agent evaluation, generated with seed ${seed}. */`,
    '    port def FluidPort {',
    '        attribute rate : Real;',
    '    }',
    '    requirement def CapacityRequirement;',
  ];
  for (let a = 0; a < AREAS; a++) {
    lines.push(`    package Area${pad(a)} {`);
    for (let k = 0; k < UNITS_PER_AREA; k++) {
      lines.push(`        part def ${unitName(a, k)} {`);
      lines.push(`            attribute m : Real = ${1 + Math.floor(rand() * 999)};`);
      lines.push('            port a : FluidPort;');
      lines.push('            port b : ~FluidPort;');
      if (k > 0) lines.push(`            part prev : ${unitName(a, k - 1)};`);
      lines.push('        }');
    }
    lines.push('    }');
  }
  const allocation: string[] = [];
  lines.push('    package Requirements {');
  for (let r = 0; r < REQUIREMENTS; r++) {
    const target = unitPath(Math.floor(rand() * AREAS), Math.floor(rand() * UNITS_PER_AREA));
    allocation.push(target);
    lines.push(`        requirement req${pad(r)} : CapacityRequirement {`);
    lines.push(`            doc /* Capacity of ${target} shall be verified. */`);
    lines.push('        }');
  }
  for (let r = 0; r < REQUIREMENTS; r++) lines.push(`        satisfy req${pad(r)} by ${allocation[r]};`);
  lines.push('    }', '}');
  return { text: lines.join('\n') + '\n', allocation };
}

const base = generateLargeModel();
const BURIED = { area: 17, unit: 63 };
const UNSATISFIED = 23;

/** Scenarios on the large model. Each task needs a targeted read; the model is too big to read whole. */
export const large: EvalScenario[] = [
  {
    id: 'large-fix-buried-type',
    category: 'repair',
    task: 'This large model has exactly one validation error. Fix it with the smallest possible edit, without removing anything.',
    model: base.text.replace(
      `part prev : ${unitName(BURIED.area, BURIED.unit - 1)};`,
      `part prev : Unti_${pad(BURIED.area)}_${pad(BURIED.unit - 1)};`,
    ),
    checks: [
      { type: 'no_errors' },
      { type: 'type_equals', path: `${unitPath(BURIED.area, BURIED.unit)}::prev`, typePath: unitPath(BURIED.area, BURIED.unit - 1) },
      { type: 'preserved', paths: [`${unitPath(BURIED.area, BURIED.unit)}::prev`, unitPath(BURIED.area, BURIED.unit - 1)] },
    ],
    scripted: [
      { tool: 'sysml_validate', args: { severity: 'error' } },
      { tool: 'sysml_apply_edits', args: { ops: [{ op: 'set', path: `${unitPath(BURIED.area, BURIED.unit)}::prev`, field: 'type', value: unitName(BURIED.area, BURIED.unit - 1) }] } },
    ],
  },
  {
    id: 'large-rename-port-def',
    category: 'refactor',
    task: 'Rename the port definition FluidPort to CoolantPort everywhere in the model.',
    model: base.text,
    checks: [
      { type: 'no_errors' },
      { type: 'exists', path: 'Plant::CoolantPort', kind: 'portDef' },
      { type: 'not_exists', path: 'Plant::FluidPort' },
      { type: 'text_excludes', pattern: 'FluidPort' },
    ],
    scripted: [
      { tool: 'sysml_outline', args: { depth: 1 } },
      { tool: 'sysml_apply_edits', args: { ops: [{ op: 'rename', path: 'Plant::FluidPort', newName: 'CoolantPort' }] } },
    ],
  },
  {
    id: 'large-unsatisfied-requirement',
    category: 'edit',
    task: 'Exactly one requirement in this model is not satisfied by any element. Find it and add the missing satisfy relation, satisfied by the part definition named in its documentation.',
    model: base.text.replace(`        satisfy req${pad(UNSATISFIED)} by ${base.allocation[UNSATISFIED]};\n`, ''),
    checks: [
      { type: 'no_errors' },
      { type: 'satisfied_by', requirement: `Plant::Requirements::req${pad(UNSATISFIED)}`, subject: base.allocation[UNSATISFIED] },
      { type: 'preserved', paths: [`Plant::Requirements::req${pad(UNSATISFIED)}`, base.allocation[UNSATISFIED]] },
    ],
    scripted: [
      { tool: 'sysml_validate', args: { severity: 'warning' } },
      { tool: 'sysml_get', args: { path: `Plant::Requirements::req${pad(UNSATISFIED)}` } },
      { tool: 'sysml_apply_edits', args: { ops: [{ op: 'add', parent: 'Plant::Requirements', source: `satisfy req${pad(UNSATISFIED)} by ${base.allocation[UNSATISFIED]};` }] } },
    ],
  },
];

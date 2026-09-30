// AST for a pragmatic subset of the SysML v2 textual notation.

export interface Span { line: number; col: number; }

export type Kind =
  | 'package' | 'import' | 'doc'
  | 'partDef' | 'part'
  | 'portDef' | 'port'
  | 'attributeDef' | 'attribute'
  | 'requirementDef' | 'requirement'
  | 'connect' | 'satisfy';

export interface Element {
  kind: Kind;
  name?: string;
  /** Type reference (qualified with ::), for usages. */
  type?: string;
  /** Specialization (:>) for definitions. */
  specializes?: string;
  conjugated?: boolean;
  multiplicity?: string;
  /** Default value expression for attributes, raw text. */
  value?: string;
  /** Free text for doc comments and import targets. */
  text?: string;
  /** Endpoints for connect (dot paths) or satisfy (requirement, subject). */
  from?: string;
  to?: string;
  children: Element[];
  span?: Span;
}

export const DEFINITION_KINDS: ReadonlySet<Kind> = new Set([
  'package', 'partDef', 'portDef', 'attributeDef', 'requirementDef',
]);

export const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'Real', 'Integer', 'Boolean', 'String', 'Natural',
  'ScalarValues::Real', 'ScalarValues::Integer', 'ScalarValues::Boolean',
  'ScalarValues::String', 'ScalarValues::Natural',
]);

export function cloneElement(e: Element): Element {
  return structuredClone(e);
}

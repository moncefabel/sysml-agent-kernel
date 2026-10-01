import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/parser.js';
import { print } from '../src/printer.js';
import { validate } from '../src/semantic.js';
import { Workspace } from '../src/workspace.js';
import { ToolHost } from '../src/tools.js';
import { contextSlice } from '../src/context.js';
import { Index } from '../src/semantic.js';

const src = readFileSync(new URL('../../examples/vehicle.sysml', import.meta.url), 'utf8');
const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'span' ? undefined : v)));

test('round trip: parse(print(ast)) equals ast', () => {
  const a = parse(src);
  assert.deepEqual(strip(parse(print(a))), strip(a));
});

test('reference model is clean', () => {
  assert.deepEqual(validate(parse(src)), []);
});

test('unresolved type gives E101 with a suggestion', () => {
  const ds = validate(parse(src.replace('part engine : Engine;', 'part engine : Engin;')));
  const d = ds.find((x) => x.code === 'E101')!;
  assert.equal(d.path, 'VehicleModel::Vehicle::engine');
  assert.match(d.hint!, /VehicleModel::Engine/);
});

test('connect rules: port type mismatch and direction', () => {
  const bad = src.replace('connect tank.fuelOut to engine.fuelIn;', 'connect tank.fuelOut to engine.powerOut;');
  assert.ok(validate(parse(bad)).some((d) => d.code === 'E105'));
  const dir = src.replace('port fuelOut : ~FuelPort;', 'port fuelOut : FuelPort;');
  assert.ok(validate(parse(dir)).some((d) => d.code === 'W201'));
});

test('inherited features resolve through specialization', () => {
  const s = src.replace('part engine : Engine;', 'part engine : ElectricMotor;');
  assert.deepEqual(validate(parse(s)), []);
});

test('transaction rejects edits that introduce errors and leaves the model untouched', () => {
  const ws = new Workspace(src);
  const before = ws.text();
  const r = ws.transact([{ op: 'remove', path: 'VehicleModel::FuelTank' }]);
  assert.equal(r.status, 'rejected');
  assert.equal(r.status === 'rejected' && r.reason, 'introduces_errors');
  assert.equal(ws.text(), before);
  assert.equal(ws.version, 0);
});

test('multi-op transaction is atomic', () => {
  const ws = new Workspace(src);
  const r = ws.transact([
    { op: 'add', parent: 'VehicleModel', source: 'part def Brake { attribute mass : Real = 12; }' },
    { op: 'add', parent: 'VehicleModel::Vehicle', source: 'part brakes : Brake[4];' },
  ]);
  assert.equal(r.status, 'committed');
  assert.deepEqual(ws.diagnostics(), []);
});

test('rename rewrites all references', () => {
  const ws = new Workspace(src);
  const r = ws.transact([{ op: 'rename', path: 'VehicleModel::Vehicle::tank', newName: 'fuelTank' }]);
  assert.equal(r.status, 'committed');
  assert.match(ws.text(), /connect fuelTank\.fuelOut to engine\.fuelIn;/);
  const r2 = ws.transact([{ op: 'rename', path: 'VehicleModel::FuelPort', newName: 'FuelInterface' }]);
  assert.equal(r2.status, 'committed');
  assert.match(ws.text(), /port fuelOut : ~FuelInterface;/);
  assert.deepEqual(ws.diagnostics(), []);
});

test('optimistic concurrency', () => {
  const ws = new Workspace(src);
  ws.transact([{ op: 'set', path: 'VehicleModel::Engine::mass', field: 'value', value: '175' }]);
  const r = ws.transact([{ op: 'set', path: 'VehicleModel::Engine::mass', field: 'value', value: '170' }], { expectedVersion: 0 });
  assert.equal(r.status === 'rejected' && r.reason, 'version_conflict');
});

test('policy: propose mode stages edits for human approval', () => {
  const host = new ToolHost(new Workspace(src), { mode: 'propose', maxRemovalsPerTx: 3, maxOpsPerTx: 20 });
  const r: any = host.call('sysml_apply_edits', { ops: [{ op: 'add', parent: 'VehicleModel', source: 'part def Seat;' }] });
  assert.equal(r.status, 'pending_approval');
  assert.equal(host.ws.version, 0);
  const done: any = host.approve(r.proposalId);
  assert.equal(done.status, 'committed');
});

test('policy: read-only and blast radius', () => {
  const ro = new ToolHost(new Workspace(src), { mode: 'read_only', maxRemovalsPerTx: 3, maxOpsPerTx: 20 });
  assert.equal((ro.call('sysml_apply_edits', { ops: [{ op: 'remove', path: 'VehicleModel::Wheel' }] }) as any).error.code, 'PERMISSION_DENIED');
  const host = new ToolHost(new Workspace(src));
  const ops = ['Wheel', 'Engine', 'FuelTank', 'Vehicle'].map((n) => ({ op: 'remove', path: `VehicleModel::${n}` }));
  assert.equal((host.call('sysml_apply_edits', { ops }) as any).error.code, 'POLICY_LIMIT');
});

test('invalid tool arguments return a structured error', () => {
  const host = new ToolHost(new Workspace(src));
  const r: any = host.call('sysml_apply_edits', { ops: [{ op: 'explode' }] });
  assert.equal(r.error.code, 'INVALID_ARGUMENTS');
});

test('context slice respects budget and pulls dependencies', () => {
  const idx = new Index(parse(src));
  const s = contextSlice(idx, 'VehicleModel::Vehicle', 100000);
  assert.ok(s.included.includes('VehicleModel::FuelTank'));
  const small = contextSlice(idx, 'VehicleModel::Vehicle', 300);
  assert.ok(small.usedChars <= 300 && small.truncated);
});

test('tool definitions export valid JSON schema', () => {
  const defs = new ToolHost(new Workspace(src)).toolDefinitions();
  assert.equal(defs.length, 6);
  assert.equal((defs.find((d) => d.name === 'sysml_apply_edits')!.input_schema as any).type, 'object');
});

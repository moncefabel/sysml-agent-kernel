import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Workspace } from '../src/workspace.js';
import { DEFAULT_POLICY, removedElementCount, ToolHost } from '../src/tools.js';

const src = readFileSync(new URL('../../examples/vehicle.sysml', import.meta.url), 'utf8');
const host = (extra = {}) => new ToolHost(new Workspace(src), { ...DEFAULT_POLICY, ...extra });
const tx = (h: ToolHost, ops: unknown[], extra = {}) => h.call('sysml_apply_edits', { ops, ...extra }) as any;

test('removed elements count the target and everything it contains', () => {
  const idx = new Workspace(src).index();
  assert.equal(removedElementCount(idx, [{ op: 'remove', path: 'VehicleModel::FuelTank' }]), 3);
  assert.equal(removedElementCount(idx, [{ op: 'remove', path: 'VehicleModel::Vehicle' }]), 5);
  assert.equal(removedElementCount(idx, [{ op: 'add', parent: 'VehicleModel', source: 'part def X;' }, { op: 'remove', path: 'Nope' }]), 0);
});

test('session limit: removed elements are summed over committed transactions', () => {
  const h = host({ maxRemovedElementsPerSession: 4 });
  assert.equal(tx(h, [{ op: 'remove', path: 'VehicleModel::Vehicle#connect[0]' }]).status, 'committed');
  assert.equal(tx(h, [{ op: 'remove', path: 'VehicleModel::Vehicle::tank' }]).status, 'committed');
  assert.equal(h.session.removedElements, 2);
  const r = tx(h, [{ op: 'remove', path: 'VehicleModel::FuelTank' }]);
  assert.equal(r.error.code, 'SESSION_LIMIT');
  assert.match(r.error.message, /3 element\(s\).*2 already removed.*limit of 4/);
  assert.equal(h.ws.version, 2);
});

test('session limit: dry runs and rejected transactions consume nothing', () => {
  const h = host({ maxRemovedElementsPerSession: 3 });
  assert.equal(tx(h, [{ op: 'remove', path: 'VehicleModel::FuelTank' }], { dryRun: true }).status, 'rejected');
  assert.equal(tx(h, [{ op: 'remove', path: 'VehicleModel::FuelTank' }]).status, 'rejected'); // introduces errors
  assert.equal(h.session.removedElements, 0);
  assert.equal(tx(h, [{ op: 'remove', path: 'VehicleModel::Vehicle#connect[0]' }, { op: 'remove', path: 'VehicleModel::Vehicle::tank' }, { op: 'remove', path: 'VehicleModel::FuelTank' }]).error.code, 'SESSION_LIMIT');
});

test('session limit on operations, and unset limits keep the previous behaviour', () => {
  const h = host({ maxOpsPerSession: 2 });
  assert.equal(tx(h, [{ op: 'add', parent: 'VehicleModel', source: 'part def A;' }, { op: 'add', parent: 'VehicleModel', source: 'part def B;' }]).status, 'committed');
  assert.equal(tx(h, [{ op: 'add', parent: 'VehicleModel', source: 'part def C;' }]).error.code, 'SESSION_LIMIT');
  const open = new ToolHost(new Workspace(src), { mode: 'write', maxRemovalsPerTx: 3, maxOpsPerTx: 20 });
  assert.equal(tx(open, [{ op: 'remove', path: 'VehicleModel::Vehicle' }, { op: 'remove', path: 'VehicleModel#satisfy[2]' }]).status, 'committed');
});

test('session limit: the destructive guarded-delete edit seen in phase 2 is now refused', () => {
  const r = tx(host(), [{ op: 'remove', path: 'VehicleModel::FuelTank' }, { op: 'remove', path: 'VehicleModel::Vehicle' }, { op: 'add', parent: 'VehicleModel', source: 'part def Vehicle { part engine : Engine; part wheels : Wheel[4]; }' }]);
  assert.equal(r.error.code, 'SESSION_LIMIT');
  // The minimal edit (5 elements) still fits the default budget.
  assert.equal(tx(host(), [{ op: 'remove', path: 'VehicleModel::Vehicle#connect[0]' }, { op: 'remove', path: 'VehicleModel::Vehicle::tank' }, { op: 'remove', path: 'VehicleModel::FuelTank' }]).status, 'committed');
});

test('session limit: an approved proposal counts against the budget', () => {
  const h = host({ mode: 'propose', maxRemovedElementsPerSession: 3 });
  const p = tx(h, [{ op: 'remove', path: 'VehicleModel::Vehicle#connect[0]' }, { op: 'remove', path: 'VehicleModel::Vehicle::tank' }]);
  assert.equal(p.status, 'pending_approval');
  assert.equal((h.approve(p.proposalId) as any).status, 'committed');
  assert.equal(h.session.removedElements, 2);
  assert.equal(tx(h, [{ op: 'remove', path: 'VehicleModel::FuelTank' }]).error.code, 'SESSION_LIMIT');
});

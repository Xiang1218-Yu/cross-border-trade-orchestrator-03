import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, confirmOrder, createCustomsDeclaration, createOrder, dispatchOrder, state, updateCustoms } from './domain.js';

let seq = 0;
function newDeclaration({ tenant = 'tenant-acme', docs = [] as string[] } = {}) {
  const order = createOrder(tenant, {
    customerId: 'CUS-001',
    reference: `CUS-T-${Date.now()}-${seq++}`,
    origin: '上海',
    destination: '汉堡',
    items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }]
  });
  confirmOrder(tenant, order.id, 'tester');
  allocateOrder(tenant, order.id, 'tester');
  const declaration = createCustomsDeclaration(tenant, { orderId: order.id }, 'tester');
  if (docs.length) updateCustoms(tenant, declaration.id, { documentRefs: docs }, 'tester');
  return { orderId: order.id, declarationId: declaration.id, tenant, requiredDocuments: declaration.requiredDocuments };
}

const sideEffectsFor = (declarationId: string) => ({
  audit: state.audit.filter(item => item.entityId === declarationId && item.action === 'customs.updated').length,
  outbox: state.outbox.filter(item => item.aggregateId === declarationId && item.topic === 'customs.updated').length
});
const stored = (declarationId: string) => state.customs.find(item => item.id === declarationId)!;

test('海关申报保留合法的提交、查验、退回、补件流程', () => {
  const t = 'tenant-acme';
  const d = newDeclaration();

  assert.equal(updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker').status, 'submitted');
  assert.equal(updateCustoms(t, d.declarationId, { status: 'inspection' }, 'broker').status, 'inspection');
  // 查验后海关退回，必须给出退回原因
  assert.throws(() => updateCustoms(t, d.declarationId, { status: 'rejected' }, 'broker'), /退回原因/);
  const rejected = updateCustoms(t, d.declarationId, { status: 'rejected', rejectionReason: '缺少原产地证' }, 'broker');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectionReason, '缺少原产地证');
  // 退回期间补充单证（不得覆盖退回原因），随后补件重报
  updateCustoms(t, d.declarationId, { documentRefs: d.requiredDocuments }, 'broker');
  assert.equal(stored(d.declarationId).rejectionReason, '缺少原产地证');
  const resubmitted = updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker');
  assert.equal(resubmitted.status, 'submitted');
  assert.equal(resubmitted.rejectionReason, undefined);
  // 重新提交后可直接放行（无需再次查验）
  assert.equal(updateCustoms(t, d.declarationId, { status: 'cleared' }, 'broker').status, 'cleared');
});

test('非法迁移（draft→rejected、inspection→submitted 等）被拒绝', () => {
  const t = 'tenant-acme';
  const d = newDeclaration();
  assert.throws(() => updateCustoms(t, d.declarationId, { status: 'rejected', rejectionReason: 'x' }, 'broker'), /不能从 draft/);
  updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker');
  updateCustoms(t, d.declarationId, { status: 'inspection' }, 'broker');
  assert.throws(() => updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker'), /不能从 inspection/);
  assert.throws(() => updateCustoms(t, d.declarationId, { status: 'draft' }, 'broker'), /不能从 inspection/);
  assert.equal(stored(d.declarationId).status, 'inspection');
});

test('已放行记录不可逆：不能改回 draft / rejected，也不能改单证', () => {
  const t = 'tenant-acme';
  const d = newDeclaration({ docs: ['commercial-invoice', 'packing-list', 'origin-certificate'] });
  updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker');
  updateCustoms(t, d.declarationId, { status: 'cleared' }, 'broker');
  const before = sideEffectsFor(d.declarationId);

  assert.throws(() => updateCustoms(t, d.declarationId, { status: 'draft' }, 'broker'), /已放行/);
  assert.throws(() => updateCustoms(t, d.declarationId, { status: 'rejected', rejectionReason: '事后退回' }, 'broker'), /已放行/);
  assert.throws(() => updateCustoms(t, d.declarationId, { status: 'inspection' }, 'broker'), /已放行/);
  assert.throws(() => updateCustoms(t, d.declarationId, { documentRefs: [] }, 'broker'), /已放行/);

  const record = stored(d.declarationId);
  assert.equal(record.status, 'cleared');
  assert.deepEqual(record.documentRefs, d.requiredDocuments);
  // 拒绝的更新不产生 audit / outbox
  assert.deepEqual(sideEffectsFor(d.declarationId), before);
});

test('缺件放行被拒绝，不留下半完成的 documentRefs、audit 或 outbox', () => {
  const t = 'tenant-acme';
  const d = newDeclaration();
  updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker');
  const before = sideEffectsFor(d.declarationId);

  assert.throws(
    () => updateCustoms(t, d.declarationId, { status: 'cleared', documentRefs: ['commercial-invoice', 'packing-list'] }, 'broker'),
    /放行前必须补齐所有必需单证/
  );

  const record = stored(d.declarationId);
  assert.equal(record.status, 'submitted');
  assert.deepEqual(record.documentRefs, []);
  assert.deepEqual(sideEffectsFor(d.declarationId), before);
});

test('运输已创建后申报整体锁定，重复的终态更新保持幂等', () => {
  const t = 'tenant-acme';
  const d = newDeclaration({ docs: ['commercial-invoice', 'packing-list', 'origin-certificate'] });
  updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker');
  updateCustoms(t, d.declarationId, { status: 'cleared' }, 'broker');
  dispatchOrder(t, d.orderId, 'tester');
  const before = sideEffectsFor(d.declarationId);

  assert.throws(() => updateCustoms(t, d.declarationId, { status: 'rejected', rejectionReason: '出运后退回' }, 'broker'), /已出运/);
  assert.throws(() => updateCustoms(t, d.declarationId, { documentRefs: ['extra-doc'] }, 'broker'), /已出运/);
  assert.equal(stored(d.declarationId).status, 'cleared');
  assert.deepEqual(sideEffectsFor(d.declarationId), before);

  // 重复提交 cleared 是幂等 no-op，不新增 audit / outbox
  const again = updateCustoms(t, d.declarationId, { status: 'cleared' }, 'broker');
  assert.equal(again.status, 'cleared');
  assert.deepEqual(sideEffectsFor(d.declarationId), before);
});

test('重复更新幂等：不产生重复的 audit 与 outbox', () => {
  const t = 'tenant-acme';
  const d = newDeclaration();
  updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker');
  const before = sideEffectsFor(d.declarationId);

  const repeat = updateCustoms(t, d.declarationId, { status: 'submitted' }, 'broker');
  assert.equal(repeat.status, 'submitted');
  assert.deepEqual(sideEffectsFor(d.declarationId), before);

  // 相同单证集合同样视为无变化（重复提交含去重后的同一集合）
  updateCustoms(t, d.declarationId, { documentRefs: ['a', 'a', 'b'] }, 'broker');
  const afterDocs = sideEffectsFor(d.declarationId);
  updateCustoms(t, d.declarationId, { documentRefs: ['a', 'b'] }, 'broker');
  assert.deepEqual(sideEffectsFor(d.declarationId), afterDocs);
});

test('跨租户访问申报被拒绝且无任何副作用', () => {
  const d = newDeclaration();
  updateCustoms('tenant-acme', d.declarationId, { status: 'submitted' }, 'broker');
  const before = sideEffectsFor(d.declarationId);

  assert.throws(
    () => updateCustoms('tenant-rogue', d.declarationId, { status: 'cleared' }, 'attacker'),
    /无权访问其他租户的数据/
  );
  assert.equal(stored(d.declarationId).status, 'submitted');
  assert.deepEqual(sideEffectsFor(d.declarationId), before);
});

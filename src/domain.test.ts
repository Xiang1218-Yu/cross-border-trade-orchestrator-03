import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, dispatchOrder, generateInvoice, operationSummary, recordPayment, state, updateCustoms } from './domain.js';

test('order lifecycle preserves credit, inventory, customs, shipment and invoice invariants', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `TEST-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  assert.equal(order.status, 'draft');
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  const dispatched = dispatchOrder('tenant-acme', order.id, 'tester');
  assert.equal(dispatched.status, 'dispatched');
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  assert.ok(invoice.total > invoice.subtotal);
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${Date.now()}` }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.status, 'paid');
});

test('credit overage creates approval and approval increases only the required limit', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: `CREDIT-${Date.now()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  const approval = state.approvals.find(item => item.orderId === order.id && item.type === 'credit_override');
  assert.ok(approval);
  decideApproval('tenant-acme', approval!.id, { status: 'approved', comment: '额度复核通过' }, 'finance');
  assert.doesNotThrow(() => confirmOrder('tenant-acme', order.id, 'finance'));
});

test('operation summary exposes receivable and reservation metrics', () => {
  const summary = operationSummary('tenant-acme');
  assert.ok(summary.orderCount >= 1);
  assert.ok(summary.receivable >= 0);
  assert.ok(summary.inventory.every(item => item.available >= item.reserved));
});

test('customs status machine keeps legal flows and makes cleared irreversible', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `CUS-SM-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  assert.throws(() => updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester'), /不能从 draft 变更为 cleared/);
  assert.throws(() => updateCustoms('tenant-acme', declaration.id, { status: 'inspection' }, 'tester'), /不能从 draft 变更为 inspection/);
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'inspection' }, 'tester');
  assert.throws(() => updateCustoms('tenant-acme', declaration.id, { status: 'rejected' }, 'tester'), /退回原因/);
  const rejected = updateCustoms('tenant-acme', declaration.id, { status: 'rejected', rejectionReason: '原产地证书信息不符' }, 'tester');
  assert.equal(rejected.rejectionReason, '原产地证书信息不符');
  assert.throws(() => updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester'), /不能从 rejected 变更为 cleared/);
  const resubmitted = updateCustoms('tenant-acme', declaration.id, { status: 'submitted' }, 'tester');
  assert.equal(resubmitted.status, 'submitted');
  assert.equal(resubmitted.rejectionReason, undefined);
  const cleared = updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  assert.equal(cleared.status, 'cleared');
  for (const attempt of [
    () => updateCustoms('tenant-acme', declaration.id, { status: 'draft' }, 'tester'),
    () => updateCustoms('tenant-acme', declaration.id, { status: 'rejected', rejectionReason: '事后退回' }, 'tester'),
    () => updateCustoms('tenant-acme', declaration.id, { status: 'submitted' }, 'tester'),
    () => updateCustoms('tenant-acme', declaration.id, { documentRefs: ['swapped-doc'] }, 'tester')
  ]) assert.throws(attempt, /已放行/);
  const persisted = state.customs.find(item => item.id === declaration.id)!;
  assert.equal(persisted.status, 'cleared');
  assert.deepEqual(persisted.documentRefs, declaration.requiredDocuments);
});

test('rejected clearance with missing documents leaves no partial documents, audit or outbox', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `CUS-ATOMIC-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { status: 'submitted' }, 'tester');
  const auditBefore = state.audit.length;
  const outboxBefore = state.outbox.length;
  assert.throws(() => updateCustoms('tenant-acme', declaration.id, { documentRefs: ['commercial-invoice'], status: 'cleared' }, 'tester'), /补齐所有必需单证/);
  const persisted = state.customs.find(item => item.id === declaration.id)!;
  assert.equal(persisted.status, 'submitted');
  assert.deepEqual(persisted.documentRefs, []);
  assert.equal(state.audit.length, auditBefore);
  assert.equal(state.outbox.length, outboxBefore);
});

test('repeated identical customs updates are idempotent and emit no duplicate audit or outbox', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `CUS-IDEM-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  const auditBefore = state.audit.length;
  const outboxBefore = state.outbox.length;
  const retryClear = updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  assert.equal(retryClear.status, 'cleared');
  const retryDocs = updateCustoms('tenant-acme', declaration.id, { documentRefs: [...declaration.requiredDocuments] }, 'tester');
  assert.deepEqual(retryDocs.documentRefs, declaration.requiredDocuments);
  assert.equal(state.audit.length, auditBefore);
  assert.equal(state.outbox.length, outboxBefore);
});

test('customs record is locked once a shipment exists for the order', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `CUS-SHIP-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  dispatchOrder('tenant-acme', order.id, 'tester');
  assert.ok(state.shipments.some(item => item.orderId === order.id));
  const auditBefore = state.audit.length;
  const outboxBefore = state.outbox.length;
  assert.throws(() => updateCustoms('tenant-acme', declaration.id, { status: 'rejected', rejectionReason: '航线变更' }, 'tester'), /已出运/);
  assert.throws(() => updateCustoms('tenant-acme', declaration.id, { status: 'draft' }, 'tester'), /已出运/);
  assert.throws(() => updateCustoms('tenant-acme', declaration.id, { documentRefs: ['swapped-doc'] }, 'tester'), /已出运/);
  const persisted = state.customs.find(item => item.id === declaration.id)!;
  assert.equal(persisted.status, 'cleared');
  assert.deepEqual(persisted.documentRefs, declaration.requiredDocuments);
  assert.equal(state.audit.length, auditBefore);
  assert.equal(state.outbox.length, outboxBefore);
});

test('customs updates reject cross-tenant access and unknown declarations without side effects', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `CUS-XT-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  const auditBefore = state.audit.length;
  const outboxBefore = state.outbox.length;
  assert.throws(() => updateCustoms('tenant-other', declaration.id, { documentRefs: ['forged-doc'], status: 'cleared' }, 'attacker'), /无权访问其他租户/);
  assert.throws(() => updateCustoms('tenant-acme', 'CUS-MISSING', { status: 'submitted' }, 'tester'), /海关申报不存在/);
  const persisted = state.customs.find(item => item.id === declaration.id)!;
  assert.equal(persisted.status, 'draft');
  assert.deepEqual(persisted.documentRefs, []);
  assert.equal(state.audit.length, auditBefore);
  assert.equal(state.outbox.length, outboxBefore);
});

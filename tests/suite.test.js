const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT_DIR = path.resolve(__dirname, '..');
const BPMN_DIR = path.join(ROOT_DIR, 'Backend', 'bpmn-models');
const FORMS_DIR = path.join(BPMN_DIR, 'forms');
const DOCS_DIR = path.join(ROOT_DIR, 'Backend', 'docs');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');

test('1. BPMN Models Integrity & Schema Verification', (t) => {
  const mainBpmn = path.join(BPMN_DIR, 'cold-chain-replenishment-main.bpmn');
  const matchBpmn = path.join(BPMN_DIR, 'supplier-invoice-three-way-match.bpmn');

  assert.ok(fs.existsSync(mainBpmn), 'cold-chain-replenishment-main.bpmn must exist');
  assert.ok(fs.existsSync(matchBpmn), 'supplier-invoice-three-way-match.bpmn must exist');

  const mainXml = fs.readFileSync(mainBpmn, 'utf-8');
  assert.ok(mainXml.includes('bpmn:process'), 'Main BPMN must define a process');
  assert.ok(mainXml.includes('id="coldChainReplenishment"'), 'Process ID must be coldChainReplenishment');
  assert.ok(mainXml.includes('isExecutable="true"'), 'Process must be executable');
  assert.ok(mainXml.includes('TempExcursionDetected'), 'Event subprocess must catch TempExcursionDetected');
  assert.ok(mainXml.includes('SHIPMENT_REJECTED'), 'Must handle SHIPMENT_REJECTED error');

  const matchXml = fs.readFileSync(matchBpmn, 'utf-8');
  assert.ok(matchXml.includes('id="supplierInvoiceThreeWayMatch"'), 'Call activity must match supplierInvoiceThreeWayMatch');
});

test('2. Camunda Forms Schema (v16) Verification', (t) => {
  const expectedForms = [
    'ap-clerk-manual-review.form',
    'confirm-goods-receipt.form',
    'qa-decision.form',
    'qa-inspection.form',
    'review-replenishment-request.form'
  ];

  expectedForms.forEach(formName => {
    const filePath = path.join(FORMS_DIR, formName);
    assert.ok(fs.existsSync(filePath), `Form ${formName} must exist`);

    const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(json.schemaVersion, 16, `Form ${formName} must use schemaVersion 16`);
    assert.ok(json.components && Array.isArray(json.components), `Form ${formName} must contain components array`);
    assert.ok(json.components.length > 0, `Form ${formName} must have at least one component`);
  });
});

test('3. Mock Telemetry & Start Payload Contracts', (t) => {
  const startPayloadPath = path.join(DOCS_DIR, 'start-payload.json');
  const startPayload = JSON.parse(fs.readFileSync(startPayloadPath, 'utf-8'));
  assert.equal(startPayload.requestId, 'REQ-1001');
  assert.equal(startPayload.storeId, 'STORE-12');
  assert.equal(startPayload.maxTransitTempC, 8);
  assert.equal(startPayload.budgetCap, 5000);
  assert.ok(Array.isArray(startPayload.items), 'Payload must have items');
  assert.ok(Array.isArray(startPayload.suppliers), 'Payload must have suppliers list');

  const iotMockPath = path.join(DOCS_DIR, 'mocks', 'iot-telemetry-mock.json');
  const iotMock = JSON.parse(fs.readFileSync(iotMockPath, 'utf-8'));
  assert.ok(iotMock.endpoints && iotMock.endpoints.length >= 3, 'Must define at least 3 telemetry scenarios');

  const supplierMockPath = path.join(DOCS_DIR, 'mocks', 'supplier-api-mock.json');
  const supplierMock = JSON.parse(fs.readFileSync(supplierMockPath, 'utf-8'));
  assert.ok(supplierMock.endpoints && supplierMock.endpoints.length >= 1, 'Must define supplier PO response');
});

test('4. Frontend Pages, Buttons & Component Auditing', (t) => {
  const indexHtml = path.join(FRONTEND_DIR, 'index.html');
  const qaHtml = path.join(FRONTEND_DIR, 'qa-triage.html');

  assert.ok(fs.existsSync(indexHtml), 'index.html must exist');
  assert.ok(fs.existsSync(qaHtml), 'qa-triage.html must exist');

  const indexContent = fs.readFileSync(indexHtml, 'utf-8');
  const requiredIndexIds = [
    'simulateIncidentBtn',
    'btnNotifications',
    'btnTuneSettings',
    'btnNewReplenishment',
    'triggerSpikeBtn',
    'btnOpenTelemetryLog',
    'btnApproveBatch',
    'btnRejectModify',
    'btnReviewTempSpike',
    'btnReviewDiscrepancy',
    'btnFilterAll',
    'btnFilterTransit',
    'btnFilterQA',
    'btnFilterSettlement',
    'modalNewReplenishment',
    'modalTelemetryLog',
    'modalRFQ',
    'modalDiscrepancy',
    'toastContainer'
  ];

  requiredIndexIds.forEach(id => {
    assert.ok(indexContent.includes(`id="${id}"`), `index.html must include element with id="${id}"`);
  });

  const qaContent = fs.readFileSync(qaHtml, 'utf-8');
  const requiredQaIds = [
    'btnRefreshTelemetry',
    'btnExportAudit',
    'btnQuarantineShipment',
    'btnSubmitDecision',
    'modalQuarantine',
    'modalDecisionSubmitted',
    'toastContainerQA'
  ];

  requiredQaIds.forEach(id => {
    assert.ok(qaContent.includes(`id="${id}"`), `qa-triage.html must include element with id="${id}"`);
  });
});

test('5. Local Server & REST API Endpoints Verification', async (t) => {
  const server = require('../server.js');
  const testPort = 3899;

  await new Promise(resolve => server.listen(testPort, resolve));

  const fetchJson = (urlPath) => new Promise((resolve, reject) => {
    http.get(`http://localhost:${testPort}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }).on('error', reject);
  });

  try {
    const health = await fetchJson('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'HEALTHY');

    const telemetry = await fetchJson('/api/v1/telemetry/PO-REQ-1001-SUP-A');
    assert.equal(telemetry.status, 200);
    assert.equal(telemetry.body.poNumber, 'PO-REQ-1001-SUP-A');

    const excursion = await fetchJson('/api/v1/telemetry/excursions');
    assert.equal(excursion.status, 200);
    assert.equal(excursion.body.criticalThresholdC, 8.0);
  } finally {
    server.close();
  }
});

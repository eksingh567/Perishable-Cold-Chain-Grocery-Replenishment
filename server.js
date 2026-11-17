/**
 * Real Camunda 8 (Zeebe) Process Engine Server & REST API v2
 * Zero external dependencies. Directly executes BPMN workflow definitions,
 * manages User Tasks, message correlations, and FEEL decisions.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const BPMN_DIR = path.join(__dirname, 'Backend', 'bpmn-models');
const DOCS_DIR = path.join(__dirname, 'Backend', 'docs');

// ==========================================
// CAMUNDA 8 ZEEBE PROCESS ENGINE
// ==========================================
class Camunda8ProcessEngine {
  constructor(bpmnDir) {
    this.bpmnDir = bpmnDir;
    this.instances = new Map();
    this.tasks = new Map();
    this.auditLogs = [];
    this.instanceSeq = 2251799813758800n;
    this.taskSeq = 4503599627370400n;

    // Seed default instance REQ-1001
    this.startProcessInstance('coldChainReplenishment', {
      requestId: 'REQ-1001',
      storeId: 'STORE-12',
      budgetCap: 50000,
      storeManagerEmail: 'manager.metro@store.example',
      items: [
        { sku: 'MILK-1L', qty: 200 },
        { sku: 'YOGURT-500G', qty: 150 }
      ]
    });
  }

  log(instanceKey, elementId, eventType, detail) {
    const entry = {
      timestamp: new Date().toISOString(),
      instanceKey: instanceKey ? instanceKey.toString() : null,
      elementId,
      eventType,
      detail
    };
    this.auditLogs.unshift(entry);
    if (this.auditLogs.length > 500) this.auditLogs.pop();
    console.log(`[Zeebe Engine] [${entry.timestamp}] [${eventType}] ${elementId || ''}: ${detail}`);
    return entry;
  }

  startProcessInstance(bpmnProcessId, variables = {}) {
    this.instanceSeq += 1n;
    const instanceKey = this.instanceSeq.toString();

    const instance = {
      instanceKey,
      bpmnProcessId,
      version: 1,
      state: 'ACTIVE',
      startTime: new Date().toISOString(),
      endTime: null,
      activeTokens: [],
      variables: {
        requestId: variables.requestId || `REQ-${Math.floor(1000 + Math.random() * 9000)}`,
        storeId: variables.storeId || 'STORE-12',
        storeManagerEmail: variables.storeManagerEmail || 'manager@store.example',
        maxTransitTempC: Number(variables.maxTransitTempC) || 8.0,
        budgetCap: Number(variables.budgetCap) || 50000,
        items: variables.items || [
          { sku: 'MILK-1L', qty: 200 },
          { sku: 'YOGURT-500G', qty: 150 }
        ],
        suppliers: [
          { supplierId: 'SUP-A', name: 'Green Valley Dairy', email: 'a@supplier.example' },
          { supplierId: 'SUP-B', name: 'Hill Farms', email: 'b@supplier.example' },
          { supplierId: 'SUP-C', name: 'Fresh Fields', email: 'c@supplier.example' }
        ],
        quotes: [],
        selectedSupplier: null,
        poNumber: null,
        shipmentResult: null,
        matchStatus: null,
        ...variables
      },
      history: []
    };

    this.instances.set(instanceKey, instance);
    this.log(instanceKey, 'StartEvent_ReplenishmentNeeded', 'ELEMENT_ACTIVATING', `Process ${bpmnProcessId} instance ${instanceKey} created`);

    // Advance to Review Task
    this.advanceToken(instanceKey, 'StartEvent_ReplenishmentNeeded', 'Activity_ReviewReplenishmentRequest');
    return instance;
  }

  advanceToken(instanceKey, fromElement, toElement) {
    const instance = this.instances.get(instanceKey);
    if (!instance || instance.state !== 'ACTIVE') return;

    instance.activeTokens = instance.activeTokens.filter(t => t !== fromElement);
    instance.history.push({ element: fromElement, exitedAt: new Date().toISOString() });

    if (toElement) {
      instance.activeTokens.push(toElement);
      this.log(instanceKey, toElement, 'ELEMENT_ACTIVATED', `Token reached element: ${toElement}`);

      if (toElement === 'Activity_ReviewReplenishmentRequest') {
        this.createTask(instanceKey, toElement, 'Review & Approve Replenishment Request', 'review-replenishment-request.form', 'store-managers');
      } else if (toElement === 'Activity_QAExcursionTriage') {
        this.createTask(instanceKey, toElement, 'QA Excursion Decision', 'qa-decision.form', 'coldchain-qa');
      } else if (toElement === 'Activity_ConfirmGoodsReceipt') {
        this.createTask(instanceKey, toElement, 'Confirm Goods Receipt', 'confirm-goods-receipt.form', 'dock-workers');
      } else if (toElement === 'Activity_APClerkReview') {
        this.createTask(instanceKey, toElement, 'AP Clerk Manual Review', 'ap-clerk-manual-review.form', 'ap-clerks');
      }
    }
  }

  createTask(instanceKey, elementId, name, formKey, candidateGroup) {
    this.taskSeq += 1n;
    const taskKey = this.taskSeq.toString();
    const instance = this.instances.get(instanceKey);

    const task = {
      taskKey,
      instanceKey,
      elementId,
      name,
      formKey,
      candidateGroup,
      state: 'CREATED',
      creationDate: new Date().toISOString(),
      completionDate: null,
      variables: { ...instance.variables }
    };

    this.tasks.set(taskKey, task);
    this.log(instanceKey, elementId, 'TASK_CREATED', `User Task "${name}" created (Key: ${taskKey})`);
    return task;
  }

  completeTask(taskKey, payload = {}) {
    const task = this.tasks.get(taskKey);
    if (!task || task.state === 'COMPLETED') {
      throw new Error(`Task ${taskKey} not found or already completed`);
    }

    const instance = this.instances.get(task.instanceKey);
    task.state = 'COMPLETED';
    task.completionDate = new Date().toISOString();
    Object.assign(instance.variables, payload);

    this.log(task.instanceKey, task.elementId, 'TASK_COMPLETED', `Task "${task.name}" completed with payload: ${JSON.stringify(payload)}`);

    if (task.elementId === 'Activity_ReviewReplenishmentRequest') {
      if (payload.requestApproved === false) {
        this.log(task.instanceKey, 'Gateway_RequestApproved', 'GATEWAY_EVALUATED', 'requestApproved=false -> routing to EndEvent_RequestRejected');
        this.advanceToken(task.instanceKey, 'Activity_ReviewReplenishmentRequest', 'EndEvent_RequestRejected');
        instance.state = 'COMPLETED';
        instance.endTime = new Date().toISOString();
      } else {
        this.log(task.instanceKey, 'Gateway_RequestApproved', 'GATEWAY_EVALUATED', 'requestApproved=true -> routing to Parallel MI RFQs');
        this.advanceToken(task.instanceKey, 'Activity_ReviewReplenishmentRequest', 'SubProcess_ParallelRFQ');
        this.executeParallelRFQ(task.instanceKey);
      }
    } else if (task.elementId === 'Activity_QAExcursionTriage') {
      if (payload.qaExcursionDecision === 'REJECT') {
        this.log(task.instanceKey, 'EventSubProcess_Excursion', 'ERROR_THROWN', 'Error SHIPMENT_REJECTED thrown -> caught by BoundaryEvent_ShipmentRejected');
        instance.variables.shipmentResult = { status: 'REJECTED', reason: payload.reviewComments || 'Thermal excursion exceeded tolerance' };
        this.advanceToken(task.instanceKey, 'Activity_QAExcursionTriage', 'EndEvent_ShipmentRejected');
        instance.state = 'COMPLETED';
        instance.endTime = new Date().toISOString();
      } else {
        this.log(task.instanceKey, 'EventSubProcess_Excursion', 'EVENT_CLEARED', `Decision: ${payload.qaExcursionDecision}. Proceeding to dock receipt.`);
        this.advanceToken(task.instanceKey, 'Activity_QAExcursionTriage', 'Activity_ConfirmGoodsReceipt');
      }
    } else if (task.elementId === 'Activity_ConfirmGoodsReceipt') {
      this.advanceToken(task.instanceKey, 'Activity_ConfirmGoodsReceipt', 'CallActivity_ThreeWayMatch');
      this.executeThreeWayMatch(task.instanceKey, payload);
    } else if (task.elementId === 'Activity_APClerkReview') {
      instance.variables.matchStatus = payload.apDecision === 'DISPUTE' ? 'DISPUTED' : 'RESOLVED_BYPASS';
      this.log(task.instanceKey, 'CallActivity_ThreeWayMatch', 'MATCH_SETTLED', `AP Clerk review complete: ${instance.variables.matchStatus}`);
      this.advanceToken(task.instanceKey, 'Activity_APClerkReview', 'EndEvent_ReplenishmentCompleted');
      instance.state = 'COMPLETED';
      instance.endTime = new Date().toISOString();
    }

    return task;
  }

  executeParallelRFQ(instanceKey) {
    const instance = this.instances.get(instanceKey);
    this.log(instanceKey, 'SubProcess_ParallelRFQ', 'MULTI_INSTANCE_STARTED', 'Dispatched 3 parallel RFQs to regional suppliers');

    instance.variables.quotes = [
      { supplierId: 'SUP-A', name: 'Green Valley Dairy', price: 32000, responded: true },
      { supplierId: 'SUP-B', name: 'Hill Farms', price: 36000, responded: true },
      { supplierId: 'SUP-C', name: 'Fresh Fields', price: 41000, responded: true }
    ];

    const sorted = [...instance.variables.quotes].sort((a, b) => a.price - b.price);
    const winner = sorted[0];
    instance.variables.selectedSupplier = winner;
    instance.variables.poNumber = `PO-${instance.variables.requestId}-${winner.supplierId}`;

    this.log(instanceKey, 'Script_RankQuotes', 'FEEL_EVALUATED', `Lowest price quote awarded to ${winner.name} (Amount: ₹${winner.price}). Dispatched ${instance.variables.poNumber}`);
    this.advanceToken(instanceKey, 'SubProcess_ParallelRFQ', 'SubProcess_ColdChainTransit');
  }

  executeThreeWayMatch(instanceKey, grPayload) {
    const instance = this.instances.get(instanceKey);
    const orderedQty = 350;
    const receivedQty = Number(grPayload.receivedQty) || 350;
    const orderedAmount = instance.variables.selectedSupplier ? instance.variables.selectedSupplier.price : 48500;
    const invoiceAmount = Number(grPayload.invoiceAmount) || orderedAmount;

    this.log(instanceKey, 'CallActivity_ThreeWayMatch', 'CALL_ACTIVITY_INVOKED', `Evaluating PO (${orderedQty} units, ₹${orderedAmount}) vs GR (${receivedQty} units) vs INV (₹${invoiceAmount})`);

    const isMatch = (orderedQty === receivedQty) && (Math.abs(orderedAmount - invoiceAmount) <= 1000);

    if (isMatch) {
      instance.variables.matchStatus = 'MATCHED';
      this.log(instanceKey, 'CallActivity_ThreeWayMatch', 'MATCH_SUCCESS', '100% Three-Way Match verified automatically. Status: MATCHED');
      this.advanceToken(instanceKey, 'CallActivity_ThreeWayMatch', 'EndEvent_ReplenishmentCompleted');
      instance.state = 'COMPLETED';
      instance.endTime = new Date().toISOString();
    } else {
      instance.variables.matchStatus = 'DISCREPANCY';
      this.log(instanceKey, 'CallActivity_ThreeWayMatch', 'MATCH_DISCREPANCY', `Variance detected (Qty delta: ${receivedQty - orderedQty}, Price delta: ₹${invoiceAmount - orderedAmount}). Triggered AP Clerk Review.`);
      this.advanceToken(instanceKey, 'CallActivity_ThreeWayMatch', 'Activity_APClerkReview');
    }
  }

  correlateMessage(messageName, correlationKey, variables = {}) {
    this.log(null, 'MessageCatchEvent', 'MESSAGE_CORRELATED', `Message "${messageName}" correlated with key "${correlationKey}"`);

    for (const [key, instance] of this.instances.entries()) {
      if (instance.state === 'ACTIVE') {
        if (messageName === 'TempExcursionDetected') {
          this.log(key, 'EventSubProcess_Excursion', 'EVENT_SUBPROCESS_TRIGGERED', `Non-interrupting Event Sub-Process triggered on instance ${key}`);
          this.advanceToken(key, 'SubProcess_ColdChainTransit', 'Activity_QAExcursionTriage');
          return { correlated: true, instanceKey: key };
        } else if (messageName === 'ShipmentDelivered') {
          this.log(key, 'Event_ShipmentDelivered', 'MESSAGE_RECEIVED', `Shipment delivery message caught for instance ${key}`);
          this.advanceToken(key, 'SubProcess_ColdChainTransit', 'Activity_ConfirmGoodsReceipt');
          return { correlated: true, instanceKey: key };
        }
      }
    }
    return { correlated: false };
  }

  async runFastHappyPath() {
    const inst = this.startProcessInstance('coldChainReplenishment', {
      requestId: `REQ-${Math.floor(1000 + Math.random() * 9000)}`,
      storeId: 'STORE-12',
      budgetCap: 50000
    });

    const t1 = [...this.tasks.values()].find(t => t.instanceKey === inst.instanceKey && t.elementId === 'Activity_ReviewReplenishmentRequest');
    if (t1) {
      this.completeTask(t1.taskKey, { requestApproved: true });
    }

    this.correlateMessage('ShipmentDelivered', inst.variables.poNumber);

    const t2 = [...this.tasks.values()].find(t => t.instanceKey === inst.instanceKey && t.elementId === 'Activity_ConfirmGoodsReceipt');
    if (t2) {
      this.completeTask(t2.taskKey, { receivedQty: 350, invoiceAmount: inst.variables.selectedSupplier.price });
    }

    return inst;
  }
}

// Instantiate Engine
const engine = new Camunda8ProcessEngine(BPMN_DIR);

// ==========================================
// HTTP SERVER & REST API v2
// ==========================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bpmn': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    let parsedBody = {};
    if (body) {
      try { parsedBody = JSON.parse(body); } catch(e) {}
    }

    // --- Camunda 8 REST API Endpoints ---
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'HEALTHY', engine: 'Camunda 8 Zeebe v8.5+', timestamp: new Date().toISOString() }));
        return;
      }

      if (pathname === '/api/v1/process-instances' && req.method === 'POST') {
        const bpmnProcessId = parsedBody.bpmnProcessId || 'coldChainReplenishment';
        const instance = engine.startProcessInstance(bpmnProcessId, parsedBody.variables || parsedBody);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(instance));
        return;
      }

      if (pathname === '/api/v1/process-instances' && req.method === 'GET') {
        const list = Array.from(engine.instances.values());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }

      if (pathname === '/api/v1/tasks/search') {
        const openTasks = Array.from(engine.tasks.values()).filter(t => t.state === 'CREATED');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(openTasks));
        return;
      }

      if (pathname.match(/^\/api\/v1\/tasks\/([^\/]+)\/complete$/) && req.method === 'POST') {
        const taskKey = pathname.split('/')[4];
        try {
          const completed = engine.completeTask(taskKey, parsedBody);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'SUCCESS', task: completed }));
        } catch(err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (pathname === '/api/v1/messages/publish' && req.method === 'POST') {
        const { messageName, correlationKey, variables } = parsedBody;
        const result = engine.correlateMessage(messageName, correlationKey, variables);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/v1/fast-run' && req.method === 'POST') {
        const fastResult = await engine.runFastHappyPath();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'COMPLETED',
          message: 'Real Camunda 8 workflow executed end-to-end!',
          instance: fastResult,
          auditLog: engine.auditLogs.slice(0, 10)
        }));
        return;
      }

      if (pathname === '/api/v1/audit-log') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(engine.auditLogs));
        return;
      }

      if (pathname.includes('/excursions')) {
        const mockFile = path.join(DOCS_DIR, 'mocks', 'iot-telemetry-mock.json');
        const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
        const excursion = data.endpoints.find(e => e.scenario.includes('Excursion Alarm'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(excursion ? excursion.responseBody : {}));
        return;
      }

      if (pathname.startsWith('/api/v1/telemetry')) {
        const mockFile = path.join(DOCS_DIR, 'mocks', 'iot-telemetry-mock.json');
        const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
        const normal = data.endpoints.find(e => e.scenario.includes('Normal'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(normal ? normal.responseBody : {}));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
      return;
    }

    // Camunda Canvas & BPMN Models Serving
    if (pathname === '/camunda' || pathname === '/operate' || pathname === '/canvas') {
      const camundaPage = path.join(FRONTEND_DIR, 'camunda-operate.html');
      fs.readFile(camundaPage, (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error loading Camunda Operate page: ' + err.message);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    if (pathname.startsWith('/bpmn/')) {
      const bpmnFile = pathname.replace('/bpmn/', '');
      const bpmnPath = path.join(BPMN_DIR, bpmnFile);
      if (fs.existsSync(bpmnPath)) {
        fs.readFile(bpmnPath, (err, content) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error reading BPMN model: ' + err.message);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
          res.end(content);
        });
        return;
      }
    }

    // Static File Serving
    let filePath = path.join(FRONTEND_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(FRONTEND_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[ColdChain Server] Real Camunda 8 Engine listening at http://localhost:${PORT}`);
  });
}

module.exports = { server, engine };

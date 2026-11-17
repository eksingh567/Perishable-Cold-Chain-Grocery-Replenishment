/**
 * Cold-Chain Replenishment — Camunda 8 Orchestration Console
 * Runs on port 8086 with a full web dashboard showing:
 *   • Process Instances (Operate view)
 *   • Tasklist Human Tasks
 *   • Operate Incidents & Recovery
 *   • Live Zeebe Audit Log
 *   • 8 pre-built cold-chain scenarios auto-triggered on startup
 */
const http = require('http');
const url  = require('url');

const PORT = 8086;

const state = {
  instances: [],
  tasks:     [],
  incidents: [],
  logs:      []
};

function addLog(src, msg) {
  const e = `[${new Date().toISOString().substring(11,19)}] [${src}] ${msg}`;
  state.logs.unshift(e);
  if (state.logs.length > 150) state.logs.pop();
  console.log(e);
}

// ── FEEL / DMN Engines ──────────────────────────────────────────
function feelRankQuotes(quotes) {
  const sorted = [...quotes].sort((a,b) => a.price - b.price);
  return sorted[0];
}

function dmnThreeWayMatch(poAmount, grAmount, invoiceAmount, qtyOrdered, qtyReceived) {
  const priceDelta = Math.abs(poAmount - invoiceAmount);
  const qtyDelta   = Math.abs(qtyOrdered - qtyReceived);
  if (priceDelta <= 500 && qtyDelta === 0) return 'MATCHED';
  if (priceDelta <= 1000 && qtyDelta <= 5)  return 'TOLERANCE_BYPASS';
  return 'DISCREPANCY';
}

// ── Workflow Executor ───────────────────────────────────────────
function executeColdChainWorkflow(inst) {
  const v = inst.variables;
  addLog('Zeebe', `coldChainReplenishment #${inst.id} started → Step 1: User Task [Review & Approve Request]`);

  // ── Incident Simulation ──
  if (v.requestId && v.requestId.includes('FAIL')) {
    const iid = 'INC-' + Math.floor(Math.random()*9000+1000);
    state.incidents.push({
      id: iid, instanceId: inst.id, process: 'coldChainReplenishment',
      activityId: 'Task_ReviewRequest',
      errorMessage: 'Simulated failure: Store approval service unreachable!',
      retries: 0, state: 'ACTIVE'
    });
    inst.state = 'INCIDENT'; inst.activeIncidentId = iid;
    addLog('Operate', `INCIDENT ${iid} created on #${inst.id} at Task_ReviewRequest`);
    return;
  }

  // ── Step 1: Review & Approve ──
  if (v.requestApproved === false) {
    inst.state = 'COMPLETED';
    inst.endEvent = 'EndEvent_RequestRejected';
    inst.finalResult = 'Request rejected by Store Manager';
    addLog('Zeebe', `#${inst.id} → Gateway_RequestApproved = false → EndEvent_RequestRejected`);
    return;
  }

  addLog('Zeebe', `#${inst.id} → Gateway_RequestApproved = true → Parallel Multi-Instance RFQ`);

  // ── Step 2: Parallel RFQ Sub-Process ──
  v.suppliers = v.suppliers || [
    { supplierId: 'SUP-A', name: 'Green Valley Dairy', email: 'a@sup.example' },
    { supplierId: 'SUP-B', name: 'Hill Farms',         email: 'b@sup.example' },
    { supplierId: 'SUP-C', name: 'Fresh Fields',       email: 'c@sup.example' }
  ];
  v.quotes = [
    { supplierId: 'SUP-A', name: 'Green Valley Dairy', price: v.quoteA || 32000, responded: true },
    { supplierId: 'SUP-B', name: 'Hill Farms',         price: v.quoteB || 36000, responded: true },
    { supplierId: 'SUP-C', name: 'Fresh Fields',       price: v.quoteC || 41000, responded: true }
  ];
  addLog('Zeebe', `#${inst.id} SubProcess_ParallelRFQ: dispatched 3 parallel RFQs`);

  // ── Step 3: FEEL Rank Quotes & PO ──
  const winner = feelRankQuotes(v.quotes);
  v.selectedSupplier = winner;
  v.poNumber = `PO-${v.requestId}-${winner.supplierId}`;
  addLog('FEEL', `#${inst.id} Script_RankQuotes → winner: ${winner.name} (₹${winner.price}). PO: ${v.poNumber}`);

  // ── Step 4: Cold-Chain Transit Sub-Process ──
  addLog('Zeebe', `#${inst.id} → SubProcess_ColdChainTransit activated`);

  // ── Temperature Excursion? ──
  if (v.simulateTempExcursion) {
    addLog('IoT', `#${inst.id} TempExcursionDetected! Core temp ${v.excursionTemp || 9.2}°C > 8.0°C threshold`);
    addLog('Zeebe', `#${inst.id} → Non-interrupting Event Sub-Process triggered`);

    // QA Triage User Task
    const qaTaskId = 'TASK-' + Math.floor(Math.random()*9000+1000);
    state.tasks.push({
      id: qaTaskId, instanceId: inst.id, process: 'coldChainReplenishment',
      name: 'QA Excursion Triage — Inspect & Decide',
      candidateGroup: 'qa-inspectors', state: 'CREATED',
      variables: v
    });
    inst.state = 'WAITING_USER_TASK'; inst.pendingTaskId = qaTaskId;
    addLog('Tasklist', `QA Triage Task ${qaTaskId} created for qa-inspectors on #${inst.id}`);
    return;
  }

  // ── Step 5: Shipment Delivered — Message Catch ──
  addLog('Zeebe', `#${inst.id} Message "ShipmentDelivered" correlated with key "${v.poNumber}"`);

  // ── Step 6: Confirm Goods Receipt (User Task) ──
  const qtyReceived = v.qtyReceived || 350;
  const invoiceAmount = v.invoiceAmount || winner.price;
  v.qtyReceived = qtyReceived;
  v.invoiceAmount = invoiceAmount;

  // ── Step 7: Three-Way Match (Call Activity) ──
  const matchResult = dmnThreeWayMatch(winner.price, winner.price, invoiceAmount, 350, qtyReceived);
  v.matchStatus = matchResult;
  addLog('DMN', `#${inst.id} CallActivity_ThreeWayMatch → ${matchResult} (PO: ₹${winner.price}, INV: ₹${invoiceAmount}, Qty: ${qtyReceived}/350)`);

  if (matchResult === 'MATCHED') {
    inst.state = 'COMPLETED';
    inst.endEvent = 'EndEvent_ReplenishmentCompleted';
    inst.finalResult = `100% 3-Way Match verified. ₹${winner.price} settled. Order complete.`;
    addLog('Zeebe', `#${inst.id} COMPLETED → EndEvent_ReplenishmentCompleted`);
  } else if (matchResult === 'TOLERANCE_BYPASS') {
    inst.state = 'COMPLETED';
    inst.endEvent = 'EndEvent_ReplenishmentCompleted';
    inst.finalResult = `Tolerance Bypass approved (delta ₹${Math.abs(winner.price - invoiceAmount)}). Payment released.`;
    addLog('Zeebe', `#${inst.id} COMPLETED → auto tolerance bypass → EndEvent_ReplenishmentCompleted`);
  } else {
    // AP Clerk Manual Review
    const apTaskId = 'TASK-' + Math.floor(Math.random()*9000+1000);
    state.tasks.push({
      id: apTaskId, instanceId: inst.id, process: 'coldChainReplenishment',
      name: 'AP Clerk Invoice Discrepancy Review',
      candidateGroup: 'ap-clerks', state: 'CREATED',
      variables: v
    });
    inst.state = 'WAITING_USER_TASK'; inst.pendingTaskId = apTaskId;
    addLog('Tasklist', `AP Clerk Review Task ${apTaskId} created — ₹${Math.abs(winner.price - invoiceAmount)} delta on #${inst.id}`);
  }
}

// ── Demo Scenarios ──────────────────────────────────────────────
function runAllColdChainScenarios() {
  addLog('Simulator', '═══ TRIGGERING 8 COLD-CHAIN REPLENISHMENT SCENARIOS ═══');

  // 1. Happy Path — standard order, 100% 3-way match
  startDirect({ requestId: 'REQ-1001', storeId: 'STORE-12', budgetCap: 50000, requestApproved: true,
    items: [{sku:'MILK-1L',qty:200},{sku:'YOGURT-500G',qty:150}], scenario: '① Happy Path (Auto Match)' });

  // 2. Request Rejected by Store Manager
  startDirect({ requestId: 'REQ-1002', storeId: 'STORE-07', budgetCap: 30000, requestApproved: false,
    items: [{sku:'BUTTER-250G',qty:100}], scenario: '② Request Rejected' });

  // 3. Temperature Excursion → QA Triage
  startDirect({ requestId: 'REQ-1003', storeId: 'STORE-12', budgetCap: 45000, requestApproved: true,
    simulateTempExcursion: true, excursionTemp: 9.2,
    items: [{sku:'CREAM-500ML',qty:80}], scenario: '③ Temp Excursion → QA Triage' });

  // 4. Invoice Discrepancy → AP Clerk Review
  startDirect({ requestId: 'REQ-1004', storeId: 'STORE-15', budgetCap: 60000, requestApproved: true,
    invoiceAmount: 38500, // vs winner price ~32000 → discrepancy
    items: [{sku:'CHEESE-1KG',qty:120}], scenario: '④ Invoice Discrepancy → AP Clerk' });

  // 5. Tolerance Bypass (small delta auto-approved)
  startDirect({ requestId: 'REQ-1005', storeId: 'STORE-03', budgetCap: 55000, requestApproved: true,
    invoiceAmount: 32400, qtyReceived: 350,
    items: [{sku:'EGGS-12PK',qty:200}], scenario: '⑤ Tolerance Bypass (₹400 delta)' });

  // 6. Different supplier wins (Hill Farms cheapest)
  startDirect({ requestId: 'REQ-1006', storeId: 'STORE-22', budgetCap: 70000, requestApproved: true,
    quoteA: 45000, quoteB: 29000, quoteC: 38000,
    items: [{sku:'PANEER-200G',qty:300}], scenario: '⑥ Hill Farms Wins Bid' });

  // 7. Simulated Incident (service failure)
  startDirect({ requestId: 'FAIL-REQ-1007', storeId: 'STORE-12', budgetCap: 40000, requestApproved: true,
    items: [{sku:'MILK-1L',qty:100}], scenario: '⑦ Simulated Incident (Operate)' });

  // 8. Large order, quantity mismatch → AP Clerk
  startDirect({ requestId: 'REQ-1008', storeId: 'STORE-18', budgetCap: 80000, requestApproved: true,
    invoiceAmount: 33000, qtyReceived: 340, // 10 short
    items: [{sku:'CURD-500G',qty:250},{sku:'LASSI-1L',qty:100}], scenario: '⑧ Qty Mismatch → AP Clerk' });
}

function startDirect(variables) {
  const instanceId = 'PI-' + Math.floor(Math.random()*900000+100000);
  const inst = {
    id: instanceId,
    processDefinitionKey: 'coldChainReplenishment',
    startTime: new Date().toISOString(),
    state: 'ACTIVE',
    variables: variables,
    endEvent: null,
    finalResult: null,
    scenario: variables.scenario || ''
  };
  state.instances.unshift(inst);
  executeColdChainWorkflow(inst);
}

// ── HTTP Server ─────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname  = parsedUrl.pathname;
  const method    = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let json = {};
    if (body) { try { json = JSON.parse(body); } catch(e) {} }

    // Dashboard
    if (pathname === '/' && method === 'GET') {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end(renderDashboard());
    }

    // Start instance
    if (pathname === '/v1/process-instances' && method === 'POST') {
      const vars = json.variables || json;
      startDirect(vars);
      res.writeHead(201, {'Content-Type':'application/json'});
      return res.end(JSON.stringify(state.instances[0], null, 2));
    }

    // List instances
    if (pathname === '/v1/process-instances' && method === 'GET') {
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify(state.instances, null, 2));
    }

    // Tasklist search
    if (pathname === '/v1/tasks/search') {
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify(state.tasks.filter(t => t.state === 'CREATED'), null, 2));
    }

    // Complete task
    if (pathname.startsWith('/v1/tasks/') && pathname.endsWith('/complete')) {
      const taskId = pathname.split('/')[3];
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) { res.writeHead(404); return res.end('{"error":"Not found"}'); }
      task.state = 'COMPLETED'; task.completedAt = new Date().toISOString();
      const inst = state.instances.find(i => i.id === task.instanceId);
      if (inst) {
        inst.state = 'COMPLETED';
        inst.finalResult = `Resolved via Tasklist by ${task.candidateGroup}`;
        addLog('Tasklist', `Task ${taskId} completed → instance #${inst.id} advanced to completion`);
      }
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({success:true, task, instance: inst}, null, 2));
    }

    // Incidents search
    if (pathname === '/v1/incidents/search') {
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify(state.incidents, null, 2));
    }

    // Retry incident
    if (pathname.startsWith('/v1/jobs/') && pathname.endsWith('/update-retries') && method === 'POST') {
      const incId = pathname.split('/')[3];
      const inc = state.incidents.find(i => i.id === incId);
      if (inc) {
        inc.state = 'RESOLVED';
        const inst = state.instances.find(i => i.id === inc.instanceId);
        if (inst) { inst.state = 'COMPLETED'; inst.finalResult = 'Recovered after Operate incident retry'; }
        addLog('Operate', `Incident ${inc.id} RESOLVED → instance #${inc.instanceId} recovered`);
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({success:true, incident: inc}, null, 2));
      }
      res.writeHead(404); return res.end('{"error":"Incident not found"}');
    }

    // Re-trigger all scenarios
    if (pathname === '/api/run-all-scenarios' && method === 'POST') {
      runAllColdChainScenarios();
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end('{"success":true}');
    }

    res.writeHead(404); res.end('{"error":"Not found"}');
  });
});

// ── Dashboard HTML ──────────────────────────────────────────────
function renderDashboard() {
  const activeInc   = state.incidents.filter(i => i.state === 'ACTIVE');
  const pendingTask = state.tasks.filter(t => t.state === 'CREATED');
  const completed   = state.instances.filter(i => i.state === 'COMPLETED').length;
  const waiting     = state.instances.filter(i => i.state === 'WAITING_USER_TASK').length;
  const incident    = state.instances.filter(i => i.state === 'INCIDENT').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Cold-Chain Replenishment — Camunda 8 Console</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #0a0f1a; color: #e2e8f0; padding: 20px 28px; }
    .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 18px; margin-bottom: 24px; border-bottom: 2px solid #1e293b; }
    h1 { font-size: 22px; color: #34d399; }
    h1 span { color: #64748b; font-weight: 400; font-size: 14px; }
    h2 { font-size: 15px; color: #38bdf8; margin-bottom: 12px; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 20px; flex: 1; text-align: center; }
    .stat .num { font-size: 28px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
    .stat .lbl { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
    .num-green  { color: #34d399; }
    .num-amber  { color: #fbbf24; }
    .num-red    { color: #f87171; }
    .num-blue   { color: #60a5fa; }
    .grid { display: grid; grid-template-columns: 5fr 3fr; gap: 20px; }
    .card { background: #111827; border: 1px solid #1e293b; border-radius: 10px; padding: 18px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #1e293b; text-align: left; }
    th { color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    .badge { padding: 3px 8px; border-radius: 4px; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; }
    .badge-COMPLETED         { background: #064e3b; color: #6ee7b7; }
    .badge-WAITING_USER_TASK { background: #713f12; color: #fde68a; }
    .badge-INCIDENT          { background: #7f1d1d; color: #fca5a5; }
    .btn { border: none; padding: 7px 14px; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer; transition: 0.15s; }
    .btn:hover { filter: brightness(1.15); }
    .btn-primary  { background: #059669; color: white; }
    .btn-complete { background: #2563eb; color: white; padding: 5px 10px; font-size: 11px; }
    .btn-retry    { background: #dc2626; color: white; padding: 5px 10px; font-size: 11px; }
    .btn-trigger  { background: linear-gradient(135deg, #059669, #0d9488); color: white; font-size: 13px; padding: 10px 20px; }
    .task-card { background: #0f172a; padding: 12px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid #fbbf24; }
    .task-card .title { font-weight: 600; font-size: 13px; color: #f8fafc; }
    .task-card .meta  { font-size: 11px; color: #94a3b8; margin: 4px 0 8px; }
    .inc-card { background: #0f172a; padding: 12px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid #ef4444; }
    .inc-card .title { font-weight: 600; color: #fca5a5; font-size: 13px; }
    .inc-card .msg   { font-size: 11px; color: #cbd5e1; margin: 4px 0 8px; }
    .log-box { max-height: 240px; overflow-y: auto; background: #050810; padding: 10px; border-radius: 6px; font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.6; color: #67e8f9; }
    .scenario-tag { font-size: 10px; color: #a78bfa; font-weight: 500; }
    .empty { color: #475569; font-size: 12px; padding: 16px; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>❄️ Cold-Chain Replenishment <span>— Camunda 8 Zeebe Console</span></h1>
      <p style="color:#64748b; font-size:12px; margin-top:4px;">Process: <strong>coldChainReplenishment</strong> | BPMN 2.0 | FEEL Engine | 3-Way Match DMN</p>
    </div>
    <button class="btn btn-trigger" onclick="runAll()">⚡ Trigger All 8 Scenarios</button>
  </div>

  <div class="stats">
    <div class="stat"><div class="num num-blue">${state.instances.length}</div><div class="lbl">Total Instances</div></div>
    <div class="stat"><div class="num num-green">${completed}</div><div class="lbl">Completed</div></div>
    <div class="stat"><div class="num num-amber">${waiting}</div><div class="lbl">Awaiting Task</div></div>
    <div class="stat"><div class="num num-red">${incident}</div><div class="lbl">Incidents</div></div>
  </div>

  <div class="grid">
    <div>
      <div class="card">
        <h2>Process Instances (Operate View)</h2>
        <table>
          <thead><tr><th>ID</th><th>Scenario</th><th>State</th><th>Outcome</th></tr></thead>
          <tbody>
            ${state.instances.map(i => `
              <tr>
                <td><strong>${i.id}</strong></td>
                <td><span class="scenario-tag">${i.scenario || i.variables.requestId || ''}</span></td>
                <td><span class="badge badge-${i.state}">${i.state}</span></td>
                <td style="max-width:300px">${i.finalResult || (i.state==='WAITING_USER_TASK' ? 'Pending in Tasklist' : i.state==='INCIDENT' ? 'Active Incident' : '—')}</td>
              </tr>
            `).join('')}
            ${state.instances.length===0 ? '<tr><td colspan="4" class="empty">No instances yet. Click ⚡ Trigger All 8 Scenarios.</td></tr>' : ''}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Live Zeebe & FEEL Audit Log</h2>
        <div class="log-box">
          ${state.logs.map(l => `<div>${l}</div>`).join('')}
        </div>
      </div>
    </div>

    <div>
      <div class="card">
        <h2>Tasklist Human Tasks (${pendingTask.length})</h2>
        <div style="font-size:11px; color:#64748b; margin-bottom:10px;">Tasks awaiting authorized cold-chain staff:</div>
        ${pendingTask.map(t => `
          <div class="task-card">
            <div class="title">${t.name}</div>
            <div class="meta">Role: <strong>${t.candidateGroup}</strong> · Instance: ${t.instanceId}</div>
            <button class="btn btn-complete" onclick="completeTask('${t.id}')">✓ Approve & Complete</button>
          </div>
        `).join('')}
        ${pendingTask.length===0 ? '<div class="empty">No pending tasks.</div>' : ''}
      </div>

      <div class="card">
        <h2>Operate Active Incidents (${activeInc.length})</h2>
        <div style="font-size:11px; color:#64748b; margin-bottom:10px;">Failed jobs requiring diagnosis & retry:</div>
        ${activeInc.map(inc => `
          <div class="inc-card">
            <div class="title">${inc.id}: ${inc.activityId}</div>
            <div class="msg">${inc.errorMessage}</div>
            <button class="btn btn-retry" onclick="retryIncident('${inc.id}')">↻ Diagnose & Retry</button>
          </div>
        `).join('')}
        ${activeInc.length===0 ? '<div class="empty">All workflows healthy.</div>' : ''}
      </div>
    </div>
  </div>

  <script>
    async function runAll() {
      await fetch('/api/run-all-scenarios', {method:'POST'});
      location.reload();
    }
    async function completeTask(id) {
      await fetch('/v1/tasks/'+id+'/complete', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({variables:{action:'APPROVED'}})
      });
      location.reload();
    }
    async function retryIncident(id) {
      await fetch('/v1/jobs/'+id+'/update-retries', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({retries:3})
      });
      location.reload();
    }
    // Auto-refresh every 5s
    setTimeout(() => location.reload(), 5000);
  </script>
</body>
</html>`;
}

server.listen(PORT, () => {
  addLog('Simulator', `Cold-Chain Camunda 8 Console running at http://localhost:${PORT}`);
  runAllColdChainScenarios();
});

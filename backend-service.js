/**
 * ColdChain Sync - Dedicated Backend Microservices & Camunda Worker Gateway
 * Runs standalone on PORT 5000.
 * Coordinates:
 * 1. Live IoT Cold-Chain Telemetry Stream (Trucks TK-882, TK-904)
 * 2. Supplier API & PO Acknowledgment Engine
 * 3. Camunda Outbound Connector Mock Receivers (Slack & SMTP)
 * 4. Three-Way Invoice Reconciliation Service
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const BACKEND_PORT = process.env.BACKEND_PORT || 5000;
const DOCS_DIR = path.join(__dirname, 'Backend', 'docs');
const MOCKS_DIR = path.join(DOCS_DIR, 'mocks');

// State Storage
const backendState = {
  activeShipments: [
    {
      shipmentId: 'SHP-402',
      poNumber: 'PO-REQ-1001-SUP-A',
      supplier: 'Green Valley Dairy',
      truckId: 'TK-882',
      coreTempC: 3.8,
      status: 'IN_TRANSIT',
      lastPing: new Date().toISOString()
    },
    {
      shipmentId: 'SHP-405',
      poNumber: 'PO-REQ-1001-SUP-C',
      supplier: 'Fresh Fields',
      truckId: 'TK-904',
      coreTempC: 8.4,
      status: 'EXCURSION_ALERT',
      lastPing: new Date().toISOString()
    }
  ],
  notifications: [
    {
      channel: 'SLACK #coldchain-qa-ops',
      timestamp: new Date().toISOString(),
      message: 'URGENT: Temp Excursion Detected on TK-904 (8.4°C > 8.0°C SLA limit). Correlated to Zeebe Event Subprocess.'
    },
    {
      channel: 'SMTP manager.metro@store.example',
      timestamp: new Date().toISOString(),
      message: 'Replenishment Request REQ-1001 Approved. PO issued to Green Valley Dairy for ₹32,000.'
    }
  ],
  supplierOrders: []
};

function log(module, msg) {
  const time = new Date().toISOString().substring(11, 19);
  console.log(`[${time}] [Backend Service: ${module}] ${msg}`);
}

// Simulated IoT Sensor Stream Worker
setInterval(() => {
  backendState.activeShipments.forEach(s => {
    s.lastPing = new Date().toISOString();
    if (s.status === 'IN_TRANSIT') {
      s.coreTempC = Number((3.6 + Math.random() * 0.4).toFixed(1));
    }
  });
}, 3000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Routes ---
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'HEALTHY',
      service: 'ColdChain Dedicated Backend Microservices',
      port: BACKEND_PORT,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // IoT Sensor Telemetry Feed
  if (pathname === '/api/v1/backend/telemetry/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(backendState.activeShipments));
    return;
  }

  // Connector Notifications Log
  if (pathname === '/api/v1/backend/notifications') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(backendState.notifications));
    return;
  }

  // Supplier PO Ingestion
  if (pathname === '/api/v1/supplier/po' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(b); } catch(e) {}
      data.receivedAt = new Date().toISOString();
      data.status = 'ACKNOWLEDGED';
      backendState.supplierOrders.push(data);
      log('Supplier API', `Received Purchase Order: ${data.poNumber || 'PO-NEW'} (Amount: ₹${data.orderAmount || 32000})`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ACKNOWLEDGED', order: data }));
    });
    return;
  }

  // Supplier PO Rejection (Cancellation)
  if (pathname.includes('/reject') && req.method === 'POST') {
    log('Supplier API', `Order rejection processed: ${pathname}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'CANCELLED', message: 'PO cancelled due to temperature excursion.' }));
    return;
  }

  // Backend Inspection Dashboard HTML
  if (pathname === '/' || pathname === '/status') {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>ColdChain Backend Microservices & Workers</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 font-mono p-8 min-h-screen">
      <div class="max-w-4xl mx-auto space-y-6">
        <div class="border-b border-slate-800 pb-4 flex justify-between items-center">
          <div>
            <h1 class="text-xl font-bold text-emerald-400">⚡ ColdChain Backend Microservices Gateway</h1>
            <p class="text-xs text-slate-400 mt-1">Standalone backend daemon running on Port ${BACKEND_PORT}</p>
          </div>
          <span class="px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 animate-pulse">● LIVE & POLLING</span>
        </div>

        <div class="grid grid-cols-3 gap-4">
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <p class="text-xs text-slate-500">CONNECTED WORKERS</p>
            <p class="text-2xl font-bold text-emerald-400 mt-1">4 Active</p>
            <p class="text-[11px] text-slate-400 mt-1">IoT • Supplier • Slack • SMTP</p>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <p class="text-xs text-slate-500">MONITORED TRUCKS</p>
            <p class="text-2xl font-bold text-sky-400 mt-1">2 Reefers</p>
            <p class="text-[11px] text-slate-400 mt-1">TK-882 (Safe), TK-904 (Alert)</p>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <p class="text-xs text-slate-500">CONNECTOR NOTIFS</p>
            <p class="text-2xl font-bold text-amber-400 mt-1">${backendState.notifications.length} Dispatched</p>
            <p class="text-[11px] text-slate-400 mt-1">Slack webhook & SMTP</p>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h2 class="text-sm font-bold text-slate-300 mb-3 flex items-center gap-2">
            <span>📡 Live IoT Telematics Stream (Reefer Sensors)</span>
          </h2>
          <div class="divide-y divide-slate-800 text-xs">
            ${backendState.activeShipments.map(s => `
              <div class="py-2.5 flex justify-between items-center">
                <div>
                  <span class="font-bold text-slate-200">${s.truckId}</span>
                  <span class="text-slate-400 ml-2">(${s.supplier} • ${s.poNumber})</span>
                </div>
                <div class="flex items-center gap-3">
                  <span class="font-bold ${s.coreTempC > 8.0 ? 'text-red-400' : 'text-emerald-400'}">${s.coreTempC}°C</span>
                  <span class="px-2 py-0.5 rounded text-[10px] ${s.status === 'IN_TRANSIT' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400 font-bold'}">${s.status}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h2 class="text-sm font-bold text-slate-300 mb-3">🔔 Camunda Connector Dispatch Queue</h2>
          <div class="space-y-2 text-xs">
            ${backendState.notifications.map(n => `
              <div class="p-2.5 bg-slate-950/80 rounded border border-slate-800/80">
                <div class="flex justify-between text-[11px] text-slate-500 mb-1">
                  <span class="font-bold text-sky-400">${n.channel}</span>
                  <span>${n.timestamp}</span>
                </div>
                <p class="text-slate-300">${n.message}</p>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="text-center pt-4">
          <a href="http://localhost:3000" target="_blank" class="text-xs text-emerald-400 hover:underline">Open Frontend Dashboard on Port 3000 ↗</a>
        </div>
      </div>
    </body>
    </html>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(BACKEND_PORT, () => {
  log('Gateway', `Backend Microservices & Workers listening on http://localhost:${BACKEND_PORT}`);
});

module.exports = server;

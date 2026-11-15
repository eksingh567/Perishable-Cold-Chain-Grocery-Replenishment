/**
 * ColdChain Sync - Full-Stack Local Server & Camunda 8 Mock REST API
 * Zero external dependencies (uses Node.js native http, fs, path).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const MOCKS_DIR = path.join(__dirname, 'Backend', 'docs', 'mocks');
const BPMN_DIR = path.join(__dirname, 'Backend', 'bpmn-models');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Endpoints
  if (pathname.startsWith('/api/')) {
    // GET /api/health
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'HEALTHY', engine: 'Camunda 8 Zeebe v8.5+', timestamp: new Date().toISOString() }));
      return;
    }

    // GET /api/v1/telemetry/excursions or /api/v1/telemetry/:po
    if (pathname.includes('/excursions')) {
      const mockFile = path.join(MOCKS_DIR, 'iot-telemetry-mock.json');
      const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
      const excursion = data.endpoints.find(e => e.scenario.includes('Excursion Alarm'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(excursion ? excursion.responseBody : {}));
      return;
    }

    if (pathname.startsWith('/api/v1/telemetry')) {
      const mockFile = path.join(MOCKS_DIR, 'iot-telemetry-mock.json');
      const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
      const normal = data.endpoints.find(e => e.scenario.includes('Normal'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(normal ? normal.responseBody : {}));
      return;
    }

    // POST /api/v1/supplier/po
    if (pathname === '/api/v1/supplier/po' && req.method === 'POST') {
      const mockFile = path.join(MOCKS_DIR, 'supplier-api-mock.json');
      const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data.endpoints[0].responseBody));
      return;
    }

    // POST /api/v1/process/start
    if (pathname === '/api/v1/process/start' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        processDefinitionKey: '2251799813758760',
        processInstanceKey: '2251799813758' + Math.floor(1000 + Math.random() * 9000),
        bpmnProcessId: 'coldChainReplenishment',
        version: 1,
        status: 'ACTIVE'
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
    return;
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

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`ColdChain Sync Server listening at http://localhost:${PORT}`);
  });
}

module.exports = server;

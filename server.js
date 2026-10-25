'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const {
  MODEL_WEIGHTS,
  PACKAGE_PRESETS,
  LAYOUT_PROJECTS,
  SEMICONDUCTOR_FAMILIES
} = require('./src/dataset');

const {
  classifyPackage,
  selectLayouts,
  sizeDie,
  generateSignoffReport
} = require('./src/engine');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function parseJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let received = 0;

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error('Request payload exceeds maximum size of 2MB.'));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (!raw || !raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

function createPinScopeServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, {
          status: 'ok',
          service: 'pinscope',
          version: '1.0.1',
          nodeVersion: process.version,
          workflows: ['classify', 'select', 'size'],
          weights: MODEL_WEIGHTS,
          combinedCurrentPinoutWeight: Number((MODEL_WEIGHTS.current + MODEL_WEIGHTS.pinCount).toFixed(2))
        });
        return;
      }

      if (pathname === '/api/catalog' && req.method === 'GET') {
        const topologies = Array.from(new Set(LAYOUT_PROJECTS.map((p) => p.topology)));
        const interconnects = Array.from(new Set(LAYOUT_PROJECTS.map((p) => p.interconnect)));

        sendJson(res, 200, {
          weights: MODEL_WEIGHTS,
          combinedCurrentPinoutWeight: Number((MODEL_WEIGHTS.current + MODEL_WEIGHTS.pinCount).toFixed(2)),
          topologies,
          interconnects,
          presets: PACKAGE_PRESETS,
          projects: LAYOUT_PROJECTS,
          families: SEMICONDUCTOR_FAMILIES
        });
        return;
      }

      if (pathname === '/api/classify' && (req.method === 'POST' || req.method === 'GET')) {
        const payload = req.method === 'POST'
          ? await parseJsonBody(req)
          : { presetId: parsedUrl.searchParams.get('presetId') || undefined };
        sendJson(res, 200, classifyPackage(payload));
        return;
      }

      if (pathname === '/api/select' && (req.method === 'POST' || req.method === 'GET')) {
        const payload = req.method === 'POST'
          ? await parseJsonBody(req)
          : {
              topology: parsedUrl.searchParams.get('topology') || undefined,
              interconnect: parsedUrl.searchParams.get('interconnect') || undefined,
              currentA: parsedUrl.searchParams.get('currentA') || undefined,
              pinCount: parsedUrl.searchParams.get('pinCount') || undefined,
              lengthMm: parsedUrl.searchParams.get('lengthMm') || undefined,
              widthMm: parsedUrl.searchParams.get('widthMm') || undefined,
              pitchMm: parsedUrl.searchParams.get('pitchMm') || undefined
            };
        sendJson(res, 200, selectLayouts(payload));
        return;
      }

      if (pathname === '/api/size' && (req.method === 'POST' || req.method === 'GET')) {
        const payload = req.method === 'POST'
          ? await parseJsonBody(req)
          : {
              familyId: parsedUrl.searchParams.get('familyId') || undefined,
              mode: parsedUrl.searchParams.get('mode') || undefined,
              targetCurrentA: parsedUrl.searchParams.get('targetCurrentA') || undefined,
              targetAreaMm2: parsedUrl.searchParams.get('targetAreaMm2') || undefined
            };
        sendJson(res, 200, sizeDie(payload));
        return;
      }

      if (pathname === '/api/report' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        sendJson(res, 200, generateSignoffReport(payload));
        return;
      }

      const relativeTarget = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const resolvedPath = path.resolve(PUBLIC_DIR, relativeTarget);

      if (!resolvedPath.startsWith(PUBLIC_DIR)) {
        sendJson(res, 403, { error: 'Forbidden path' });
        return;
      }

      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
        const ext = path.extname(resolvedPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = fs.readFileSync(resolvedPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache'
        });
        res.end(content);
        return;
      }

      sendJson(res, 404, { error: `Route not found: ${pathname}` });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Internal Server Error' });
    }
  });
}

function startServer(preferredPort = Number(process.env.PORT) || 4173, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createPinScopeServer();

    const tryListen = (portToTry, isFallback = false) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && !isFallback) {
          server.removeListener('error', onError);
          tryListen(0, true);
        } else {
          reject(err);
        }
      };

      server.once('error', onError);
      server.listen(portToTry, host, () => {
        server.removeListener('error', onError);
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : portToTry;
        const url = `http://localhost:${actualPort}`;
        if (isFallback && preferredPort !== 0) {
          console.log(`[PinScope] Port ${preferredPort} is occupied; automatically selected available port ${actualPort}.`);
        }
        console.log(`[PinScope] Layout Intelligence Workspace running at ${url}`);
        resolve({ server, port: actualPort, url });
      });
    };

    tryListen(preferredPort, false);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[PinScope] Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  createPinScopeServer,
  startServer
};

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const port = process.env.PORT || 3000;

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const AGENTS_SERVICE_URL = process.env.AGENTS_SERVICE_URL || 'http://localhost:3002';
const VISITS_SERVICE_URL = process.env.VISITS_SERVICE_URL || 'http://localhost:3003';
const REPORTS_SERVICE_URL = process.env.REPORTS_SERVICE_URL || 'http://localhost:3004';
const frontendOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const services = {
  auth: AUTH_SERVICE_URL,
  agents: AGENTS_SERVICE_URL,
  visits: VISITS_SERVICE_URL,
  reports: REPORTS_SERVICE_URL,
};

// CORS - allow frontend
app.use(cors({
  origin: (origin, callback) => callback(null, origin && frontendOrigins.includes(origin) ? origin : false),
  credentials: true
}));

app.use((req, res, next) => {
  req.requestId = randomUUID();
  req.headers['x-request-id'] = req.requestId;
  res.setHeader('X-Request-ID', req.requestId);
  const requestPath = req.path;
  const startedAt = process.hrtime.bigint();
  let logged = false;
  const logRequest = (closedEarly = false) => {
    if (logged) return;
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const photoUpload = req.method === 'PUT' && /^\/api\/v1\/visits\/[^/]+\/photo$/.test(requestPath);
    if (!closedEarly && !photoUpload && res.statusCode < 400 && durationMs < 1000) return;
    const service = requestPath.startsWith('/api/v1/visits') || requestPath.startsWith('/uploads') ? 'visits-service'
      : requestPath.startsWith('/api/v1/agents') || requestPath.startsWith('/api/v1/territories') ? 'agents-service'
        : requestPath.startsWith('/api/v1/auth') || requestPath.startsWith('/api/v1/users') ? 'auth-service'
          : requestPath.startsWith('/api/v1/reports') || requestPath.startsWith('/api/v1/config') ? 'reports-service' : 'api-gateway';
    console.info(JSON.stringify({
      event: 'http_request', service: 'api-gateway', upstream: service, requestId: req.requestId,
      method: req.method, path: requestPath, status: res.statusCode, durationMs: Math.round(durationMs), closedEarly,
      requestBytes: Number(req.get('content-length')) || undefined,
    }));
  };
  res.on('finish', () => logRequest());
  res.on('close', () => { if (!res.writableFinished) logRequest(true); });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ service: 'api-gateway', status: 'ok' });
});

app.get('/ready', async (req, res) => {
  const checks = await Promise.all(Object.entries(services).map(async ([name, target]) => {
    try {
      const response = await fetch(`${target}/ready`, { signal: AbortSignal.timeout(2500) });
      return [name, response.ok];
    } catch {
      return [name, false];
    }
  }));
  const unavailable = checks.filter(([, healthy]) => !healthy).map(([name]) => name);
  res.status(unavailable.length ? 503 : 200).json({
    service: 'api-gateway',
    status: unavailable.length ? 'not_ready' : 'ready',
    unavailable,
  });
});

// Proxy helper for API routes
function createJsonProxy(target, routePrefix, serviceName) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,

    pathRewrite: (path) => {
      return `${routePrefix}${path}`;
    },

    on: {
      error: (err, req, res) => {
        const requestId = req.requestId || randomUUID();
        console.error(`Proxy error (${requestId}) to ${serviceName}:`, err.code || err.message);

        if (!res.headersSent) {
          res.status(503).json({
            error: 'Service temporarily unavailable. Please try again.',
            service: serviceName,
            requestId,
          });
        }
      }
    }
  });
}

// Proxy for file uploads (visits photos) - needs different body handling
function createUploadProxy(target, serviceName) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => `/uploads${path}`,
    on: {
      error: (err, req, res) => {
        const requestId = req.requestId || randomUUID();
        console.error(`Proxy error (${requestId}) to ${serviceName}:`, err.code || err.message);
        if (!res.headersSent) res.status(503).json({ error: 'Service temporarily unavailable. Please try again.', service: serviceName, requestId });
      },
    },
  });
}

// AuthService
app.use(
  '/api/v1/auth',
  createJsonProxy(AUTH_SERVICE_URL, '/api/v1/auth', 'auth-service')
);

app.use(
  '/api/v1/users',
  createJsonProxy(AUTH_SERVICE_URL, '/api/v1/users', 'auth-service')
);

// AgentsService
app.use(
  '/api/v1/agents',
  createJsonProxy(AGENTS_SERVICE_URL, '/api/v1/agents', 'agents-service')
);

app.use(
  '/api/v1/territories',
  createJsonProxy(AGENTS_SERVICE_URL, '/api/v1/territories', 'agents-service')
);

// VisitsService
app.use(
  '/api/v1/visits',
  createJsonProxy(VISITS_SERVICE_URL, '/api/v1/visits', 'visits-service')
);

app.use(
  '/uploads',
  createUploadProxy(VISITS_SERVICE_URL, 'visits-service')
);

// ReportsService
app.use(
  '/api/v1/reports',
  createJsonProxy(REPORTS_SERVICE_URL, '/api/v1/reports', 'reports-service')
);

app.use(
  '/api/v1/config',
  createJsonProxy(REPORTS_SERVICE_URL, '/api/v1/config', 'reports-service')
);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(port, () => {
  console.log(`ApiGateway listening on port ${port}`);
  console.log(`  AuthService:    ${AUTH_SERVICE_URL}`);
  console.log(`  AgentsService:  ${AGENTS_SERVICE_URL}`);
  console.log(`  VisitsService:  ${VISITS_SERVICE_URL}`);
  console.log(`  ReportsService: ${REPORTS_SERVICE_URL}`);
});

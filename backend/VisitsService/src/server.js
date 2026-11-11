const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { randomUUID } = require('crypto');
const { performance } = require('node:perf_hooks');
const dotenv = require('dotenv');
dotenv.config();
const prisma = require('./utils/prisma');
const { addPiiResponseSanitizer } = require('../../shared/pii');

const app = express();
app.use(helmet());
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || randomUUID();
  req.requestStartedAt = performance.now();
  req.requestPath = req.path;
  res.setHeader('X-Request-ID', req.requestId);
  let logged = false;
  const logRequest = (closedEarly = false) => {
    if (logged) return;
    logged = true;
    const durationMs = Math.round(performance.now() - req.requestStartedAt);
    const photoUpload = req.method === 'PUT' && /^\/api\/v1\/visits\/[^/]+\/photo$/.test(req.requestPath);
    if (!closedEarly && !photoUpload && res.statusCode < 400 && durationMs < 1000) return;
    console.info(JSON.stringify({
      event: 'http_request', service: 'visits-service', requestId: req.requestId,
      method: req.method, path: req.requestPath, status: res.statusCode, durationMs, closedEarly,
      requestBytes: Number(req.get('content-length')) || undefined,
      uploadBytes: req.file?.size, uploadMs: req.photoUploadMs,
      visitLookupMs: req.photoLookupMs, databaseMs: req.photoDatabaseMs,
    }));
  };
  res.on('finish', () => {
    logRequest();
  });
  res.on('close', () => { if (!res.writableFinished) logRequest(true); });
  next();
});
app.use(express.json());
addPiiResponseSanitizer(app);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/health', (req, res) => res.json({ service: 'visits-service', status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ service: 'visits-service', status: 'ready' });
  } catch (error) {
    console.error('VisitsService readiness check failed:', error.code || error.name);
    res.status(503).json({ service: 'visits-service', status: 'not_ready' });
  }
});
app.use('/api/v1/visits', require('./routes/visits'));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`VisitsService running on port ${PORT}`));

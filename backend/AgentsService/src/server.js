const express = require('express');
const helmet = require('helmet');
const dotenv = require('dotenv');
dotenv.config();
const prisma = require('./utils/prisma');
const { addPiiResponseSanitizer } = require('../../shared/pii');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '12mb' }));
addPiiResponseSanitizer(app);

app.get('/health', (req, res) => res.json({ service: 'agents-service', status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ service: 'agents-service', status: 'ready' });
  } catch (error) {
    console.error('AgentsService readiness check failed:', error.code || error.name);
    res.status(503).json({ service: 'agents-service', status: 'not_ready' });
  }
});

app.use('/api/v1/agents/bulk-import', require('./routes/bulkImport'));
app.use('/api/v1/agents', require('./routes/agents'));
app.use('/api/v1/territories', require('./routes/territories'));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`AgentsService running on port ${PORT}`));

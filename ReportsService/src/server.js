const express = require('express');
const helmet = require('helmet');
const dotenv = require('dotenv');
dotenv.config();
const prisma = require('./utils/prisma');
const { addPiiResponseSanitizer } = require('../../shared/pii');

const app = express();
app.use(helmet());
app.use(express.json());
addPiiResponseSanitizer(app);

app.get('/health', (req, res) => res.json({ service: 'reports-service', status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ service: 'reports-service', status: 'ready' });
  } catch (error) {
    console.error('ReportsService readiness check failed:', error.code || error.name);
    res.status(503).json({ service: 'reports-service', status: 'not_ready' });
  }
});
app.use('/api/v1/reports', require('./routes/reports'));
app.use('/api/v1/config', require('./routes/config'));

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => console.log(`ReportsService running on port ${PORT}`));

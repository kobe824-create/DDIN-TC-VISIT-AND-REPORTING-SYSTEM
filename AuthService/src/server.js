const express = require('express');
const helmet = require('helmet');
const dotenv = require('dotenv');
dotenv.config();
const prisma = require('./utils/prisma');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '12mb' }));

app.get('/health', (req, res) => res.json({ service: 'auth-service', status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ service: 'auth-service', status: 'ready' });
  } catch (error) {
    console.error('AuthService readiness check failed:', error.code || error.name);
    res.status(503).json({ service: 'auth-service', status: 'not_ready' });
  }
});

app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/users', require('./routes/users'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AuthService running on port ${PORT}`));

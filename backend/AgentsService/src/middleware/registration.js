module.exports = function requireAgentRegistrationEnabled(_req, res, next) {
  if (process.env.AGENT_REGISTRATION_ENABLED === 'true') return next();
  return res.status(503).json({ error: 'Agent creation and bulk registration are temporarily disabled pending the agent API.' });
};

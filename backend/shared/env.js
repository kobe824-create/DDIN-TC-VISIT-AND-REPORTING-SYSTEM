const path = require('path');

function loadServiceEnv(serviceDirectory, dotenv) {
  // Load service-specific values first; fill missing values from backend root.
  // Existing process variables (including Docker Compose's environment) win.
  dotenv.config({ path: path.resolve(serviceDirectory, '..', '.env') });
  dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
}

module.exports = { loadServiceEnv };

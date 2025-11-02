// Catch-all serverless function for all routes (health, admin, api)
// This handles all non-file routes and passes them to Express
const app = require('../backend/server.js');

module.exports = app;


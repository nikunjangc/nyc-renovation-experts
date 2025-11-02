// Health check serverless function
const app = require('./index.js');

module.exports = (req, res) => {
  // Handle /health request
  req.url = '/health';
  req.path = '/health';
  app(req, res);
};


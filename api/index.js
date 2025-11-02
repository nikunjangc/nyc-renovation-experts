// Test: Simple handler to verify serverless function works
module.exports = (req, res) => {
  // For testing - return basic response
  res.status(200).json({ 
    message: 'Serverless function is working!',
    path: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  });
};

// Health check serverless function
// Simple endpoint that doesn't require Express routing
module.exports = (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'AI Quote API is running',
    timestamp: new Date().toISOString()
  });
};


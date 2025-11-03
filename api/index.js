// Secure Backend API Server for AI Quote Assistant
// This keeps your OpenAI API key safe on the server

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { logUsage, getUsageStats, getRecentLogs, clearLogs, calculateCost } = require('./usage-logger');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Log all requests for debugging in Vercel
app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url} - ${req.path}`);
  next();
});

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

// Rate limiting (basic - consider using express-rate-limit for production)
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 5; // 5 requests per minute per IP

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const record = rateLimit.get(ip);
  
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }
  
  if (record.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ 
      error: 'Too many requests. Please try again later.' 
    });
  }
  
  record.count++;
  next();
}

// Validate API key is set (supports both OpenAI and DeepSeek)
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.DEEPSEEK_API_KEY 
  ? 'https://api.deepseek.com/v1' 
  : 'https://api.openai.com/v1';

if (!API_KEY) {
  console.error('ERROR: API key environment variable is not set!');
  console.error('Please create a .env file with either:');
  console.error('  - DEEPSEEK_API_KEY (for DeepSeek)');
  console.error('  - OPENAI_API_KEY (for OpenAI)');
  process.exit(1);
}

const API_PROVIDER = process.env.DEEPSEEK_API_KEY ? 'DeepSeek' : 'OpenAI';
console.log(`✅ Using ${API_PROVIDER} API`);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'AI Quote API is running' });
});

// Health check via /api/health (for Vercel compatibility)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'AI Quote API is running' });
});

// Simple admin authentication middleware
const adminAuth = (req, res, next) => {
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader === `Bearer ${adminPassword}`) {
    return next();
  }
  
  res.status(401).json({ error: 'Unauthorized. Admin password required.' });
};

// Admin endpoints
app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const stats = await getUsageStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.get('/admin/logs', adminAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await getRecentLogs(limit);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

app.post('/admin/clear-logs', adminAuth, async (req, res) => {
  try {
    await clearLogs();
    res.json({ message: 'Logs cleared successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

// AI Project Analysis Endpoint
app.post('/api/analyze-project', rateLimiter, async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || req.connection.remoteAddress;
  
  try {
    const { projectType, borough, squareFootage, budgetRange, description } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'Project description is required' });
    }

    const response = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4',
        messages: [
          {
            role: 'system',
            content: `You are RenoBot, an AI renovation assistant for NYC Renovation Experts. Analyze renovation project descriptions and provide:
1. A brief scope of work
2. Key considerations
3. Suggested timeline
4. Cost factors to consider

Be helpful, professional, and concise. Focus on renovation in NYC context.`
          },
          {
            role: 'user',
            content: `Project Type: ${projectType || 'Not specified'}
Location: ${borough || 'Not specified'}
Square Footage: ${squareFootage || 'Not specified'}
Budget: ${budgetRange || 'Not specified'}

Project Description: ${description}`
          }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`${API_PROVIDER} API Error:`, errorData);
      return res.status(response.status).json({ 
        error: 'Failed to analyze project',
        details: process.env.NODE_ENV === 'development' ? errorData : undefined
      });
    }

    const data = await response.json();
    const responseTime = Date.now() - startTime;
    const tokensUsed = data.usage?.total_tokens || 0;
    const cost = calculateCost(tokensUsed, process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4');
    
    // Log successful usage
    await logUsage({
      endpoint: '/api/analyze-project',
      ip: clientIp,
      projectType,
      tokensUsed,
      cost,
      model: process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4',
      success: true,
      responseTime
    });
    
    res.json({ analysis: data.choices[0].message.content });
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('Server Error:', error);
    
    // Log failed usage
    await logUsage({
      endpoint: '/api/analyze-project',
      ip: clientIp,
      tokensUsed: 0,
      cost: 0,
      model: process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4',
      success: false,
      error: error.message,
      responseTime
    });
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AI Cost Estimation Endpoint
app.post('/api/estimate-cost', rateLimiter, async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || req.connection.remoteAddress;
  
  try {
    const { 
      projectType, 
      borough, 
      squareFootage, 
      budgetRange, 
      timeline, 
      description,
      baseEstimate 
    } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'Project description is required' });
    }

    const response = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4',
        messages: [
          {
            role: 'system',
            content: `You are an expert renovation cost estimator for NYC. Based on project descriptions, analyze the complexity, materials, and scope to provide accurate cost estimates. 

NYC Average Costs:
- Kitchen: $15K-$75K ($150/sqft base)
- Bathroom: $8K-$35K ($200/sqft base)
- Full Home: $50K-$200K ($100/sqft base)
- Basement: $20K-$80K ($80/sqft base)

Borough Multipliers:
- Manhattan: +30%
- Brooklyn: +10%
- Queens: Base
- Bronx: -10%
- Staten Island: -10%

Factors to consider:
- Luxury finishes add 50-100%
- Custom work adds 30-50%
- Permit complexity affects timeline/cost
- Structural changes significantly increase cost
- High-end appliances/materials increase cost

Respond ONLY with a JSON object in this exact format:
{"min": 25000, "max": 45000, "reasoning": "Brief explanation of estimate"}

Base estimate provided: $${baseEstimate?.min?.toLocaleString() || 'N/A'} - $${baseEstimate?.max?.toLocaleString() || 'N/A'}`
          },
          {
            role: 'user',
            content: `Project Type: ${projectType || 'Not specified'}
Borough: ${borough || 'Not specified'}
Square Footage: ${squareFootage || 'Not specified'}
Budget Range: ${budgetRange || 'Not specified'}
Timeline: ${timeline || 'Not specified'}

Project Description: ${description}

Analyze this project and provide an accurate cost estimate range considering NYC market rates, project complexity, and materials likely needed.`
          }
        ],
        max_tokens: 300,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`${API_PROVIDER} API Error:`, errorData);
      return res.status(response.status).json({ 
        error: 'Failed to estimate cost',
        details: process.env.NODE_ENV === 'development' ? errorData : undefined
      });
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;
    const responseTime = Date.now() - startTime;
    const tokensUsed = data.usage?.total_tokens || 0;
    const cost = calculateCost(tokensUsed, process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4');
    
    // Parse JSON response
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const costData = JSON.parse(jsonMatch[0]);
        
        // Log successful usage
        await logUsage({
          endpoint: '/api/estimate-cost',
          ip: clientIp,
          projectType,
          tokensUsed,
          cost,
          model: process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4',
          success: true,
          responseTime
        });
        
        return res.json({
          min: Math.round(costData.min / 1000) * 1000,
          max: Math.round(costData.max / 1000) * 1000,
          reasoning: costData.reasoning || ''
        });
      }
    } catch (parseError) {
      // Try to extract numbers from text if JSON parsing fails
      const numbers = aiResponse.match(/\$?([\d,]+)/g);
      if (numbers && numbers.length >= 2) {
        const min = parseInt(numbers[0].replace(/[$,]/g, ''));
        const max = parseInt(numbers[1].replace(/[$,]/g, ''));
        
        // Log successful usage
        await logUsage({
          endpoint: '/api/estimate-cost',
          ip: clientIp,
          projectType,
          tokensUsed,
          cost,
          model: process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4',
          success: true,
          responseTime
        });
        
        return res.json({
          min: Math.round(min / 1000) * 1000,
          max: Math.round(max / 1000) * 1000,
          reasoning: aiResponse
        });
      }
    }
    
    throw new Error('Could not parse AI response');
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('Server Error:', error);
    
    // Log failed usage
    await logUsage({
      endpoint: '/api/estimate-cost',
      ip: clientIp,
      tokensUsed: 0,
      cost: 0,
      model: process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : 'gpt-4',
      success: false,
      error: error.message,
      responseTime
    });
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export for Vercel serverless function
// For local development, start the server normally
if (require.main === module) {
  // Running directly (local development)
  app.listen(PORT, () => {
    console.log(`🚀 Secure AI Quote API Server running on port ${PORT}`);
    console.log(`✅ Using ${API_PROVIDER} API`);
    console.log(`✅ API Key is safely stored server-side`);
    console.log(`🔒 CORS enabled for: ${process.env.ALLOWED_ORIGIN || 'http://localhost:3000'}`);
  });
}

// Catch-all for unmatched routes - return 404 for debugging
app.use((req, res) => {
  console.log(`[404] Unmatched route: ${req.method} ${req.url} - ${req.path}`);
  res.status(404).json({ 
    error: 'Not found', 
    path: req.path,
    url: req.url,
    method: req.method 
  });
});

// Export for Vercel
module.exports = app;


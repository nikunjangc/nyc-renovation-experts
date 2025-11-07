// Secure Backend API Server for AI Quote Assistant
// This keeps your OpenAI API key safe on the server

const express = require('express');
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

// CORS Configuration - Allow multiple origins
const allowedOrigins = [
  'https://www.nycrenovationexperts.com',
  'https://nycrenovationexperts.com',
  'https://nikunjangc.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
  process.env.ALLOWED_ORIGIN
].filter(Boolean); // Remove undefined values

// CORS helper function to add headers to responses
// IMPORTANT: Cannot use '*' with credentials: true - must use specific origin
function setCORSHeaders(req, res) {
  const origin = req.get('origin');
  
  if (origin) {
    // Check if origin is in allowed list
    if (allowedOrigins.some(allowed => origin === allowed || origin.startsWith(allowed))) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    } else {
      // For debugging - allow the origin that's being used (with warning)
      console.log(`[CORS] WARNING: Allowing origin: ${origin} (not in strict list)`);
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }
  } else {
    // No origin header - use * but cannot use credentials
    res.header('Access-Control-Allow-Origin', '*');
    // Note: Cannot set Access-Control-Allow-Credentials with *
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
}

// NOTE: We handle CORS manually via setCORSHeaders() and OPTIONS handler
// The cors() package middleware was removed to avoid conflicts in Vercel serverless environment
// All CORS headers are set explicitly in setCORSHeaders() and the OPTIONS handler

// Handle OPTIONS preflight requests explicitly - MUST be before other routes
// This is critical for CORS preflight requests from browsers
// NOTE: Cannot use '*' with credentials: true - must use specific origin
app.options('*', (req, res) => {
  const origin = req.get('origin');
  console.log(`[OPTIONS] Preflight request from: ${origin}`);
  console.log(`[OPTIONS] Allowed origins: ${allowedOrigins.join(', ')}`);
  
  // Set common CORS headers
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle origin - CRITICAL: Cannot use '*' with credentials
  if (origin) {
    // Check if origin is in allowed list
    if (allowedOrigins.some(allowed => origin === allowed || origin.startsWith(allowed))) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      console.log(`[OPTIONS] Allowing origin: ${origin} (in allowed list)`);
    } else {
      // Origin not in strict list - but allow it for debugging (with credentials)
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      console.log(`[OPTIONS] WARNING: Allowing origin: ${origin} (not in strict list, debugging mode)`);
    }
  } else {
    // No origin header (e.g., Postman, curl) - use '*' but NO credentials
    res.header('Access-Control-Allow-Origin', '*');
    // Do NOT set Access-Control-Allow-Credentials when using '*'
    console.log(`[OPTIONS] No origin header - using '*' (no credentials)`);
  }
  
  res.status(200).end();
  return; // Explicitly stop execution
});

// Middleware to set CORS headers on ALL requests (moved early to ensure it runs)
// This ensures CORS headers are always present, even for error responses
app.use((req, res, next) => {
  // Set CORS headers for all responses - this runs before routes
  setCORSHeaders(req, res);
  next();
});

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
  setCORSHeaders(req, res);
  res.json({ status: 'ok', message: 'AI Quote API is running' });
});

// Health check via /api/health (for Vercel compatibility)
app.get('/api/health', (req, res) => {
  setCORSHeaders(req, res);
  res.json({ status: 'ok', message: 'AI Quote API is running' });
});

// Simple admin authentication middleware
const adminAuth = (req, res, next) => {
  // CRITICAL: Skip authentication for OPTIONS preflight requests
  if (req.method === 'OPTIONS') {
    console.log('[Admin Auth] Skipping auth for OPTIONS request');
    return next(); // Let OPTIONS handler process it
  }
  
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const authHeader = req.headers.authorization;
  
  // Trim any whitespace from admin password
  const trimmedPassword = adminPassword.trim();
  
  // Debug logging (only in development)
  if (process.env.NODE_ENV === 'development') {
    console.log('Admin auth check:', {
      hasHeader: !!authHeader,
      headerLength: authHeader?.length,
      passwordLength: trimmedPassword.length,
      passwordSet: !!process.env.ADMIN_PASSWORD
    });
  }
  
  if (authHeader && authHeader.trim() === `Bearer ${trimmedPassword}`) {
    return next();
  }
  
  res.status(401).json({ error: 'Unauthorized. Admin password required.' });
};

// Admin endpoints
app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    // Set CORS headers explicitly
    setCORSHeaders(req, res);
    
    // Log CORS headers for debugging
    console.log(`[Admin Stats] Origin: ${req.get('origin')}, Referer: ${req.get('referer')}`);
    const stats = await getUsageStats();
    res.json(stats);
  } catch (error) {
    console.error('[Admin Stats] Error:', error);
    setCORSHeaders(req, res);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.get('/admin/logs', adminAuth, async (req, res) => {
  try {
    setCORSHeaders(req, res);
    
    const limit = parseInt(req.query.limit) || 50;
    const source = req.query.source; // Filter by source (e.g., 'quote.html')
    let logs = await getRecentLogs(limit * 2); // Get more to filter
    
    // Filter by source if specified
    if (source) {
      logs = logs.filter(log => log.source === source);
    }
    
    // Limit results
    logs = logs.slice(0, limit);
    
    res.json({ logs });
  } catch (error) {
    setCORSHeaders(req, res);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

app.post('/admin/clear-logs', adminAuth, async (req, res) => {
  try {
    setCORSHeaders(req, res);
    await clearLogs();
    res.json({ message: 'Logs cleared successfully' });
  } catch (error) {
    setCORSHeaders(req, res);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

// AI Project Analysis Endpoint
app.post('/api/analyze-project', rateLimiter, async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || req.connection.remoteAddress;
  const referer = req.get('referer') || req.get('referrer') || '';
  const userAgent = req.get('user-agent') || '';
  
  // Detect if request came from quote.html
  const isFromQuotePage = referer.includes('quote.html') || referer.includes('/quote');
  
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
      source: isFromQuotePage ? 'quote.html' : 'other',
      referer: referer,
      userAgent: userAgent,
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
      source: isFromQuotePage ? 'quote.html' : 'other',
      referer: referer,
      userAgent: userAgent,
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
  const referer = req.get('referer') || req.get('referrer') || '';
  const userAgent = req.get('user-agent') || '';
  
  // Detect if request came from quote.html
  const isFromQuotePage = referer.includes('quote.html') || referer.includes('/quote');
  
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
          source: isFromQuotePage ? 'quote.html' : 'other',
          referer: referer,
          userAgent: userAgent,
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
          source: isFromQuotePage ? 'quote.html' : 'other',
          referer: referer,
          userAgent: userAgent,
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
      source: isFromQuotePage ? 'quote.html' : 'other',
      referer: referer,
      userAgent: userAgent,
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
    console.log(`🔒 CORS enabled for: ${allowedOrigins.join(', ')}`);
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

// CORS configuration updated Thu Nov  6 19:46:10 EST 2025

// API Usage Logger
const fs = require('fs').promises;
const path = require('path');

const LOG_FILE = path.join(__dirname, 'logs', 'api-usage.json');
const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure logs directory exists
async function ensureLogsDir() {
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating logs directory:', error);
  }
}

// Initialize log file if it doesn't exist
async function initLogFile() {
  await ensureLogsDir();
  try {
    await fs.access(LOG_FILE);
  } catch {
    await fs.writeFile(LOG_FILE, JSON.stringify({ logs: [], stats: {} }, null, 2));
  }
}

// Log API usage
async function logUsage(data) {
  await ensureLogsDir();
  
  try {
    const logData = JSON.parse(await fs.readFile(LOG_FILE, 'utf8'));
    
    const logEntry = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      endpoint: data.endpoint,
      ip: data.ip,
      projectType: data.projectType || null,
      tokensUsed: data.tokensUsed || 0,
      cost: data.cost || 0,
      model: data.model || 'unknown',
      success: data.success !== false,
      error: data.error || null,
      responseTime: data.responseTime || 0
    };
    
    logData.logs.push(logEntry);
    
    // Keep only last 1000 logs
    if (logData.logs.length > 1000) {
      logData.logs = logData.logs.slice(-1000);
    }
    
    // Update statistics
    if (!logData.stats) {
      logData.stats = {
        totalCalls: 0,
        totalTokens: 0,
        totalCost: 0,
        successfulCalls: 0,
        failedCalls: 0,
        byEndpoint: {},
        byDate: {}
      };
    }
    
    logData.stats.totalCalls++;
    logData.stats.totalTokens += logEntry.tokensUsed;
    logData.stats.totalCost += logEntry.cost;
    
    if (logEntry.success) {
      logData.stats.successfulCalls++;
    } else {
      logData.stats.failedCalls++;
    }
    
    // Stats by endpoint
    if (!logData.stats.byEndpoint[logEntry.endpoint]) {
      logData.stats.byEndpoint[logEntry.endpoint] = {
        count: 0,
        tokens: 0,
        cost: 0
      };
    }
    logData.stats.byEndpoint[logEntry.endpoint].count++;
    logData.stats.byEndpoint[logEntry.endpoint].tokens += logEntry.tokensUsed;
    logData.stats.byEndpoint[logEntry.endpoint].cost += logEntry.cost;
    
    // Stats by date
    const date = new Date(logEntry.timestamp).toISOString().split('T')[0];
    if (!logData.stats.byDate[date]) {
      logData.stats.byDate[date] = {
        calls: 0,
        tokens: 0,
        cost: 0
      };
    }
    logData.stats.byDate[date].calls++;
    logData.stats.byDate[date].tokens += logEntry.tokensUsed;
    logData.stats.byDate[date].cost += logEntry.cost;
    
    await fs.writeFile(LOG_FILE, JSON.stringify(logData, null, 2));
  } catch (error) {
    console.error('Error logging usage:', error);
  }
}

// Get usage statistics
async function getUsageStats() {
  try {
    const logData = JSON.parse(await fs.readFile(LOG_FILE, 'utf8'));
    return logData;
  } catch (error) {
    console.error('Error reading usage stats:', error);
    return { logs: [], stats: {} };
  }
}

// Get recent logs
async function getRecentLogs(limit = 50) {
  try {
    const logData = JSON.parse(await fs.readFile(LOG_FILE, 'utf8'));
    return logData.logs.slice(-limit).reverse(); // Most recent first
  } catch (error) {
    console.error('Error reading logs:', error);
    return [];
  }
}

// Clear logs (admin function)
async function clearLogs() {
  await ensureLogsDir();
  await fs.writeFile(LOG_FILE, JSON.stringify({ logs: [], stats: {} }, null, 2));
}

// Calculate DeepSeek cost (approximate)
function calculateCost(tokens, model = 'deepseek-chat') {
  // DeepSeek pricing (as of 2024)
  // $0.00014 per 1K tokens input, $0.00028 per 1K tokens output
  // This is an approximation - adjust based on actual usage
  const inputTokens = tokens * 0.5; // Estimate 50/50 split
  const outputTokens = tokens * 0.5;
  const inputCost = (inputTokens / 1000) * 0.00014;
  const outputCost = (outputTokens / 1000) * 0.00028;
  return inputCost + outputCost;
}

// Initialize on module load
initLogFile();

module.exports = {
  logUsage,
  getUsageStats,
  getRecentLogs,
  clearLogs,
  calculateCost
};


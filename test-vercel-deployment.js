#!/usr/bin/env node

/**
 * Vercel Deployment Test
 * Tests backend endpoints after Vercel deployment
 * Usage: node test-vercel-deployment.js https://your-vercel-url.vercel.app
 */

const https = require('https');
const http = require('http');

const VERCEL_URL = process.argv[2] || process.env.VERCEL_URL || 'https://www.nycrenovationexperts.com';

const tests = [
  {
    name: 'Health Check - /health',
    path: '/health',
    method: 'GET',
    expectedStatus: 200,
    expectedBody: { status: 'ok', message: 'AI Quote API is running' }
  },
  {
    name: 'Health Check - /api/health',
    path: '/api/health',
    method: 'GET',
    expectedStatus: 200,
    expectedBody: { status: 'ok', message: 'AI Quote API is running' }
  },
  {
    name: 'Admin Stats (should require auth)',
    path: '/admin/stats',
    method: 'GET',
    expectedStatus: 401, // Should be unauthorized
    expectJSON: true
  }
];

let testsPassed = 0;
let testsFailed = 0;

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    
    const req = client.request(reqOptions, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const body = data ? JSON.parse(data) : data;
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: body
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    
    req.end();
  });
}

async function runTest(test) {
  const url = `${VERCEL_URL}${test.path}`;
  
  try {
    const response = await makeRequest(url, {
      method: test.method,
      headers: {
        'Content-Type': 'application/json',
        ...(test.auth ? { 'Authorization': `Bearer ${test.auth}` } : {})
      },
      body: test.body
    });
    
    // Check status code
    if (response.statusCode !== test.expectedStatus) {
      throw new Error(`Expected status ${test.expectedStatus}, got ${response.statusCode}`);
    }
    
    // Check body if specified
    if (test.expectedBody) {
      const bodyMatch = JSON.stringify(response.body) === JSON.stringify(test.expectedBody);
      if (!bodyMatch) {
        throw new Error(`Body mismatch. Expected: ${JSON.stringify(test.expectedBody)}, Got: ${JSON.stringify(response.body)}`);
      }
    }
    
    // Check if JSON response (not HTML)
    if (test.expectJSON || test.expectedBody) {
      if (typeof response.body === 'string' && response.body.includes('<!DOCTYPE html>')) {
        throw new Error(`Got HTML page instead of JSON. This means request went to GitHub Pages, not Vercel.`);
      }
    }
    
    return { success: true, response };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function runAllTests() {
  console.log('🧪 Testing Vercel Backend Deployment\n');
  console.log(`📍 Testing URL: ${VERCEL_URL}\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  for (const test of tests) {
    process.stdout.write(`Testing: ${test.name}... `);
    
    const result = await runTest(test);
    
    if (result.success) {
      console.log('✅ PASSED');
      testsPassed++;
    } else {
      console.log(`❌ FAILED`);
      console.log(`   Error: ${result.error}`);
      if (result.response) {
        console.log(`   Status: ${result.response.statusCode}`);
        if (typeof result.response.body === 'object') {
          console.log(`   Body: ${JSON.stringify(result.response.body).substring(0, 100)}...`);
        } else {
          console.log(`   Body (first 100 chars): ${String(result.response.body).substring(0, 100)}...`);
        }
      }
      testsFailed++;
    }
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n📊 Test Results:`);
  console.log(`   ✅ Passed: ${testsPassed}`);
  console.log(`   ❌ Failed: ${testsFailed}`);
  console.log(`   📝 Total:  ${tests.length}\n`);
  
  if (testsFailed === 0) {
    console.log('✅ All tests passed! Backend is working correctly.\n');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed. Please check the errors above.\n');
    process.exit(1);
  }
}

// Run tests
runAllTests().catch((error) => {
  console.error('❌ Test runner error:', error);
  process.exit(1);
});


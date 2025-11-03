#!/usr/bin/env node

/**
 * Backend Health Check Test
 * Tests the Express app endpoints locally
 * Can be run manually: node test-backend.js
 */

const http = require('http');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || 'localhost';

// Test endpoints
const tests = [
  {
    name: 'Health Check Endpoint',
    path: '/health',
    method: 'GET',
    expectedStatus: 200,
    expectedBody: { status: 'ok', message: 'AI Quote API is running' }
  },
  {
    name: 'Health Check (via /api/health)',
    path: '/api/health',
    method: 'GET',
    expectedStatus: 200,
    expectedBody: { status: 'ok', message: 'AI Quote API is running' }
  },
  {
    name: 'Admin Stats (should require auth)',
    path: '/admin/stats',
    method: 'GET',
    expectedStatus: 401, // Should be unauthorized without auth
    expectJSON: true
  }
];

let testsPassed = 0;
let testsFailed = 0;

function makeRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const body = data ? JSON.parse(data) : null;
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
    req.end();
  });
}

async function runTest(test) {
  const options = {
    hostname: HOST,
    port: PORT,
    path: test.path,
    method: test.method,
    headers: {
      'Content-Type': 'application/json'
    }
  };
  
  if (test.auth) {
    options.headers['Authorization'] = `Bearer ${test.auth}`;
  }
  
  try {
    const response = await makeRequest(options);
    
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
    
    // Check if JSON response
    if (test.expectJSON && typeof response.body !== 'object') {
      throw new Error(`Expected JSON response, got: ${typeof response.body}`);
    }
    
    return { success: true, response };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function runTests() {
  console.log('🧪 Starting Backend Tests...\n');
  console.log(`📍 Testing: http://${HOST}:${PORT}\n`);
  
  // First, try to load the Express app
  let app;
  try {
    console.log('📦 Loading Express app...');
    app = require('./api/index.js');
    console.log('✅ Express app loaded\n');
  } catch (error) {
    console.error('❌ Failed to load Express app:', error.message);
    console.error('\n💡 Make sure you have installed dependencies:');
    console.error('   cd api && npm install\n');
    process.exit(1);
  }
  
  // Start server if not already running
  const server = app.listen(PORT, HOST, async () => {
    console.log(`🚀 Server started on http://${HOST}:${PORT}\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Run tests
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
          console.log(`   Body: ${JSON.stringify(result.response.body).substring(0, 100)}...`);
        }
        testsFailed++;
      }
    }
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`\n📊 Test Results:`);
    console.log(`   ✅ Passed: ${testsPassed}`);
    console.log(`   ❌ Failed: ${testsFailed}`);
    console.log(`   📝 Total:  ${tests.length}\n`);
    
    // Close server
    server.close(() => {
      if (testsFailed === 0) {
        console.log('✅ All tests passed!\n');
        process.exit(0);
      } else {
        console.log('❌ Some tests failed\n');
        process.exit(1);
      }
    });
  });
  
  // Handle errors
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  Port ${PORT} is already in use.`);
      console.log('💡 Server might already be running. Running tests against existing server...\n');
      
      // Run tests against existing server
      (async () => {
        for (const test of tests) {
          process.stdout.write(`Testing: ${test.name}... `);
          const result = await runTest(test);
          
          if (result.success) {
            console.log('✅ PASSED');
            testsPassed++;
          } else {
            console.log(`❌ FAILED`);
            console.log(`   Error: ${result.error}`);
            testsFailed++;
          }
        }
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`\n📊 Test Results:`);
        console.log(`   ✅ Passed: ${testsPassed}`);
        console.log(`   ❌ Failed: ${testsFailed}`);
        console.log(`   📝 Total:  ${tests.length}\n`);
        
        if (testsFailed === 0) {
          console.log('✅ All tests passed!\n');
          process.exit(0);
        } else {
          console.log('❌ Some tests failed\n');
          process.exit(1);
        }
      })();
    } else {
      console.error('❌ Server error:', err);
      process.exit(1);
    }
  });
}

// Run tests
runTests().catch((error) => {
  console.error('❌ Test runner error:', error);
  process.exit(1);
});


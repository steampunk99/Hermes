// scripts/testSecurity.js
const axios = require('axios');

const BASE_URL = 'http://localhost:4567';
let authToken = '';

// Helper function to make authenticated requests
const makeRequest = async (method, endpoint, data = null, headers = {}) => {
  try {
    const config = {
      method,
      url: `${BASE_URL}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        ...headers
      }
    };
    
    if (data) {
      config.data = data;
    }
    
    const response = await axios(config);
    return { success: true, data: response.data, status: response.status };
  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data || error.message, 
      status: error.response?.status 
    };
  }
};

// Login to get auth token
const login = async () => {
  console.log('🔐 Logging in...');
  const result = await makeRequest('POST', '/auth/login', {
    email: 'loulater99@gmail.com', // Replace with your admin email
    password: 'Password123!'   // Replace with your admin password
  });
  
  if (result.success) {
    authToken = result.data.token;
    console.log('✅ Login successful');
    return true;
  } else {
    console.log('❌ Login failed:', result.error);
    return false;
  }
};

// Test rate limiting
const testRateLimit = async () => {
  console.log('\n🚨 Testing Rate Limiting...');
  
  const endpoint = '/admin/payments/pending';
  const requests = [];
  
  // Send 10 rapid requests (should trigger rate limit)
  for (let i = 0; i < 10; i++) {
    requests.push(makeRequest('GET', endpoint));
  }
  
  const results = await Promise.all(requests);
  const rateLimited = results.filter(r => r.status === 429);
  
  console.log(`📊 Sent 10 requests, ${rateLimited.length} were rate limited`);
  if (rateLimited.length > 0) {
    console.log('✅ Rate limiting is working');
    console.log('📝 Rate limit response:', rateLimited[0].error);
  } else {
    console.log('⚠️ Rate limiting may not be working properly');
  }
};

// Test cooldown period
const testCooldown = async () => {
  console.log('\n❄️ Testing Cooldown Period...');
  
  const endpoint = '/admin/payments/history';
  
  // First request
  const result1 = await makeRequest('GET', endpoint);
  console.log(`📤 First request: ${result1.success ? 'Success' : 'Failed'}`);
  
  // Immediate second request (should be blocked by cooldown)
  const result2 = await makeRequest('GET', endpoint);
  console.log(`📤 Immediate second request: ${result2.success ? 'Success' : 'Blocked'}`);
  
  if (result2.status === 429) {
    console.log('✅ Cooldown is working');
    console.log('📝 Cooldown response:', result2.error);
  } else {
    console.log('⚠️ Cooldown may not be working properly');
  }
};

// Test suspicious pattern detection
const testSuspiciousPatterns = async () => {
  console.log('\n🕵️ Testing Suspicious Pattern Detection...');
  
  const endpoints = [
    '/admin/payments/pending',
    '/admin/payments/history',
    '/security/status',
    '/transactions/history',
    '/user/profile'
  ];
  
  // Rapid fire requests across multiple endpoints
  const requests = [];
  for (let i = 0; i < 25; i++) {
    const endpoint = endpoints[i % endpoints.length];
    requests.push(makeRequest('GET', endpoint));
    
    // Small delay to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  const results = await Promise.all(requests);
  const blocked = results.filter(r => r.status === 403);
  
  console.log(`📊 Sent 25 requests across ${endpoints.length} endpoints`);
  console.log(`🚫 ${blocked.length} requests were blocked for suspicious patterns`);
  
  if (blocked.length > 0) {
    console.log('✅ Suspicious pattern detection is working');
    console.log('📝 Pattern detection response:', blocked[0].error);
  }
};

// Test security dashboard
const testSecurityDashboard = async () => {
  console.log('\n📊 Testing Security Dashboard...');
  
  const dashboard = await makeRequest('GET', '/security/dashboard');
  if (dashboard.success) {
    console.log('✅ Security dashboard accessible');
    console.log('📈 Dashboard data:', JSON.stringify(dashboard.data, null, 2));
  } else {
    console.log('❌ Security dashboard failed:', dashboard.error);
  }
  
  const flagged = await makeRequest('GET', '/security/flagged');
  if (flagged.success) {
    console.log('✅ Flagged users list accessible');
    console.log('🚩 Flagged users:', flagged.data.total);
  } else {
    console.log('❌ Flagged users list failed:', flagged.error);
  }
};

// Test financial route security
const testFinancialSecurity = async () => {
  console.log('\n💰 Testing Financial Route Security...');
  
  const financialEndpoints = [
    '/transactions/mint',
    '/transactions/redeem',
    '/transactions/send'
  ];
  
  for (const endpoint of financialEndpoints) {
    console.log(`\n🔒 Testing ${endpoint}...`);
    
    // Send multiple requests rapidly
    const requests = [];
    for (let i = 0; i < 15; i++) {
      requests.push(makeRequest('POST', endpoint, { amount: 1000 }));
    }
    
    const results = await Promise.all(requests);
    const rateLimited = results.filter(r => r.status === 429);
    const blocked = results.filter(r => r.status === 403);
    
    console.log(`📊 ${endpoint}: ${rateLimited.length} rate limited, ${blocked.length} blocked`);
  }
};

// Main test function
const runSecurityTests = async () => {
  console.log('🛡️ HERMES SECURITY TESTING SUITE');
  console.log('================================\n');
  
  // Login first
  const loginSuccess = await login();
  if (!loginSuccess) {
    console.log('❌ Cannot proceed without authentication');
    return;
  }
  
  try {
    await testRateLimit();
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    await testCooldown();
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    await testSuspiciousPatterns();
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    await testFinancialSecurity();
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    await testSecurityDashboard();
    
    console.log('\n🎉 Security testing completed!');
    console.log('📝 Check your server logs for detailed security events');
    
  } catch (error) {
    console.error('❌ Security testing failed:', error);
  }
};

// Run tests if this script is executed directly
if (require.main === module) {
  runSecurityTests();
}

module.exports = { runSecurityTests };

const jwt = require('jsonwebtoken');

// Mock the verifyJwtToken function from index.ts
function verifyJwtToken(token) {
  try {
    // This is a simplified version of the actual function
    const JWT_SECRET = 'enzo_jwt_secret_4b9f2a83d1c5e67890abcdef1234567890abcdef';
    const JWT_ISSUER = 'enzo';
    const JWT_AUDIENCE = 'enzo-app';
    
    const user = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    
    if (
      typeof user !== 'object' ||
      user === null ||
      typeof user.sub !== 'string' ||
      user.sub.trim() === '' ||
      typeof user.exp !== 'number' ||
      !Number.isFinite(user.exp) ||
      user.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    
    return user;
  } catch (err) {
    console.log('JWT verification error:', err.message);
    return null;
  }
}

const JWT_SECRET = 'enzo_jwt_secret_4b9f2a83d1c5e67890abcdef1234567890abcdef';
const FAKE_PAYLOAD = { sub: 'testuser', email: 'test@example.com', exp: Math.floor(Date.now() / 1000) + 3600 };

console.log('=== JWT Algorithm Confusion Test ===\n');

// Test 1: Create a valid HS256 token
console.log('1. Creating valid HS256 token:');
const validToken = jwt.sign(FAKE_PAYLOAD, JWT_SECRET, { algorithm: 'HS256' });
console.log('Token:', validToken);
const validResult = verifyJwtToken(validToken);
console.log('Verification result:', validResult ? '✅ SUCCESS' : '❌ FAILED', '\n');

// Test 2: Attempt to use 'none' algorithm
console.log('2. Testing "none" algorithm attack:');
const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64');
const payload = Buffer.from(JSON.stringify(FAKE_PAYLOAD)).toString('base64');
const noneToken = `${noneHeader}.${payload}.`; // Empty signature
console.log('Attempting to verify token with "none" algorithm:');
console.log('Token:', noneToken);
const noneResult = verifyJwtToken(noneToken);
console.log('Verification result:', noneResult ? '✅ ACCEPTED (VULNERABLE)' : '❌ REJECTED (SECURE)', '\n');

// Test 3: Modify existing token to change algorithm from HS256 to none
console.log('3. Testing algorithm change from HS256 to "none":');
const parts = validToken.split('.');
const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
console.log('Original header:', header);
const modifiedHeader = Buffer.from(JSON.stringify({ ...header, alg: 'none' })).toString('base64');
const modifiedToken = `${modifiedHeader}.${parts[1]}.`; // Keep original payload, empty signature
console.log('Modified token with "none" algorithm:');
console.log('Token:', modifiedToken);
const modifiedResult = verifyJwtToken(modifiedToken);
console.log('Verification result:', modifiedResult ? '✅ ACCEPTED (VULNERABLE)' : '❌ REJECTED (SECURE)', '\n');

console.log('=== Test Complete ===');

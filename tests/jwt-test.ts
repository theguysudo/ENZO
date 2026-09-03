import jwt from 'jsonwebtoken';

// Mock the verifyJwtToken function from index.ts
function verifyJwtToken(token: string): any {
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
  } catch {
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

// Test 4: Test with RS256 algorithm (if the library allows algorithm switching)
console.log('4. Testing RS256 to HS256 confusion:');
// Note: This test would require RSA key pair, so we'll simulate the attack conceptually
console.log('This test requires RSA key pair and is not executable in this environment.\nConceptually, if the server uses HS256 but accepts RS256 tokens signed with the public key as HMAC secret, it would be vulnerable.\n');

// Test 5: Test with empty signature but valid HS256 header
console.log('5. Testing valid HS256 header with empty signature:');
const emptySigToken = `${parts[0]}.${parts[1]}.`; // Same header and payload, but empty signature
console.log('Token:', emptySigToken);
const emptySigResult = verifyJwtToken(emptySigToken);
console.log('Verification result:', emptySigResult ? '✅ ACCEPTED (VULNERABLE)' : '❌ REJECTED (SECURE)', '\n');

// Test 6: Test token with different algorithms in header vs signature
console.log('6. Testing token with algorithm mismatch:');
// Create a token with HS256 algorithm but sign it as if it were none
// This is not practical as we need the actual signing mechanism
console.log("This test requires deeper library manipulation and is not directly executable.\nThe vulnerability would exist if the library doesn't properly validate the algorithm specified in the header.\n");

console.log('=== Test Complete ===');

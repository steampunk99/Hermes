const crypto = require('crypto');

// Use environment variable for encryption key in production
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef'; // 32 characters
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt a private key for secure database storage
 * @param {string} privateKey - The private key to encrypt
 * @returns {string} Encrypted private key with IV and auth tag
 */
function encryptPrivateKey(privateKey) {
  try {
    // Generate a random initialization vector
    const iv = crypto.randomBytes(16);
    
    // Create cipher
    const key = Buffer.from(ENCRYPTION_KEY, 'utf8');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes (256-bit)');
    }
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from('privatekey', 'utf8'));
    
    // Encrypt the private key
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Get the authentication tag
    const authTag = cipher.getAuthTag();
    
    // Combine IV, auth tag, and encrypted data
    const result = iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
    
    return result;
  } catch (error) {
    throw new Error(`Private key encryption failed: ${error.message}`);
  }
}

/**
 * Decrypt a private key from database storage
 * @param {string} encryptedPrivateKey - The encrypted private key from database
 * @returns {string} Decrypted private key
 */
function decryptPrivateKey(encryptedPrivateKey) {
  try {
    // Split the stored value into components
    const parts = encryptedPrivateKey.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted private key format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    // Create decipher
    const key = Buffer.from(ENCRYPTION_KEY, 'utf8');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes (256-bit)');
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from('privatekey', 'utf8'));
    decipher.setAuthTag(authTag);
    
    // Decrypt the private key
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    throw new Error(`Private key decryption failed: ${error.message}`);
  }
}

/**
 * Test the encryption/decryption functions
 */
function testEncryption() {
  const testPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  
  console.log('Testing encryption/decryption...');
  console.log('Original:', testPrivateKey);
  
  const encrypted = encryptPrivateKey(testPrivateKey);
  console.log('Encrypted:', encrypted);
  
  const decrypted = decryptPrivateKey(encrypted);
  console.log('Decrypted:', decrypted);
  
  console.log('Test passed:', testPrivateKey === decrypted);
}

module.exports = {
  encryptPrivateKey,
  decryptPrivateKey,
  testEncryption
};

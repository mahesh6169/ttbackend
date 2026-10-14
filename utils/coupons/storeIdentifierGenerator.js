import Store from '../../models/coupons/store.js';

/**
 * Generate unique 5-character alphanumeric store identifier
 * Format: A1B2C (uppercase letters and numbers)
 * @returns {String} Unique store identifier
 */
export const generateStoreIdentifier = async () => {
  const generateRandomIdentifier = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let identifier = '';
    for (let i = 0; i < 5; i++) {
      identifier += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return identifier;
  };

  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const identifier = generateRandomIdentifier();
    
    try {
      const existingStore = await Store.findOne({ storeIdentifier: identifier });
      
      if (!existingStore) {
        console.log(`✅ Generated unique store identifier: ${identifier} (attempt ${attempts + 1})`);
        return identifier;
      }
      
      console.log(`⚠️ Store identifier ${identifier} already exists, generating new one...`);
      attempts++;
      
    } catch (error) {
      console.error('❌ Database error while checking store identifier uniqueness:', error);
      throw new Error('Failed to generate store identifier due to database error');
    }
  }
  
  throw new Error('Unable to generate unique store identifier after 10 attempts');
};

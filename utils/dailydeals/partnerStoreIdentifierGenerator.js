import PartnerStore from '../../models/dailydeals/partnerStore.js';

/**
 * Generate unique 5-character alphanumeric partner store identifier
 * Format: A1B2C (uppercase letters and numbers)
 * @returns {String} Unique partner store identifier
 */
export const generatePartnerStoreIdentifier = async () => {
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
      const existingStore = await PartnerStore.findOne({ partnerstoreId: identifier });

      if (!existingStore) {
        console.log(`✅ Generated unique partner store identifier: ${identifier} (attempt ${attempts + 1})`);
        return identifier;
      }

      console.log(`⚠️ Partner store identifier ${identifier} already exists, generating new one...`);
      attempts++;

    } catch (error) {
      console.error('❌ Database error while checking partner store identifier uniqueness:', error);
      throw new Error('Failed to generate partner store identifier due to database error');
    }
  }

  throw new Error('Unable to generate unique partner store identifier after 10 attempts');
};

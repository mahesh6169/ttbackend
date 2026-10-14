import cloudinary from '../cloudinary.js';

const folderName = process.env.NODE_ENV === 'production' ? 'tagtelugu' : 'tagtelugudev';

/**
 * Handle logo upload for store creation
 * @param {Object} req - Express request object
 * @returns {Object|null} Logo object {url, publicId, originalFilename} or null
 */
export const handleLogoUpload = async (req) => {
  // Check if logo file exists
  let logoFile = null;
  
  if (req.files) {
    if (req.files.logo && req.files.logo.length > 0) {
      logoFile = req.files.logo[0];
    }
  }

  // No logo provided - return null (no fallback)
  if (!logoFile || logoFile.size === 0) {
    console.log('📸 No logo provided for store');
    return null;
  }

  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(logoFile.mimetype)) {
    throw new Error('Logo must be JPEG, PNG, or WebP format');
  }

  // Validate file size (max 2MB)
  const maxSize = 2 * 1024 * 1024;
  if (logoFile.size > maxSize) {
    throw new Error('Logo file size must be under 2MB');
  }

  try {
    console.log(`📤 Uploading store logo: ${logoFile.originalname || 'unnamed'} (${logoFile.size} bytes)`);
    
    const result = await cloudinary.uploader.upload(
      `data:${logoFile.mimetype};base64,${logoFile.buffer.toString('base64')}`,
      {
        folder: `${folderName}/coupons`,
        transformation: [
          { fetch_format: 'auto', quality: 'auto:good' }
        ]
      }
    );

    console.log(`✅ Store logo uploaded successfully: ${result.public_id}`);
    
    return {
      url: result.secure_url,
      publicId: result.public_id,
      originalFilename: logoFile.originalname
    };

  } catch (error) {
    console.error('❌ Cloudinary logo upload error:', error);
    throw new Error('Logo upload failed: ' + error.message);
  }
};

/**
 * Handle logo update for store editing
 * @param {Object} req - Express request object
 * @param {Object} existingLogo - Current logo object {url, publicId, originalFilename} (if any)
 * @returns {Object|null} Updated logo object or null
 */
export const handleLogoUpdate = async (req, existingLogo = null) => {
  // Check if new logo file is being uploaded
  let newLogoFile = null;
  
  if (req.files) {
    if (req.files.logo && req.files.logo.length > 0) {
      newLogoFile = req.files.logo[0];
    }
  }

  // Check if user wants to keep existing logo
  const keepExistingLogo = req.body.keepExistingLogo === 'true' || req.body.keepExistingLogo === true;

  // If keeping existing and no new file, return existing
  if (keepExistingLogo && !newLogoFile && existingLogo) {
    console.log('📸 Keeping existing store logo');
    return existingLogo;
  }

  // If new logo is being uploaded
  if (newLogoFile && newLogoFile.size > 0) {
    // Delete old logo from Cloudinary (if exists)
    if (existingLogo?.publicId) {
      try {
        await cloudinary.uploader.destroy(existingLogo.publicId);
        console.log(`🗑️ Deleted old store logo from Cloudinary: ${existingLogo.publicId}`);
      } catch (error) {
        console.error('❌ Failed to delete old logo:', error.message);
      }
    }

    // Upload new logo
    return await handleLogoUpload(req);
  }

  // No new logo and not keeping existing - user removed the logo
  if (!keepExistingLogo && existingLogo?.publicId) {
    // Delete from Cloudinary
    try {
      await cloudinary.uploader.destroy(existingLogo.publicId);
      console.log(`🗑️ Deleted removed store logo from Cloudinary: ${existingLogo.publicId}`);
    } catch (error) {
      console.error('❌ Failed to delete removed logo:', error.message);
    }
  }
  
  console.log('📸 No logo for store (removed or never had one)');
  return null;
};

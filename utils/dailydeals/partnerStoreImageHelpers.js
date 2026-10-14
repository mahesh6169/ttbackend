import cloudinary from '../cloudinary.js';

const folderName = process.env.NODE_ENV === 'production' ? 'tagtelugu' : 'tagtelugudev';

/**
 * Handle logo upload for partner store creation
 * @param {Object} req - Express request object
 * @returns {Object|null} Logo object {url, publicId, originalFilename} or null
 */
export const handleLogoUpload = async (req) => {
  let logoFile = null;

  if (req.files) {
    if (req.files.logo && req.files.logo.length > 0) {
      logoFile = req.files.logo[0];
    }
  }

  if (!logoFile || logoFile.size === 0) {
    console.log('📸 No logo provided for partner store');
    return null;
  }

  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(logoFile.mimetype)) {
    throw new Error('Logo must be JPEG, PNG, or WebP format');
  }

  const maxSize = 2 * 1024 * 1024;
  if (logoFile.size > maxSize) {
    throw new Error('Logo file size must be under 2MB');
  }

  try {
    console.log(`📤 Uploading partner store logo: ${logoFile.originalname || 'unnamed'} (${logoFile.size} bytes)`);

    const result = await cloudinary.uploader.upload(
      `data:${logoFile.mimetype};base64,${logoFile.buffer.toString('base64')}`,
      {
        folder: `${folderName}/dailydeals`,
        transformation: [
          { fetch_format: 'auto', quality: 'auto:good' }
        ]
      }
    );

    console.log(`✅ Partner store logo uploaded successfully: ${result.public_id}`);

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
 * Handle logo update for partner store editing
 * @param {Object} req - Express request object
 * @param {Object} existingLogo - Current logo object {url, publicId, originalFilename} (if any)
 * @returns {Object|null} Updated logo object or null
 */
export const handleLogoUpdate = async (req, existingLogo = null) => {
  let newLogoFile = null;

  if (req.files) {
    if (req.files.logo && req.files.logo.length > 0) {
      newLogoFile = req.files.logo[0];
    }
  }

  const keepExistingLogo = req.body.keepExistingLogo === 'true' || req.body.keepExistingLogo === true;

  if (keepExistingLogo && !newLogoFile && existingLogo) {
    console.log('📸 Keeping existing partner store logo');
    return existingLogo;
  }

  if (newLogoFile && newLogoFile.size > 0) {
    if (existingLogo?.publicId) {
      try {
        await cloudinary.uploader.destroy(existingLogo.publicId);
        console.log(`🗑️ Deleted old partner store logo from Cloudinary: ${existingLogo.publicId}`);
      } catch (error) {
        console.error('❌ Failed to delete old logo:', error.message);
      }
    }

    return await handleLogoUpload(req);
  }

  if (!keepExistingLogo && existingLogo?.publicId) {
    try {
      await cloudinary.uploader.destroy(existingLogo.publicId);
      console.log(`🗑️ Deleted removed partner store logo from Cloudinary: ${existingLogo.publicId}`);
    } catch (error) {
      console.error('❌ Failed to delete removed logo:', error.message);
    }
  }

  console.log('📸 No logo for partner store (removed or never had one)');
  return null;
};

/**
 * Delete logo from Cloudinary
 * @param {Object} logo - Logo object {url, publicId, originalFilename}
 */
export const deleteLogoFromCloudinary = async (logo) => {
  if (logo?.publicId) {
    try {
      await cloudinary.uploader.destroy(logo.publicId);
      console.log(`🗑️ Deleted partner store logo from Cloudinary: ${logo.publicId}`);
    } catch (error) {
      console.error('❌ Failed to delete logo from Cloudinary:', error.message);
    }
  }
};

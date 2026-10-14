import cloudinary from '../cloudinary.js';

const folderName = process.env.NODE_ENV === 'production' ? 'tagtelugu' : 'tagtelugudev';

const MAX_DEAL_IMAGES = 5;

/**
 * Upload deal images to Cloudinary
 * @param {Object} req - Express request object
 * @param {Number} existingCount - Number of existing images (for update scenarios)
 * @returns {Array} Array of image objects {url, publicId, originalFilename}
 */
export const uploadDealImages = async (req, existingCount = 0) => {
  const images = [];

  if (!req.files || !req.files.images || req.files.images.length === 0) {
    console.log('📸 No images provided for deal');
    return images;
  }

  // Check max images limit
  const totalImages = existingCount + req.files.images.length;
  if (totalImages > MAX_DEAL_IMAGES) {
    throw new Error(`Maximum ${MAX_DEAL_IMAGES} images allowed`);
  }

  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const maxSize = 10 * 1024 * 1024; // 10MB

  for (const file of req.files.images) {
    if (!allowedTypes.includes(file.mimetype)) {
      console.log(`⚠️ Skipping invalid file type: ${file.mimetype}`);
      continue;
    }

    if (file.size > maxSize) {
      console.log(`⚠️ Skipping file too large: ${file.size} bytes`);
      continue;
    }

    try {
      console.log(`📤 Uploading deal image: ${file.originalname || 'unnamed'} (${file.size} bytes)`);

      const result = await cloudinary.uploader.upload(
        `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
        {
          folder: `${folderName}/dailydeals`,
          transformation: [{ fetch_format: 'auto', quality: 'auto:good' }]
        }
      );

      images.push({
        url: result.secure_url,
        publicId: result.public_id,
        originalFilename: file.originalname
      });

      console.log(`✅ Deal image uploaded: ${result.public_id}`);
    } catch (error) {
      console.error(`❌ Failed to upload image: ${error.message}`);
    }
  }

  return images;
};

/**
 * Delete images from Cloudinary
 * @param {Array} images - Array of image objects with publicId
 */
export const deleteDealImages = async (images) => {
  if (!images || images.length === 0) return;

  for (const image of images) {
    if (image?.publicId) {
      try {
        await cloudinary.uploader.destroy(image.publicId);
        console.log(`🗑️ Deleted deal image: ${image.publicId}`);
      } catch (error) {
        console.error(`❌ Failed to delete image ${image.publicId}: ${error.message}`);
      }
    }
  }
};

/**
 * Handle image update - keep existing, add new, delete removed
 * @param {Object} req - Express request object
 * @param {Array} existingImages - Current images array
 * @param {Array} keepImageIds - Array of publicIds to keep
 * @returns {Array} Updated images array
 */
export const updateDealImages = async (req, existingImages = [], keepImageIds = []) => {
  // Filter existing images to keep
  const imagesToKeep = existingImages.filter(img =>
    keepImageIds.includes(img.publicId)
  );

  // Check max images limit before uploading
  const newFileCount = req.files?.images?.length || 0;
  const totalImages = imagesToKeep.length + newFileCount;
  if (totalImages > MAX_DEAL_IMAGES) {
    throw new Error(`Maximum ${MAX_DEAL_IMAGES} images allowed. You have ${imagesToKeep.length} existing and trying to add ${newFileCount} new images.`);
  }

  // Find images to delete
  const imagesToDelete = existingImages.filter(img =>
    !keepImageIds.includes(img.publicId)
  );

  // Delete removed images from Cloudinary
  await deleteDealImages(imagesToDelete);

  // Upload new images
  const newImages = await uploadDealImages(req);

  // Combine kept and new images
  return [...imagesToKeep, ...newImages];
};

import { BannerBusiness, BannerPlacement, BannerAd, BannerMetrics } from '../../models/bannerAds/index.js';
import cloudinary from '../../utils/cloudinary.js';

// ===== BUSINESS MANAGEMENT =====

// Get all businesses
export const getBusinesses = async (req, res) => {
  try {
    const { search } = req.query;
    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { businessId: { $regex: search, $options: 'i' } },
        { 'contact.email': { $regex: search, $options: 'i' } }
      ];
    }
    
    const businesses = await BannerBusiness.find(query)
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({ success: true, businesses });
  } catch (error) {
    console.error('Error fetching businesses:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get business by ID
export const getBusinessById = async (req, res) => {
  try {
    const { id } = req.params;
    const business = await BannerBusiness.findOne({ businessId: id.toUpperCase() });
    
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    
    // Get ad count for this business
    const adCount = await BannerAd.countDocuments({ businessId: business._id });
    
    res.json({ 
      success: true, 
      business: { ...business.toObject(), adCount }
    });
  } catch (error) {
    console.error('Error fetching business:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create new business
export const createBusiness = async (req, res) => {
  try {
    const businessData = req.body;
    
    // Check for duplicate business name
    const existingBusiness = await BannerBusiness.findOne({ 
      name: { $regex: new RegExp(`^${businessData.name}$`, 'i') } 
    });
    
    if (existingBusiness) {
      return res.status(400).json({ 
        success: false, 
        message: 'A business with this name already exists' 
      });
    }
    
    // Generate businessId automatically
    const randomStr = Math.random().toString(36).substr(2, 4).toUpperCase();
    businessData.businessId = `BIZ-${randomStr}`;
    
    const business = new BannerBusiness(businessData);
    await business.save();
    
    res.status(201).json({ success: true, business });
  } catch (error) {
    console.error('Error creating business:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// Update business
export const updateBusiness = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // If updating name, check for duplicates
    if (updates.name) {
      const existingBusiness = await BannerBusiness.findOne({ 
        name: { $regex: new RegExp(`^${updates.name}$`, 'i') },
        businessId: { $ne: id.toUpperCase() } // Exclude current business
      });
      
      if (existingBusiness) {
        return res.status(400).json({ 
          success: false, 
          message: 'A business with this name already exists' 
        });
      }
    }
    
    const business = await BannerBusiness.findOneAndUpdate(
      { businessId: id.toUpperCase() },
      updates,
      { new: true, runValidators: true }
    );
    
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    
    res.json({ success: true, business });
  } catch (error) {
    console.error('Error updating business:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// Delete business
export const deleteBusiness = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if business has ads
    const business = await BannerBusiness.findOne({ businessId: id.toUpperCase() });
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    
    const adCount = await BannerAd.countDocuments({ businessId: business._id });
    if (adCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete business with ${adCount} active ads` 
      });
    }
    
    await business.deleteOne();
    res.json({ success: true, message: 'Business deleted successfully' });
  } catch (error) {
    console.error('Error deleting business:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ===== PLACEMENT MANAGEMENT =====

// Get all placements
export const getPlacements = async (req, res) => {
  try {
    const query = {};
    
    const placements = await BannerPlacement.find(query)
      .sort({ placementId: 1 })
      .lean();
    
    res.json({ success: true, placements });
  } catch (error) {
    console.error('Error fetching placements:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get placement by ID
export const getPlacementById = async (req, res) => {
  try {
    const { id } = req.params;
    const placement = await BannerPlacement.findOne({ placementId: id.toUpperCase() });
    
    if (!placement) {
      return res.status(404).json({ success: false, message: 'Placement not found' });
    }
    
    res.json({ success: true, placement });
  } catch (error) {
    console.error('Error fetching placement:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create new placement
export const createPlacement = async (req, res) => {
  try {
    console.log('=== CREATE PLACEMENT REQUEST ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    // Basic validation - just check if placementId exists
    if (!req.body.placementId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Placement ID is required' 
      });
    }
    
    // Simply save what frontend sends - no backend calculations
    const placement = new BannerPlacement(req.body);
    await placement.save();
    
    console.log('Placement saved successfully:', placement.placementId);
    
    res.status(201).json({ success: true, placement });
  } catch (error) {
    console.error('=== CREATE PLACEMENT ERROR ===');
    console.error('Error creating placement:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body that caused error:', req.body);
    res.status(400).json({ success: false, message: error.message });
  }
};

// Update placement
export const updatePlacement = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Simply update with what frontend sends - no backend calculations
    const placement = await BannerPlacement.findOneAndUpdate(
      { placementId: id.toUpperCase() },
      updates,
      { new: true, runValidators: true }
    );
    
    if (!placement) {
      return res.status(404).json({ success: false, message: 'Placement not found' });
    }
    
    res.json({ success: true, placement });
  } catch (error) {
    console.error('Error updating placement:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// Delete placement
export const deletePlacement = async (req, res) => {
  try {
    const { id } = req.params;
    
    const placement = await BannerPlacement.findOne({ placementId: id.toUpperCase() });
    
    if (!placement) {
      return res.status(404).json({ success: false, message: 'Placement not found' });
    }
    
    // Check if any ads are using this placement
    const adCount = await BannerAd.countDocuments({ 
      placements: id.toUpperCase() 
    });
    
    if (adCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete placement: ${adCount} ads are using this placement`
      });
    }
    
    await placement.deleteOne();
    console.log(`Deleted placement: ${id}`);
    
    res.json({ success: true, message: 'Placement deleted successfully' });
  } catch (error) {
    console.error('Error deleting placement:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ===== AD MANAGEMENT =====

// Get all ads
export const getAds = async (req, res) => {
  try {
    const { businessId, placement, state } = req.query;
    const query = {};
    if (businessId) {
      const business = await BannerBusiness.findOne({ businessId: businessId.toUpperCase() });
      if (business) query.businessId = business._id;
    }
    if (placement) query.placements = placement.toUpperCase();
    if (state) query.targetStates = state;
    
    const ads = await BannerAd.find(query)
      .populate('businessId', 'businessId name')
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({ success: true, ads });
  } catch (error) {
    console.error('Error fetching ads:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get ad by ID
export const getAdById = async (req, res) => {
  try {
    const { id } = req.params;
    const ad = await BannerAd.findOne({ adId: id.toUpperCase() })
      .populate('businessId', 'businessId name contact');
    
    if (!ad) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }
    
    res.json({ success: true, ad });
  } catch (error) {
    console.error('Error fetching ad:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create new ad with image upload
export const createAd = async (req, res) => {
  let desktopImages = [];
  let mobileImages = [];
  
  try {
    console.log('\n=== CREATE AD REQUEST ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Request files:', req.files);
    
    // Parse form data fields
    const {
      businessId,
      name,
      placements,
      targetStates,
      schedule,
      status,
      altText,
      destinationUrl,
      destinationType,
      mobileAltText,
      mobileDestinationUrl,
      mobileDestinationType,
      maxImpressions,
      maxClicks
    } = req.body;
    
    // Parse JSON fields
    const parsedPlacements = placements ? JSON.parse(placements) : [];
    const parsedTargetStates = targetStates ? JSON.parse(targetStates) : [];
    const parsedSchedule = JSON.parse(schedule);
    
    // Validate dates
    const startDate = new Date(parsedSchedule.startAt);
    const endDate = new Date(parsedSchedule.endAt);
    if (startDate >= endDate) {
      return res.status(400).json({ success: false, message: 'End date must be after start date' });
    }
    
    // Validate business exists
    const business = await BannerBusiness.findById(businessId);
    if (!business) {
      return res.status(400).json({ success: false, message: 'Invalid business ID' });
    }
    
    // Validate placements exist (only if placements provided)
    if (parsedPlacements.length > 0) {
      for (const placementId of parsedPlacements) {
        // All placements are now independent
        const placement = await BannerPlacement.findOne({ placementId });
        
        if (!placement) {
          return res.status(400).json({ 
            success: false, 
            message: `Placement ${placementId} not found` 
          });
        }
      }
    }
    
    // Upload images to Cloudinary - separate desktop and mobile carousels
    let desktopImages = [];
    let mobileImages = [];
    
    if (req.files && req.files.images) {
      const folderName = process.env.NODE_ENV === "production" ? "tagtelugu" : "tagtelugudev";
      const files = Array.isArray(req.files.images) ? req.files.images : [req.files.images];
      
      console.log('\n📷 Processing images for upload:');
      console.log('Number of files:', files.length);
      
      // Separate desktop and mobile files
      // Parse image metadata if provided
      let imageMetadata = [];
      if (req.body.imageMetadata) {
        try {
          imageMetadata = JSON.parse(req.body.imageMetadata);
          console.log('Image metadata:', imageMetadata);
        } catch (e) {
          console.error('Failed to parse image metadata:', e);
        }
      }
      
      const desktopFiles = [];
      const mobileFiles = [];
      
      for (const file of files) {
        console.log('\nProcessing file:', file.originalname);
        
        // Expected format: "desktop_0", "mobile_0", "desktop_1", etc.
        const [imageType, indexStr] = file.originalname.split('_');
        const index = parseInt(indexStr) || 0;
        
        // Find metadata for this file
        const metadata = imageMetadata.find(m => m.type === imageType && m.index === index);
        
        if (imageType === 'desktop') {
          desktopFiles.push({ 
            file, 
            order: index,
            originalFilename: metadata?.originalFilename || file.originalname
          });
        } else if (imageType === 'mobile') {
          mobileFiles.push({ 
            file, 
            order: index,
            originalFilename: metadata?.originalFilename || file.originalname
          });
        }
      }
      
      // Upload desktop images
      try {
        for (const { file, order, originalFilename } of desktopFiles.sort((a, b) => a.order - b.order)) {
          const result = await cloudinary.uploader.upload(
            `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
            {
              folder: `${folderName}/banner-ads`,
              transformation: [{ fetch_format: "auto", quality: "auto:good" }]
            }
          );
          
          desktopImages.push({
            imageUrl: result.secure_url,
            publicId: result.public_id, // Store for cleanup if needed
            order,
            originalFilename
          });
          
          console.log(`✅ Uploaded desktop image ${order}:`, result.secure_url);
        }
        
        // Upload mobile images
        for (const { file, order, originalFilename } of mobileFiles.sort((a, b) => a.order - b.order)) {
          const result = await cloudinary.uploader.upload(
            `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
            {
              folder: `${folderName}/banner-ads`,
              transformation: [{ fetch_format: "auto", quality: "auto:good" }]
            }
          );
          
          mobileImages.push({
            imageUrl: result.secure_url,
            publicId: result.public_id, // Store for cleanup if needed
            order,
            originalFilename
          });
          
          console.log(`✅ Uploaded mobile image ${order}:`, result.secure_url);
        }
      } catch (uploadError) {
        console.error('Error uploading images:', uploadError);
        // Clean up any uploaded images
        const allImages = [...desktopImages, ...mobileImages];
        for (const img of allImages) {
          if (img.publicId) {
            await cloudinary.uploader.destroy(img.publicId);
          }
        }
        return res.status(500).json({ 
          success: false, 
          message: 'Failed to upload images' 
        });
      }
    }
    
    // Generate adId
    const randomStr = Math.random().toString(36).substr(2, 6).toUpperCase();
    const adId = `AD-${randomStr}`;
    
    // Build ad data with new schema structure
    const adData = {
      adId,
      name,
      businessId,
      placements: parsedPlacements,
      targetStates: parsedTargetStates,
      schedule: parsedSchedule,
      status,
      creative: {
        desktop: {
          images: desktopImages.map(img => ({
            imageUrl: img.imageUrl,
            order: img.order,
            originalFilename: img.originalFilename
          })),
          altText: altText || 'Banner Image',
          destination: {
            type: destinationType || 'external',
            url: destinationUrl || ''
          }
        }
      }
    }
    
    // Add mobile if we have mobile images or mobile-specific data
    if (mobileImages.length > 0 || mobileAltText || mobileDestinationUrl) {
      adData.creative.mobile = {
        images: mobileImages.length > 0 ? mobileImages.map(img => ({
          imageUrl: img.imageUrl,
          order: img.order,
          originalFilename: img.originalFilename
        })) : [],
        altText: mobileAltText || altText || 'Banner Image',
        destination: {
          type: mobileDestinationType || destinationType || 'external',
          url: mobileDestinationUrl || destinationUrl || ''
        }
      };
    }
    
    // Add caps if provided
    if (maxImpressions || maxClicks) {
      adData.caps = {};
      if (maxImpressions) adData.caps.maxImpressions = parseInt(maxImpressions);
      if (maxClicks) adData.caps.maxClicks = parseInt(maxClicks);
    }
    
    console.log('\n📝 Final ad data before save:', JSON.stringify(adData, null, 2));
    
    // Create and save ad
    const ad = new BannerAd(adData);
    await ad.save();
    
    console.log('\n✅ Ad created successfully:', ad.adId);
    console.log('Desktop images:', ad.creative.desktop.images.length);
    console.log('Mobile images:', ad.creative.mobile?.images?.length || 0);
    
    // Add to placement's assignedAds array
    for (const placementId of parsedPlacements) {
      try {
        // Get current placement
        const placement = await BannerPlacement.findOne({ placementId });
        if (!placement) {
          console.error(`Placement ${placementId} not found`);
          continue;
        }
        
        // Calculate next order
        const maxOrder = placement.assignedAds?.reduce((max, ad) => 
          Math.max(max, ad.order), -1) ?? -1;
        
        // Add ad to placement
        await BannerPlacement.updateOne(
          { placementId },
          { 
            $push: { 
              assignedAds: {
                adId: ad.adId,
                order: maxOrder + 1,
                lastServed: null
              }
            }
          }
        );
        
        console.log(`Added ad ${ad.adId} to placement ${placementId} at order ${maxOrder + 1}`);
      } catch (err) {
        console.error(`Failed to add ad to placement ${placementId}:`, err);
      }
    }
    
    res.status(201).json({ success: true, ad });
  } catch (error) {
    console.error('Error creating ad:', error);
    
    // Cleanup uploaded images on failure
    console.log('\n🧹 Cleaning up uploaded images due to error...');
    const allImages = [...desktopImages, ...mobileImages];
    for (const img of allImages) {
      if (img.publicId) {
        try {
          await cloudinary.uploader.destroy(img.publicId);
          console.log(`Deleted image: ${img.publicId}`);
        } catch (cleanupError) {
          console.error('Error during image cleanup:', cleanupError);
        }
      }
    }
    
    res.status(400).json({ success: false, message: error.message });
  }
};


// Update ad with carousel support
export const updateAd = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log('\n=== UPDATE AD REQUEST (SEPARATE CAROUSELS) ===');
    console.log('Ad ID:', id);
    console.log('Has files:', !!req.files);
    
    // Find existing ad
    const existingAd = await BannerAd.findOne({ adId: id.toUpperCase() });
    if (!existingAd) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }
    
    let updateData = {};
    let uploadedDesktopImages = [];
    let uploadedMobileImages = [];
    let imagesToRemove = [];
    
    try {
      // Always handle as multipart when removedImages exist
      if ((req.files && req.files.images) || req.body.removedImages) {
        const {
          name,
          placements,
          targetStates,
          schedule,
          status,
          altText,
          destinationUrl,
          destinationType,
          mobileAltText,
          mobileDestinationUrl,
          mobileDestinationType,
          maxImpressions,
          maxClicks,
          notes,
          existingImages,
          removedImages
        } = req.body;
        
        // Parse JSON fields
        const parsedPlacements = JSON.parse(placements || '[]');
        const parsedTargetStates = JSON.parse(targetStates || '[]');
        const parsedSchedule = JSON.parse(schedule || '{}');
        const parsedExistingImages = existingImages ? JSON.parse(existingImages) : [];
        const parsedRemovedImages = removedImages ? JSON.parse(removedImages) : [];
        
        console.log('Received schedule:', schedule);
        console.log('Parsed schedule:', parsedSchedule);
        console.log('Existing ad schedule:', existingAd.schedule);
        
        console.log('\n=== IMAGE REMOVAL DEBUG ===');
        console.log('Existing images to keep:', parsedExistingImages.length);
        console.log('Images to remove:', parsedRemovedImages.length);
        console.log('Removed images details:', JSON.stringify(parsedRemovedImages, null, 2));
        console.log('Alt text received:', { altText, mobileAltText });
        
        // Log existing creative structure
        console.log('\nExisting creative structure:');
        console.log('Desktop images:', existingAd.creative?.desktop?.images?.length || 0);
        console.log('Mobile images:', existingAd.creative?.mobile?.images?.length || 0);
        
        // Track images to remove from Cloudinary
        imagesToRemove = parsedRemovedImages;
        
        // Upload new images
        const folderName = process.env.NODE_ENV === "production" ? "tagtelugu" : "tagtelugudev";
        const files = req.files?.images ? (Array.isArray(req.files.images) ? req.files.images : [req.files.images]) : [];
        
        // Parse image metadata if provided
        let imageMetadata = [];
        if (req.body.imageMetadata) {
          try {
            imageMetadata = JSON.parse(req.body.imageMetadata);
            console.log('Image metadata:', imageMetadata);
          } catch (e) {
            console.error('Failed to parse image metadata:', e);
          }
        }
        
        // Separate desktop and mobile images
        const desktopFiles = [];
        const mobileFiles = [];
        
        for (const file of files) {
          const [imageType, indexStr] = file.originalname.split('_');
          const index = parseInt(indexStr) || 0;
          
          // Find metadata for this file
          const metadata = imageMetadata.find(m => m.type === imageType && m.index === index);
          
          if (imageType === 'desktop') {
            desktopFiles.push({ 
              file, 
              index,
              originalFilename: metadata?.originalFilename || file.originalname
            });
          } else if (imageType === 'mobile') {
            mobileFiles.push({ 
              file, 
              index,
              originalFilename: metadata?.originalFilename || file.originalname
            });
          }
        }
        
        // Upload desktop images
        for (const { file, index, originalFilename } of desktopFiles) {
          try {
            const result = await cloudinary.uploader.upload(
              `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
              {
                folder: `${folderName}/banner-ads`,
                transformation: [{ fetch_format: "auto", quality: "auto:good" }]
              }
            );
            
            uploadedDesktopImages.push({
              imageUrl: result.secure_url,
              publicId: result.public_id,
              order: index,
              originalFilename
            });
            
            console.log(`✅ Uploaded desktop image for index ${index}`);
          } catch (uploadError) {
            console.error('Error uploading desktop image:', uploadError);
            // Clean up any uploaded images on error
            for (const img of [...uploadedDesktopImages, ...uploadedMobileImages]) {
              if (img.publicId) {
                await cloudinary.uploader.destroy(img.publicId);
              }
            }
            throw uploadError;
          }
        }
        
        // Upload mobile images
        for (const { file, index, originalFilename } of mobileFiles) {
          try {
            const result = await cloudinary.uploader.upload(
              `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
              {
                folder: `${folderName}/banner-ads`,
                transformation: [{ fetch_format: "auto", quality: "auto:good" }]
              }
            );
            
            uploadedMobileImages.push({
              imageUrl: result.secure_url,
              publicId: result.public_id,
              order: index,
              originalFilename
            });
            
            console.log(`✅ Uploaded mobile image for index ${index}`);
          } catch (uploadError) {
            console.error('Error uploading mobile image:', uploadError);
            // Clean up any uploaded images on error
            for (const img of [...uploadedDesktopImages, ...uploadedMobileImages]) {
              if (img.publicId) {
                await cloudinary.uploader.destroy(img.publicId);
              }
            }
            throw uploadError;
          }
        }
        
        // Build complete image arrays for desktop and mobile
        const existingCreative = existingAd.creative;
        
        // Desktop images
        const desktopImages = [];
        if (existingCreative?.desktop?.images) {
          console.log('\nProcessing existing desktop images:');
          existingCreative.desktop.images.forEach((img, idx) => {
            const removed = parsedRemovedImages.some(r => 
              r.imageType === 'desktop' && r.index === idx
            );
            console.log(`Desktop image ${idx}: ${removed ? 'REMOVED' : 'KEPT'}`);
            if (!removed) {
              desktopImages.push(img);
            }
          });
        }
        
        // Add new desktop images
        uploadedDesktopImages.forEach(newImg => {
          desktopImages.push({
            imageUrl: newImg.imageUrl,
            order: newImg.order,
            originalFilename: newImg.originalFilename
          });
        });
        
        // Mobile images
        const mobileImages = [];
        if (existingCreative?.mobile?.images) {
          console.log('\nProcessing existing mobile images:');
          existingCreative.mobile.images.forEach((img, idx) => {
            const removed = parsedRemovedImages.some(r => 
              r.imageType === 'mobile' && r.index === idx
            );
            console.log(`Mobile image ${idx}: ${removed ? 'REMOVED' : 'KEPT'} - URL: ${img.imageUrl}`);
            if (!removed) {
              mobileImages.push(img);
            } else {
              console.log(`  -> Will delete from Cloudinary: ${img.imageUrl}`);
            }
          });
        }
        
        // Add new mobile images
        uploadedMobileImages.forEach(newImg => {
          mobileImages.push({
            imageUrl: newImg.imageUrl,
            order: newImg.order,
            originalFilename: newImg.originalFilename
          });
        });
        
        // Sort by order and then recalculate order to ensure sequential numbering
        desktopImages.sort((a, b) => (a.order || 0) - (b.order || 0));
        desktopImages.forEach((img, index) => {
          img.order = index;
        });
        
        mobileImages.sort((a, b) => (a.order || 0) - (b.order || 0));
        mobileImages.forEach((img, index) => {
          img.order = index;
        });
        
        // Build update data - only include fields that are provided
        updateData = {};
        
        if (name) updateData.name = name;
        if (parsedPlacements.length > 0) updateData.placements = parsedPlacements;
        if (parsedTargetStates !== undefined) updateData.targetStates = parsedTargetStates;
        if (status) updateData.status = status;
        if (Object.keys(parsedSchedule).length > 0) updateData.schedule = parsedSchedule;
        
        // Update creative with new structure - separate desktop and mobile
        updateData['creative'] = {};
        
        // Handle desktop creative
        if (desktopImages.length > 0) {
          updateData.creative.desktop = {
            images: desktopImages,
            altText: altText || existingCreative?.desktop?.altText || 'Banner Image',
            destination: {
              type: destinationType || existingCreative?.desktop?.destination?.type || 'external',
              url: destinationUrl || existingCreative?.desktop?.destination?.url || ''
            }
          };
        } else {
          // No desktop images left - explicitly remove desktop creative
          updateData.creative.desktop = null;
          console.log('No desktop images remaining - setting desktop creative to null');
        }
        
        // Validate we'll have at least one creative after update
        if (desktopImages.length === 0 && mobileImages.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Cannot remove all images. Ad must have at least desktop or mobile images.'
          });
        }
        
        // Handle mobile creative
        console.log(`\nMobile images after processing: ${mobileImages.length}`);
        if (mobileImages.length > 0) {
          // We have mobile images, so keep mobile creative
          updateData.creative.mobile = {
            images: mobileImages,
            altText: mobileAltText || altText || existingCreative?.mobile?.altText || 'Banner Image',
            destination: {
              type: mobileDestinationType || destinationType || existingCreative?.mobile?.destination?.type || 'external',
              url: mobileDestinationUrl || destinationUrl || existingCreative?.mobile?.destination?.url || ''
            }
          };
          console.log('Keeping mobile creative with images');
        } else {
          // No mobile images left - explicitly remove mobile creative
          updateData.creative.mobile = null;
          console.log('No mobile images remaining - setting mobile creative to null');
        }
        
        // Update caps if provided
        if (maxImpressions || maxClicks) {
          updateData.caps = {};
          if (maxImpressions) updateData.caps.maxImpressions = parseInt(maxImpressions);
          if (maxClicks) updateData.caps.maxClicks = parseInt(maxClicks);
        }
        
        if (notes !== undefined) {
          updateData.notes = notes;
        }
        
      } else {
        // Regular JSON update without images
        const { removedImages, ...restBody } = req.body;
        updateData = restBody;
        
        if (removedImages) {
          imagesToRemove = JSON.parse(removedImages);
        }
        
        delete updateData.businessId; // Don't allow changing businessId
      }
      
      // Update the ad
      let updateQuery = updateData;
      const unsetFields = {};
      
      // Check if we need to unset desktop or mobile
      if (updateData.creative) {
        const { desktop, mobile, ...restCreative } = updateData.creative;
        const setCreative = { ...restCreative };
        
        // Handle desktop
        if (desktop === null) {
          unsetFields['creative.desktop'] = 1;
          console.log('Will unset creative.desktop');
        } else if (desktop) {
          setCreative.desktop = desktop;
        }
        
        // Handle mobile
        if (mobile === null) {
          unsetFields['creative.mobile'] = 1;
          console.log('Will unset creative.mobile');
        } else if (mobile) {
          setCreative.mobile = mobile;
        }
        
        // Build the update query
        updateQuery = updateData;
        
        // Handle creative separately to allow unsetting mobile/desktop
        if (Object.keys(unsetFields).length > 0) {
          // Use a raw MongoDB update to handle both $set and $unset
          const update = {};
          
          // Set all regular fields
          for (const [key, value] of Object.entries(updateData)) {
            if (key !== 'creative') {
              update[key] = value;
            }
          }
          
          // Set creative fields that exist
          if (desktop) update['creative.desktop'] = desktop;
          if (mobile) update['creative.mobile'] = mobile;
          
          // Construct the final query with both $set and $unset
          updateQuery = {
            $set: update,
            $unset: unsetFields
          };
        }
      }
      
      // For creative updates with unset operations, we need to handle it differently
      let updatedAd;
      if (Object.keys(unsetFields || {}).length > 0 && updateQuery.$unset) {
        // When using $unset, validation might fail for required fields
        // So we do a two-step update
        updatedAd = await BannerAd.findOneAndUpdate(
          { adId: id.toUpperCase() },
          updateQuery,
          { new: true, runValidators: false } // Skip validation for unset operations
        ).populate('businessId', 'businessId name');
      } else {
        updatedAd = await BannerAd.findOneAndUpdate(
          { adId: id.toUpperCase() },
          updateQuery,
          { new: true, runValidators: true }
        ).populate('businessId', 'businessId name');
      }
      
      // Delete removed images from Cloudinary
      if (imagesToRemove.length > 0) {
        console.log('\n🗑️ Deleting removed images from Cloudinary...');
        console.log('Images to remove:', imagesToRemove);
        
        // Helper to extract publicId from Cloudinary URL
        const extractPublicId = (url) => {
          if (!url) return null;
          // Match pattern: /v{version}/{folder}/{publicId}.{extension}
          const matches = url.match(/\/v\d+\/(.+)\.(\w+)$/);
          return matches ? matches[1] : null;
        };
        
        for (const img of imagesToRemove) {
          console.log(`\nProcessing removal for ${img.imageType} image:`);
          console.log('  Image data:', JSON.stringify(img, null, 2));
          
          // Extract publicId from URL if not provided
          const publicId = img.publicId || extractPublicId(img.url);
          console.log(`  Extracted publicId: ${publicId}`);
          console.log(`  From URL: ${img.url}`);
          
          if (publicId) {
            try {
              const result = await cloudinary.uploader.destroy(publicId);
              console.log(`  Cloudinary response:`, result);
              if (result.result === 'ok') {
                console.log(`✅ Successfully deleted ${img.imageType} image: ${publicId}`);
              } else {
                console.log(`❌ Cloudinary did not delete ${publicId}. Result: ${result.result}`);
              }
            } catch (delError) {
              console.error(`❌ Failed to delete ${publicId}:`, delError.message);
            }
          } else {
            console.error(`❌ Could not extract publicId for image: ${img.url}`);
          }
        }
      }
      
      console.log('\n✅ Ad updated successfully');
      res.json({ success: true, ad: updatedAd });
      
    } catch (error) {
      // Cleanup uploaded images on error
      for (const img of [...uploadedDesktopImages, ...uploadedMobileImages]) {
        if (img.publicId) {
          await cloudinary.uploader.destroy(img.publicId);
        }
      }
      throw error;
    }
  } catch (error) {
    console.error('Error updating ad:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// Delete ad
export const deleteAd = async (req, res) => {
  try {
    const { id } = req.params;
    
    const ad = await BannerAd.findOne({ adId: id.toUpperCase() });
    
    if (!ad) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }
    
    // Delete images from Cloudinary
    const deletePromises = [];
    
    // Extract publicId from Cloudinary URL
    const extractPublicId = (url) => {
      if (!url) return null;
      const matches = url.match(/\/v\d+\/(.+)\.\w+$/);
      return matches ? matches[1] : null;
    };
    
    // Check and delete images based on new schema structure
    if (ad.creative) {
      // Handle desktop images
      if (ad.creative.desktop?.images && Array.isArray(ad.creative.desktop.images)) {
        for (const img of ad.creative.desktop.images) {
          if (img.imageUrl) {
            const publicId = extractPublicId(img.imageUrl);
            if (publicId) {
              deletePromises.push(cloudinary.uploader.destroy(publicId));
            }
          }
        }
      }
      
      // Handle mobile images
      if (ad.creative.mobile?.images && Array.isArray(ad.creative.mobile.images)) {
        for (const img of ad.creative.mobile.images) {
          if (img.imageUrl) {
            const publicId = extractPublicId(img.imageUrl);
            if (publicId) {
              deletePromises.push(cloudinary.uploader.destroy(publicId));
            }
          }
        }
      }
    }
    
    // Wait for all image deletions
    if (deletePromises.length > 0) {
      try {
        await Promise.all(deletePromises);
        console.log(`Deleted ${deletePromises.length} images from Cloudinary for ad ${id}`);
      } catch (imgError) {
        console.error('Error deleting images from Cloudinary:', imgError);
        // Continue with ad deletion even if image deletion fails
      }
    }
    
    // Remove from placement's assignedAds arrays
    const placements = ad.placements || [];
    for (const placementId of placements) {
      try {
        await BannerPlacement.updateOne(
          { placementId },
          { 
            $pull: { 
              assignedAds: { adId: ad.adId }
            }
          }
        );
        
        console.log(`Removed ad ${ad.adId} from placement ${placementId}`);
      } catch (err) {
        console.error(`Failed to remove ad from placement ${placementId}:`, err);
      }
    }
    
    // Delete the ad from database
    await ad.deleteOne();
    
    res.json({ success: true, message: 'Ad and associated images deleted successfully' });
  } catch (error) {
    console.error('Error deleting ad:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ===== METRICS =====

// Get metrics with filters
export const getMetrics = async (req, res) => {
  try {
    const { startDate, endDate, businessId, placementId, state } = req.query;
    const query = {};
    
    // Date range filter
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }
    
    // Convert businessId to MongoDB _id for querying
    if (businessId) {
      console.log('Searching for businessId:', businessId);
      const business = await BannerBusiness.findOne({ businessId: businessId.toUpperCase() });
      if (business) {
        query.businessId = business._id.toString(); // Convert ObjectId to string
        console.log('Found business, using _id:', query.businessId);
      } else {
        console.log('Business not found for businessId:', businessId);
      }
    }
    if (placementId) query.placementId = placementId.toUpperCase();
    if (state) query.state = state;
    
    console.log('Final metrics query:', JSON.stringify(query, null, 2));
    
    const metrics = await BannerMetrics.find(query)
      .sort({ date: -1 })
      .limit(1000) // Limit for performance
      .lean();
      
    console.log('Found metrics:', metrics.length);
    
    // Aggregate totals
    const totals = metrics.reduce((acc, metric) => {
      acc.impressions += metric.impressions;
      acc.clicks += metric.clicks;
      return acc;
    }, { impressions: 0, clicks: 0 });
    
    totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions * 100).toFixed(2) : 0;
    
    res.json({ 
      success: true, 
      metrics,
      totals,
      count: metrics.length
    });
  } catch (error) {
    console.error('Error fetching metrics:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get metrics by business
export const getMetricsByBusiness = async (req, res) => {
  try {
    const { businessId } = req.params;
    const { startDate, endDate } = req.query;
    
    const business = await BannerBusiness.findOne({ businessId: businessId.toUpperCase() });
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    
    const query = { businessId: business._id };
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }
    
    const metrics = await BannerMetrics.aggregate([
      { $match: query },
      {
        $group: {
          _id: { date: '$date', adId: '$adId' },
          impressions: { $sum: '$impressions' },
          clicks: { $sum: '$clicks' }
        }
      },
      { $sort: { '_id.date': -1 } }
    ]);
    
    res.json({ success: true, metrics, business: business.name });
  } catch (error) {
    console.error('Error fetching business metrics:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Check and mark expired ads
export const checkExpiredAds = async (req, res) => {
  try {
    console.log('=== CHECKING FOR EXPIRED ADS ===');
    const now = new Date();
    
    // Find all active ads that should be expired
    const expiredAds = await BannerAd.find({
      status: 'active',
      'schedule.endAt': { $lt: now }
    }).select('adId name businessId schedule.endAt');
    
    console.log(`Found ${expiredAds.length} expired ads to update`);
    
    if (expiredAds.length > 0) {
      // Update them to expired status
      const result = await BannerAd.updateMany(
        {
          status: 'active',
          'schedule.endAt': { $lt: now }
        },
        {
          status: 'expired',
          $push: {
            notes: `Auto-expired on ${now.toISOString()} - Schedule ended ${expiredAds.length > 1 ? '(batch update)' : ''}`
          }
        }
      );
      
      console.log('Update result:', result);
    }
    
    res.json({
      success: true,
      expired: expiredAds,
      count: expiredAds.length,
      message: expiredAds.length > 0 
        ? `Successfully marked ${expiredAds.length} ad${expiredAds.length > 1 ? 's' : ''} as expired`
        : 'No expired ads found'
    });
    
  } catch (error) {
    console.error('Error checking expired ads:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to check expired ads',
      error: error.message 
    });
  }
};

// Get metrics by placement
export const getMetricsByPlacement = async (req, res) => {
  try {
    const { placementId } = req.params;
    const { startDate, endDate } = req.query;
    
    const query = { placementId: placementId.toUpperCase() };
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }
    
    const metrics = await BannerMetrics.aggregate([
      { $match: query },
      {
        $group: {
          _id: { date: '$date', state: '$state' },
          impressions: { $sum: '$impressions' },
          clicks: { $sum: '$clicks' }
        }
      },
      { $sort: { '_id.date': -1 } }
    ]);
    
    res.json({ success: true, metrics, placement: placementId });
  } catch (error) {
    console.error('Error fetching placement metrics:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ===== IMAGE UPLOAD =====

// Upload banner ad images to Cloudinary
export const uploadBannerImages = async (req, res) => {
  try {
    const { layout } = req.body;
    const folderName = process.env.NODE_ENV === "production" ? "tagtelugu" : "tagtelugudev";
    
    // Check if files were uploaded
    if (!req.files || !req.files.images || req.files.images.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No images provided' 
      });
    }
    
    const uploadedImages = {};
    
    // Upload images for the specified layout
    for (const file of req.files.images) {
      // The originalname contains the key we set in frontend
      const fileKey = file.originalname;
      
      // Determine the image type based on the key
      // Expected format: fullDesktop, fullMobile, halfDesktop, halfMobile
      const isFullLayout = fileKey.startsWith('full');
      const isMobile = fileKey.includes('Mobile');
      
      // Only process images for the requested layout
      if ((layout === 'full' && !isFullLayout) || (layout === 'half' && isFullLayout)) {
        continue;
      }
      
      try {
        // Upload to Cloudinary
        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
          {
            folder: `${folderName}/banner-ads`,
            transformation: [{ fetch_format: "auto", quality: "auto:good" }],
            // Let Cloudinary auto-optimize without fixed dimensions
            crop: "fit",
            quality: "auto"
          }
        );
        
        // Store the uploaded image URL
        const key = isMobile ? 'mobile' : 'desktop';
        if (!uploadedImages[layout]) uploadedImages[layout] = {};
        uploadedImages[layout][key] = {
          url: result.secure_url,
          publicId: result.public_id
        };
        
      } catch (uploadError) {
        console.error('Error uploading image:', uploadError);
        // Clean up already uploaded images
        for (const layoutKey in uploadedImages) {
          for (const deviceKey in uploadedImages[layoutKey]) {
            if (uploadedImages[layoutKey][deviceKey].publicId) {
              await cloudinary.uploader.destroy(uploadedImages[layoutKey][deviceKey].publicId);
            }
          }
        }
        return res.status(500).json({ 
          success: false, 
          message: 'Failed to upload images' 
        });
      }
    }
    
    res.json({ 
      success: true, 
      images: uploadedImages,
      message: 'Images uploaded successfully' 
    });
    
  } catch (error) {
    console.error('Error in uploadBannerImages:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// Delete banner ad images from Cloudinary
export const deleteBannerImage = async (req, res) => {
  try {
    const { publicId } = req.body;
    
    if (!publicId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Public ID is required' 
      });
    }
    
    await cloudinary.uploader.destroy(publicId);
    
    res.json({ 
      success: true, 
      message: 'Image deleted successfully' 
    });
    
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};
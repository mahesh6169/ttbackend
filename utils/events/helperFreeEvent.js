// utils/events/helperFreeEvent.js - REFACTORED WITH UNIFIED IMAGE UPLOAD LOGIC

import cloudinary from '../cloudinary.js';
import Event from '../../models/eventModel.js';
import { format } from 'date-fns';

// A valid https:// URL (events-wizard-validation.md D7). Used by the promo-link backstop.
export const isHttpsUrl = (value) => {
  if (!value || typeof value !== 'string') return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' && !!u.hostname && u.hostname.includes('.');
  } catch {
    return false;
  }
};

// ✅ Parse shared fields used by both free and paid events
export const parseSharedFields = (req) => {
  const {
    title,
    category,
    dateTime,
    timeZone,
    venue,
    description,
    address,
    coordinators,
    capacity,
    maxAttendeesPerRegistration,
    registrationFields,
    isAdvertiseOnly,
    // New promotional event fields
    eventIntent,
    externalTicketUrl,
  } = req.body;

  // Validate required fields
  const requiredFields = ['title', 'dateTime', 'venue', 'description'];
  const missingFields = requiredFields.filter(field => !req.body[field]);
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
  }

  // Server backstop (events-wizard-validation.md AC22, D9): the event date must be in the future -
  // on create AND edit. The wizard blocks a past date inline; this is the wall.
  const parsedDate = new Date(dateTime);
  if (isNaN(parsedDate.getTime()) || parsedDate <= new Date()) {
    throw new Error('Event date must be in the future');
  }

  // Parse address
  let parsedAddress;
  try {
    parsedAddress = typeof address === 'string' ? JSON.parse(address) : address;
    if (!parsedAddress?.location?.coordinates || parsedAddress.location.coordinates.length !== 2) {
      throw new Error('Invalid coordinates');
    }
  } catch (err) {
    throw new Error('Invalid or missing address with valid coordinates');
  }

  // Parse coordinators
  let parsedCoordinators = [];
  try {
    if (coordinators) {
      parsedCoordinators = typeof coordinators === 'string' 
        ? JSON.parse(coordinators) 
        : coordinators;
      
      if (!Array.isArray(parsedCoordinators)) {
        throw new Error('Coordinators must be an array');
      }
    
    }
  } catch (err) {
    throw new Error(`Invalid coordinators format: ${err.message}`);
  }

  // Parse organizer
  let organizer = null;
  try {
    if (req.body.organizer) {
      const rawOrganizer = typeof req.body.organizer === 'string'
        ? JSON.parse(req.body.organizer)
        : req.body.organizer;
      
      if (!rawOrganizer.name?.trim()) {
        throw new Error('Organizer name is required');
      }
      
      organizer = {
        name: rawOrganizer.name.trim(),
        website: rawOrganizer.website?.trim() || '',
        contact: rawOrganizer.contact?.trim() || '',
        email: rawOrganizer.email?.trim().toLowerCase() || '',
        abn: rawOrganizer.abn?.trim() || '', // Australian Business Number for invoicing
        socialMedia: Array.isArray(rawOrganizer.socialMedia) ? rawOrganizer.socialMedia : []
      };
    }
  } catch (err) {
    throw new Error(`Invalid organizer data: ${err.message}`);
  }

  // Parse registration fields
  let parsedRegistrationFields = [];
  try {
    if (registrationFields) {
      parsedRegistrationFields = typeof registrationFields === 'string' 
        ? JSON.parse(registrationFields) 
        : registrationFields;
      
      if (!Array.isArray(parsedRegistrationFields)) {
        parsedRegistrationFields = [];
      }
    }
  } catch (err) {
    console.warn("⚠️ Invalid registration fields, using empty array:", err.message);
    parsedRegistrationFields = [];
  }

  // Question types + caps + blocking are finalised per event-type by finalizeRegistrationFields
  // (events-rsvp-question-types.md), called from each create/update controller with the correct
  // isPaid. This parser just returns the raw questions.

  // Determine if this is a promotional event (either explicit or via legacy isAdvertiseOnly)
  const isPromotional = eventIntent === 'promote' || isAdvertiseOnly === 'true' || isAdvertiseOnly === true;

  // Server backstop (events-wizard-validation.md AC25, D7): a promotional event must carry a valid
  // https:// external link (the buyer has nowhere else to register). The wizard enforces this inline.
  if (isPromotional) {
    const url = externalTicketUrl?.trim() || '';
    if (!isHttpsUrl(url)) {
      throw new Error('A promotional event needs a valid https:// external ticket/registration link');
    }
  }

  return {
    title,
    category: category || 'General',
    dateTime,
    timeZone: timeZone || 'Australia/Sydney',
    venue,
    description,
    parsedAddress,
    organizer,
    parsedCoordinators,
    // Backwards compatibility: set isAdvertiseOnly=true when intent is promote
    isAdvertiseOnly: isPromotional,
    // New promotional event fields
    eventIntent: eventIntent || 'host',
    externalTicketUrl: isPromotional ? (externalTicketUrl?.trim() || '') : '',
    // Promotional events have no capacity/registration
    capacity: isPromotional ? 0 : (parseInt(capacity) || 0),
    maxAttendeesPerRegistration: isPromotional ? 0 : (parseInt(maxAttendeesPerRegistration) || 5),
    parsedRegistrationFields: isPromotional ? [] : parsedRegistrationFields,
  };
};

// ✅ Parse FREE event specific fields (including recurrence) - FIXED TO PRESERVE ALL FIELDS
export const parseFreeEventFields = (req) => {
  // Parse recurrence data if it exists
  let recurrence = {
    isRecurring: false,
    repeatSchedule: [],
    endDate: null,
    parentEventId: null
  };

  try {
    // Check if recurrence data was sent
    if (req.body.recurrence) {
      const recurrenceData = typeof req.body.recurrence === 'string' 
        ? JSON.parse(req.body.recurrence) 
        : req.body.recurrence;

      if (recurrenceData.isRecurring) {
        recurrence.isRecurring = true;
        
        // Parse repeat schedule
        if (!Array.isArray(recurrenceData.repeatSchedule) || recurrenceData.repeatSchedule.length === 0) {
          throw new Error('Recurring events must have at least one schedule entry');
        }

        // 🔧 FIXED: Preserve ALL fields from frontend, not just day and time
        recurrence.repeatSchedule = recurrenceData.repeatSchedule.map((schedule) => {
          // Validate required fields
          if (!['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(schedule.day)) {
            throw new Error(`Invalid day: ${schedule.day}. Must be Sun, Mon, Tue, Wed, Thu, Fri, or Sat`);
          }
          if (!/^\d{2}:\d{2}$/.test(schedule.time)) {
            throw new Error(`Invalid time format: ${schedule.time}. Must be HH:mm format`);
          }
          
          // 🔧 CRITICAL FIX: Return the ENTIRE schedule object, not just day and time
          const result = {
            day: schedule.day,
            time: schedule.time
          };
          
          // Add utcDateTime if provided by frontend
          if (schedule.utcDateTime) {
            result.utcDateTime = schedule.utcDateTime;
          } else {
            console.error(`❌ WARNING: utcDateTime is MISSING for ${schedule.day} ${schedule.time}`);
          }
          
          // Add timeZone if provided by frontend
          if (schedule.timeZone) {
            result.timeZone = schedule.timeZone;
          }
          
          return result;
        });

        // Handle end date
        if (recurrenceData.endDate) {
          const parsedEndDate = new Date(recurrenceData.endDate);
          if (isNaN(parsedEndDate.getTime())) {
            throw new Error('Invalid end date format');
          }
          if (parsedEndDate <= new Date(req.body.dateTime)) {
            throw new Error('End date must be after the event start date');
          }
          recurrence.endDate = parsedEndDate;
        }
      }
    }
  } catch (err) {
    throw new Error(`Invalid recurrence data: ${err.message}`);
  }

  return { recurrence };
};

// ✅ UNIFIED IMAGE UPLOAD HANDLER - Borrowed from addAdvert logic
export const handleImageUploads = async (req, options = {}) => {
  const {
    maxImages = 10,
    requireImages = false
  } = options;

  const folderName = process.env.NODE_ENV === 'production' ? 'tagtelugu' : 'tagtelugudev';
  const FALLBACK_URL = process.env.FALLBACK_EVENT_IMAGE_URL;
  const FALLBACK_PUBLIC_ID = process.env.FALLBACK_EVENT_IMAGE_PUBLIC_ID || 'tagtelugudev/assets/No_Image_Available_mq5h6q';
  
  // Filter valid files - handle both array and object formats
  let fileArray = [];
  if (req.files) {
    if (Array.isArray(req.files)) {
      fileArray = req.files;
    } else if (req.files.images) {
      // When using .fields(), images are in req.files.images
      fileArray = req.files.images;
    }
  }
  const validFiles = fileArray.filter(file => file && file.size > 0);
  
  // Check maximum image limit
  if (validFiles.length > maxImages) {
    throw new Error(`Maximum ${maxImages} images allowed`);
  }

  // ✅ NEW: Validate image types and sizes
const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const maxSize = 10 * 1024 * 1024; // 10MB per image

for (let i = 0; i < validFiles.length; i++) {
  const file = validFiles[i];
  
  // Check file type
  if (!allowedTypes.includes(file.mimetype)) {
    throw new Error(`Image ${i + 1} (${file.originalname}): Only JPEG, PNG, and WebP formats are allowed`);
  }
  
  // Check file size  
  if (file.size > maxSize) {
    throw new Error(`Image ${i + 1} (${file.originalname}): File size must be under 10MB`);
  }
}

  // If no images and images are required, throw error
  if (requireImages && validFiles.length === 0) {
    throw new Error('At least one image is required');
  }

  const imagesDetails = [];

  // Upload images to Cloudinary if provided (borrowed from addAdvert)
  if (validFiles.length > 0) {
    try {
      for (let i = 0; i < validFiles.length; i++) {
        const file = validFiles[i];

        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
          {
            folder: `${folderName}/events`,
            transformation: [{ fetch_format: 'auto', quality: 'auto:good' }]
          }
        );

        // 🔧 CRITICAL FIX: Store BOTH url AND publicId
        imagesDetails.push({
          url: result.secure_url,
          publicId: result.public_id, // ✅ This was missing!
          originalFilename: file.originalname
        });
      }

      console.log(`✅ Uploaded ${validFiles.length} images successfully`);
    } catch (err) {
      console.error('❌ Cloudinary upload error:', err);
      throw new Error('Image upload failed: ' + err.message);
    }
  }
  // If no images provided, imagesDetails remains empty array

  return imagesDetails;
};

// ✅ UNIFIED IMAGE UPDATE HANDLER - Borrowed from updateAdvert logic
export const handleImageUpdates = async (req, existingImages = [], options = {}) => {
  const {
    maxImages = 10
  } = options;

  const folderName = process.env.NODE_ENV === 'production' ? 'tagtelugu' : 'tagtelugudev';
  const FALLBACK_PUBLIC_ID = process.env.FALLBACK_EVENT_IMAGE_PUBLIC_ID || 'tagtelugudev/assets/No_Image_Available_mq5h6q';
  const FALLBACK_URL = process.env.FALLBACK_EVENT_IMAGE_URL;

  // 🔧 ENHANCED: Process existing images that should be kept
  let keepImages = [];
  if (req.body.existingImages) {
  
  let existingImagesData;
  
  // Handle both single JSON array and individual entries
  if (typeof req.body.existingImages === 'string') {
    try {
      // Try to parse as JSON array first
      const parsed = JSON.parse(req.body.existingImages);
      existingImagesData = Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      // If parsing fails, treat as single string
      existingImagesData = [req.body.existingImages];
    }
  } else if (Array.isArray(req.body.existingImages)) {
    // Already an array (multiple FormData entries)
    existingImagesData = req.body.existingImages;
  } else {
    // Single object
    existingImagesData = [req.body.existingImages];
  }
      
    keepImages = existingImagesData.map((item, index) => {
      try {
        let imageData = null;
        
        if (typeof item === 'object' && item !== null) {
          imageData = item;
        } else if (typeof item === 'string') {
          if (item.startsWith('{') || item.startsWith('[')) {
            imageData = JSON.parse(item);
          } else {
            // If it's just a URL, extract publicId from it
            imageData = { url: item };
            // Extract publicId from Cloudinary URL
            const urlParts = item.split('/');
            const fileWithExt = urlParts[urlParts.length - 1];
            const fileName = fileWithExt.split('.')[0];
            const folderPath = urlParts.slice(-3, -1).join('/'); // e.g., "tagtelugudev/events"
            imageData.publicId = `${folderPath}/${fileName}`;
          }
        }
        
        // 🔧 CRITICAL: Ensure publicId exists for existing images
        if (imageData && imageData.url && !imageData.publicId) {
          // Extract publicId from Cloudinary URL
          const urlMatch = imageData.url.match(/\/([^\/]+\/[^\/]+\/[^\/]+)\.[^.]+$/);
          if (urlMatch) {
            imageData.publicId = urlMatch[1];
            console.log(`📸 Extracted publicId for existing image: ${imageData.publicId}`);
          }
        }
        
        return imageData;
      } catch (error) {
        console.error('Error parsing existing image:', error, 'Item:', item);
        return null;
      }
    }).filter(Boolean);
  }

  // Check for new images - handle both array and object formats
  let fileArray = [];
  if (req.files) {
    if (Array.isArray(req.files)) {
      fileArray = req.files;
    } else if (req.files.images) {
      // When using .fields(), images are in req.files.images
      fileArray = req.files.images;
    }
  }
  const validFiles = fileArray.filter((file) => file && file.size > 0);

// ✅ NEW: Validate new image types and sizes
if (validFiles.length > 0) {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const maxSize = 10 * 1024 * 1024; // 10MB per image
  
  for (let i = 0; i < validFiles.length; i++) {
    const file = validFiles[i];
    
    // Check file type
    if (!allowedTypes.includes(file.mimetype)) {
      throw new Error(`New image ${i + 1} (${file.originalname}): Only JPEG, PNG, and WebP formats are allowed`);
    }
    
    // Check file size
    if (file.size > maxSize) {
      throw new Error(`New image ${i + 1} (${file.originalname}): File size must be under 10MB`);
    }
  }
}

  const hasNewImages = validFiles.length > 0;
  
  // Identify images to remove from Cloudinary
  const removedImages = existingImages.filter(
    (dbImg) => {
      const shouldKeep = keepImages.some((kImg) => 
        kImg.publicId === dbImg.publicId || 
        kImg.url === dbImg.url
      );
      const shouldRemove = !shouldKeep;
      
      return shouldRemove;
    }
  );

  console.log(`🗑️ Will remove ${removedImages.length} images from Cloudinary`);

  // Delete removed images from Cloudinary
  try {
    for (const img of removedImages) {
      if (img.publicId) {
        await cloudinary.uploader.destroy(img.publicId);
      }
    }
    if (removedImages.length > 0) {
      console.log(`✅ Removed ${removedImages.length} images from Cloudinary`);
    }
  } catch (err) {
    console.error("❌ Cloudinary Deletion Error:", err.message);
    throw new Error("Failed to delete old images from cloud storage");
  }

  // Check maximum image limit
  if (keepImages.length + validFiles.length > maxImages) {
    throw new Error(`Maximum ${maxImages} images allowed`);
  }

  // Upload new images (borrowed from addAdvert)
  let newImages = [];
  if (validFiles.length > 0) {
    try {
      for (let i = 0; i < validFiles.length; i++) {
        const file = validFiles[i];

        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
          {
            folder: `${folderName}/events`,
            transformation: [{ fetch_format: 'auto', quality: 'auto:good' }],
          }
        );

        // 🔧 CRITICAL FIX: Store BOTH url AND publicId for new images too
        newImages.push({
          url: result.secure_url,
          publicId: result.public_id, // ✅ This was missing!
          originalFilename: file.originalname
        });
      }
      if (newImages.length > 0) {
        console.log(`✅ Uploaded ${newImages.length} new images successfully`);
      }
    } catch (error) {
      console.error("❌ New image upload failed:", error);
      throw new Error("Failed to upload new images");
    }
  }

  // Filter out any invalid image objects (borrowed from updateAdvert)
  keepImages = keepImages.filter(
    img => img && typeof img === 'object' && img.url && typeof img.url === 'string'
  );
  newImages = newImages.filter(
    img => img && typeof img === 'object' && img.url && typeof img.url === 'string'
  );

  // Combine kept images with new images
  const updatedImages = [...keepImages, ...newImages];
  const validImages = updatedImages.filter(
    img => img && typeof img === 'object' && img.url && typeof img.url === 'string'
  );
  
  // Final images array (can be empty)
  const finalImages = validImages;
  
  return finalImages;
};


// ✅ Generate recurring instances exactly like main event
export const generateRecurringInstances = async (parentEvent, recurrence) => {
  if (!recurrence.isRecurring || !recurrence.repeatSchedule.length) {
    return [];
  }

  const instances = [];
  const startDate = new Date(parentEvent.dateTime); // UTC from frontend (like main event)
  const endDate = new Date(recurrence.endDate); // End date is now required

  const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  
  // 🔧 NEW APPROACH: Use complete UTC datetimes (like main event)
  for (const schedule of recurrence.repeatSchedule) {
    if (schedule.utcDateTime) {
      // Parse the UTC datetime anchor
      let instanceDate = new Date(schedule.utcDateTime);
      const utcHours = instanceDate.getUTCHours();
      const utcMinutes = instanceDate.getUTCMinutes();

      // Always start with the anchor date itself
      while (instanceDate <= endDate) {
        // Only create if after the parent start date (to avoid duplicate main event)
        if (instanceDate > startDate) {
          try {
            const eventCode = await generateEventCode();
            let expiryDate = new Date(instanceDate);
            expiryDate.setUTCDate(expiryDate.getUTCDate() + 5);
            
            // Generate unique slug for child instance by appending date
            const dateStr = format(instanceDate, 'yyyy-MM-dd', { timeZone: 'UTC' });
            const childSlug = `${parentEvent.slug}-${dateStr}`;

            const instanceData = {
              ...parentEvent.toObject(),
              _id: undefined,
              slug: childSlug,
              eventCode,
              dateTime: new Date(instanceDate),
              expiryDate,
              status: determineEventStatus(instanceDate, { ...recurrence, parentEventId: parentEvent._id }),
              recurrence: {
                ...recurrence,
                parentEventId: parentEvent._id
              },
              createdAt: undefined,
              updatedAt: undefined
            };

            const instance = await Event.create(instanceData);
            instances.push(instance);
          } catch (err) {
            console.error(`❌ Failed to create instance for ${instanceDate.toISOString()}:`, err.message);
          }
        }
        // Move to next week (add 7 days)
        instanceDate = new Date(instanceDate.getTime() + 7 * 24 * 60 * 60 * 1000);
        // Set to correct hours/minutes (in case of DST, etc.)
        instanceDate.setUTCHours(utcHours, utcMinutes, 0, 0);
      }
    } else {
      console.error(`❌ CRITICAL: schedule.utcDateTime is MISSING - skipping this schedule`);
    }
  }

  console.log(`✅ Generated ${instances.length} recurring instances`);
  return instances;
};

// ✅ Generate unique event code
export const generateEventCode = async () => {
  const generateRandomCode = () => {
    return Math.random().toString(36).substr(2, 5).toUpperCase();
  };

  let attempts = 0;
  const maxAttempts = 10; // Prevent infinite loops

  while (attempts < maxAttempts) {
    const randomCode = generateRandomCode();
    const eventCode = `EVT-${randomCode}`;
    
    try {
      // Check if this event code already exists in database
      const existingEvent = await Event.findOne({ eventCode });
      
      if (!existingEvent) {
        return eventCode;
      }
      
      attempts++;
      
    } catch (error) {
      console.error('❌ Database error while checking event code uniqueness:', error);
      // Fallback to timestamp-based approach if database fails
      return `EVT-${Date.now()}-${generateRandomCode()}`;
    }
  }
  
  // Fallback if we hit max attempts (extremely unlikely)
  console.warn(`⚠️ Max attempts reached for event code generation, using timestamp fallback`);
  return `EVT-${Date.now()}-${generateRandomCode()}`;
};

// ✅ Calculate expiry date for events
export const calculateExpiryDate = (dateTime, recurrence = null) => {
  let expiryDate = new Date(dateTime);
  
  // For recurring events, use end date (now required)
  if (recurrence?.isRecurring) {
    expiryDate = new Date(recurrence.endDate);
  }
  
  expiryDate.setDate(expiryDate.getDate() + 5);
  return expiryDate;
};
 
// ✅ Determine event status based on current date (Option 2: Smart recurring logic)
export const determineEventStatus = (dateTime, recurrence = null) => {
  const now = new Date();
  
  // For parent recurring events, check if series has ended
  if (recurrence?.isRecurring && !recurrence?.parentEventId) {
    // This is a parent recurring event
    if (recurrence.endDate) {
      // Series has an end date - check if it has passed
      return new Date(recurrence.endDate) < now ? 'expired' : 'active';
    }
    // No end date = infinite series = always active
    return 'active';
  }
  
  // For single events or recurring instances, use the actual event date
  const eventDate = new Date(dateTime);
  return eventDate < now ? 'expired' : 'active';
};

/**
 * Generate registration number with event code pattern
 * Format: REG-KYJDS-001, REG-KYJDS-002, etc.
 */
export const generateRegistrationNumber = async (eventCode) => {
  try {
    // Extract the code part from EVT-KYJDS -> KYJDS
    const codepart = eventCode.replace('EVT-', '');
    
    // Import here to avoid circular dependency
    const FreeTicket = (await import('../../models/freeTicket.js')).default;
    
    // Find the highest registration number for this event code pattern
    const latestRegistration = await FreeTicket.findOne({
      registrationNumber: { $regex: `^REG-${codepart}-` }
    })
    .sort({ registrationNumber: -1 }) // Sort descending to get latest
    .select('registrationNumber');
    
    let nextNumber = 1;
    
    if (latestRegistration) {
      // Extract the sequence number from the latest registration
      // REG-KYJDS-003 -> extract 003 -> convert to 3 -> increment to 4
      const regNumberParts = latestRegistration.registrationNumber.split('-');
      const lastSequence = regNumberParts[regNumberParts.length - 1];
      nextNumber = parseInt(lastSequence) + 1;
    }
    
    // Format with leading zeros (001, 002, etc.)
    const sequenceStr = nextNumber.toString().padStart(3, '0');
    
    const registrationNumber = `REG-${codepart}-${sequenceStr}`;
    
    return registrationNumber;
    
  } catch (error) {
    console.error('❌ Error generating registration number:', error);
    
    // Fallback to original logic if database query fails
    const fallbackReg = `REG-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    
    console.warn(`⚠️ Using fallback registration number: ${fallbackReg}`);
    return fallbackReg;
  }
};

/**
 * Create event snapshot for free ticket data independence
 * @param {Object} event - Event document
 * @returns {Object} Event snapshot object
 */
export const createFreeEventSnapshot = (event) => {
  return {
    eventCode: event.eventCode,
    title: event.title,
    dateTime: event.dateTime,
    timeZone: event.timeZone,
    venue: event.venue,
    address: event.address || null, // Store full address object
    category: event.category,
    capacity: event.capacity || 0,
    organizer: {
      name: event.organizer?.name || '',
      email: event.organizer?.email || '',
      phone: event.organizer?.contact || ''
    },
    postedBy: event.postedBy._id ? event.postedBy._id.toString() : event.postedBy.toString()
  };
};

/**
 * Calculate current free event registrations (count total attendees)
 * @param {String} eventId - Event ID
 * @returns {Number} Number of attendees registered
 */
export const calculateCurrentFreeRegistrations = async (eventId) => {
  try {
    // Import here to avoid circular dependency
    const FreeTicket = (await import('../../models/freeTicket.js')).default;
    const mongoose = (await import('mongoose')).default;
    
    // Convert string to ObjectId if needed
    const objectId = mongoose.Types.ObjectId.isValid(eventId) 
      ? new mongoose.Types.ObjectId(eventId) 
      : eventId;
    
    // Find all active registrations for this event
    // Include both 'registered' and 'checkedin' status as both count towards capacity
    const freeTickets = await FreeTicket.find({
      event: objectId,
      status: { $in: ['registered', 'checkedin'] } // Count both registered and checked-in attendees
    });
    
    // Sum up all attendees across all registrations
    const totalAttendees = freeTickets.reduce((total, ticket) => {
      return total + (ticket.attendees ? ticket.attendees.length : 0);
    }, 0);

    return totalAttendees;
  } catch (error) {
    console.error('❌ Error calculating free registrations:', error);
    return 0;
  }
};
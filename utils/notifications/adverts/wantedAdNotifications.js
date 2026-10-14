import Advert from '../../../models/advertModel.js';
import Message from '../../../models/messageModel.js';
import { sendEmail } from '../sendEmail.js';
import { encryptMessage } from '../../chat/encryption.js';
import { getIO } from '../../../socket/index.js';

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'TagTelugu';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'TagTelugu Team';

/**
 * Main function called when a wanted ad is created.
 * Finds matching providers and sends notifications (email + chat).
 * This function should be called without await (fire-and-forget).
 *
 * @param {Object} wantedAd - The newly created wanted ad (populated with postedBy)
 */
export const notifyMatchingProviders = async (wantedAd) => {
  try {
    console.log(`🔍 Finding matching providers for wanted ad: ${wantedAd._id}`);

    // Find matching offered ads
    const matches = await findMatchingOfferedAds(wantedAd);

    if (matches.length === 0) {
      console.log(`ℹ️ No matching providers found for wanted ad: ${wantedAd._id}`);
      return;
    }

    console.log(`📧 Notifying ${matches.length} providers for wanted ad: ${wantedAd._id}`);

    // Process each match
    for (const offeredAd of matches) {
      try {
        await processMatch(wantedAd, offeredAd);
      } catch (err) {
        console.error(`❌ Failed to notify provider ${offeredAd.postedBy._id}: ${err.message}`);
        // Continue with other matches
      }
    }

    console.log(`✅ Finished notifying providers for wanted ad: ${wantedAd._id}`);
  } catch (error) {
    console.error(`❌ Error in notifyMatchingProviders: ${error.message}`);
    // Don't rethrow - this is fire-and-forget
  }
};

/**
 * Find offered ads that match the wanted ad criteria.
 *
 * Matching criteria:
 * - Same subcategory
 * - adType: 'offered'
 * - notifyOnWanted: true
 * - status: 'active'
 * - Not expired
 * - Not posted by the same user (self-prevention)
 * - Location: within 100km OR offered ad is nationwide OR wanted ad is nationwide
 */
const findMatchingOfferedAds = async (wantedAd) => {
  const now = new Date();

  // Base query
  const query = {
    subcategory: wantedAd.subcategory,
    adType: 'offered',
    notifyOnWanted: true,
    status: 'active',
    expiresAt: { $gt: now },
    postedBy: { $ne: wantedAd.postedBy._id || wantedAd.postedBy }, // Self-prevention
  };

  // Location filter
  // If wanted ad is nationwide, no location filter needed
  const wantedIsNationwide = wantedAd.isNationwide === true;

  if (!wantedIsNationwide) {
    // Wanted ad is local - match within 100km OR nationwide offered ads
    const wantedCoords = wantedAd.address?.location?.coordinates;

    if (wantedCoords && wantedCoords[0] !== 0 && wantedCoords[1] !== 0) {
      // 100km in radians (Earth radius = 6378.1 km)
      const radiusInRadians = 100 / 6378.1;

      query.$or = [
        { isNationwide: true },
        {
          'address.location': {
            $geoWithin: {
              $centerSphere: [wantedCoords, radiusInRadians]
            }
          }
        }
      ];
    }
    // If no valid coordinates (shouldn't happen due to validation), skip location filter
  }
  // If wanted ad is nationwide, all matching offered ads are included (no location filter)

  // Execute query with populated postedBy for email fallback
  const matches = await Advert.find(query)
    .populate('postedBy', 'name email')
    .lean();

  return matches;
};

/**
 * Process a single match: create chat (if applicable) and send email.
 */
const processMatch = async (wantedAd, offeredAd) => {
  const isCuratedListing = offeredAd.isCuratedListing === true;
  const providerId = offeredAd.postedBy._id.toString();
  const consumerId = (wantedAd.postedBy._id || wantedAd.postedBy).toString();

  // Get recipient email
  const recipientEmail = getRecipientEmail(offeredAd);
  if (!recipientEmail) {
    console.log(`ℹ️ Skipping provider ${providerId} - no valid email`);
    return;
  }

  let chatLink;

  // Create chat for provider listings only
  if (!isCuratedListing) {
    await createInitialChat(wantedAd, offeredAd);
    chatLink = `${websiteUrl}/chat/advert/${wantedAd._id}?otherUser=${consumerId}`;
  } else {
    // Curated listings get link to wanted ad page
    chatLink = `${websiteUrl}/listings/${wantedAd.slug}`;
  }

  // Send email
  await sendWantedAdEmail(recipientEmail, wantedAd, offeredAd, chatLink);
};

/**
 * Get recipient email with fallback logic.
 * - Curated listings: contactInfo.email only (no fallback)
 * - Provider listings: contactInfo.email OR postedBy.email
 */
const getRecipientEmail = (offeredAd) => {
  const contactEmail = offeredAd.contactInfo?.email;
  const accountEmail = offeredAd.postedBy?.email;

  if (offeredAd.isCuratedListing) {
    // Curated listings: no fallback
    return contactEmail || null;
  }

  // Provider listings: fallback to account email
  return contactEmail || accountEmail || null;
};

/**
 * Create initial chat message on behalf of consumer.
 */
const createInitialChat = async (wantedAd, offeredAd) => {
  const consumerId = wantedAd.postedBy._id || wantedAd.postedBy;
  const providerId = offeredAd.postedBy._id;

  // Build initial message content
  const location = wantedAd.address?.suburb && wantedAd.address?.state
    ? `${wantedAd.address.suburb}, ${wantedAd.address.state}`
    : wantedAd.address?.suburb || wantedAd.address?.state || '';

  const messageContent = `Hi, I've posted a wanted ad that matches your service.

Title: ${wantedAd.title}

${wantedAd.description || ''}

${location ? `Location: ${location}` : ''}`.trim();

  // Encrypt the message
  const encryptedMessage = encryptMessage(messageContent);

  // Create the message
  const newMessage = await Message.create({
    relatedTo: 'advert',
    advert: wantedAd._id,
    owner: consumerId,
    participant: providerId,
    senderRole: 'owner',
    message: encryptedMessage,
    readBy: null,
    replyTo: null,
  });

  // Emit socket event for real-time notification
  try {
    const io = getIO();
    const decryptedMessage = {
      ...newMessage.toObject(),
      message: messageContent, // Decrypted for socket
      canDelete: false,
      isDeleted: false,
    };
    io.to(providerId.toString()).emit('newMessage', decryptedMessage);
  } catch (socketErr) {
    console.warn(`⚠️ Socket emit failed: ${socketErr.message}`);
    // Continue - email will still be sent
  }

  console.log(`💬 Created chat for provider ${providerId} on wanted ad ${wantedAd._id}`);
};

/**
 * Send email notification to provider about the wanted ad.
 */
const sendWantedAdEmail = async (recipientEmail, wantedAd, offeredAd, chatLink) => {
  const location = wantedAd.address?.suburb && wantedAd.address?.state
    ? `${wantedAd.address.suburb}, ${wantedAd.address.state}`
    : wantedAd.address?.suburb || wantedAd.address?.state || '';

  // Build contact info section
  let contactSection = '';
  if (wantedAd.contactInfo?.mobile || wantedAd.contactInfo?.email) {
    const contactParts = [];
    if (wantedAd.contactInfo.mobile) contactParts.push(wantedAd.contactInfo.mobile);
    if (wantedAd.contactInfo.email) contactParts.push(wantedAd.contactInfo.email);
    contactSection = `<p style="margin: 10px 0 0 0; color: #666;"><strong>Contact:</strong> ${contactParts.join(' | ')}</p>`;
  }

  const isCuratedListing = offeredAd.isCuratedListing === true;
  const buttonText = isCuratedListing ? 'View Listing' : 'View & Respond';

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>

      <p>A new listing has been posted on ${platformName} that matches your service:</p>

      <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
        <h3 style="margin: 0 0 10px 0; color: #1a1a1a;">${wantedAd.title}</h3>
        <p style="margin: 0 0 10px 0; white-space: pre-wrap;">${wantedAd.description || ''}</p>
        ${location ? `<p style="margin: 0; color: #666;"><strong>Location:</strong> ${location}</p>` : ''}
        ${contactSection}
      </div>

      <p>
        <a href="${chatLink}"
           style="display: inline-block; background: #0d9488; color: white; padding: 10px 20px; border-radius: 5px; text-decoration: none;">
          ${buttonText}
        </a>
      </p>

      <p style="color: #666; font-size: 12px; margin-top: 20px;">
        You received this email because you opted in to notifications for new listings in ${wantedAd.subcategory}.
        To stop receiving these emails, edit your listing and uncheck "Notify me when wanted ads are posted".
      </p>

      <p>Thank you,<br/>— ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: recipientEmail,
      subject: `${platformName}: New listing matching your service in ${wantedAd.subcategory}`,
      html: htmlContent,
    });
    console.log(`📧 Email sent to ${recipientEmail} for wanted ad ${wantedAd._id}`);
  } catch (error) {
    console.error(`❌ Failed to send email to ${recipientEmail}: ${error.message}`);
    throw error;
  }
};

import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL;
const senderEmail = process.env.SENDER_EMAIL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Admin Team';

// --- Shared email presentation (matches the enhanced events emails) ---

// A bordered card table row: shaded bold label + value.
const createTableRow = (label, value) => `
    <tr>
      <td style="padding: 8px; border: 1px solid #e5e7eb; background-color: #f9fafb; font-weight: 600; text-align: left; width: 40%;">${label}</td>
      <td style="padding: 8px; border: 1px solid #e5e7eb; text-align: left;">${value ?? 'N/A'}</td>
    </tr>`;

// Preserve user-entered line breaks (e.g. multiline terms) in HTML email.
const nl2br = (text) => (text || '').replace(/\r?\n/g, '<br/>');

// A section: heading + a card table of rows.
const tableSection = (heading, rows) => `
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">${heading}</h3>
        <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
          ${rows}
        </table>
      </div>`;

// The outer shell: 600px container + teal header banner + body.
const emailShell = (title, intro, body) => `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333; max-width: 600px;">
      <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
        <h2 style="color: #0d9488; margin-top: 0;">${title}</h2>
        ${intro ? `<p style="font-size: 16px; margin-bottom: 0;">${intro}</p>` : ''}
      </div>
      ${body}
    </div>`;

// Store-worker validation callout (Store ID + how to validate) — neutral gray box
// matching the events emails; teal only on the link.
const validationCallout = (store) => `
  <div style="background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px;">
    <p style="margin: 0 0 14px 0; font-size: 16px;"><strong>Your Store ID:</strong> <span style="font-family: monospace; font-size: 18px; letter-spacing: 1px; background: #ffffff; padding: 3px 10px; border-radius: 4px; border: 1px solid #e5e7eb;">${store.storeIdentifier}</span></p>
    <h3 style="margin: 0 0 10px 0; color: #374151;">How can you validate coupon code</h3>
    <ol style="margin: 0; padding-left: 20px; color: #333;">
      <li style="margin-bottom: 6px;">Visit <a href="${websiteUrl}/validate" style="color: #0d9488; font-weight: bold;">${websiteUrl}/validate</a> on your mobile</li>
      <li style="margin-bottom: 6px;">Enter your Store ID</li>
      <li>Then scan QR code or enter each customer's code to validate.</li>
    </ol>
  </div>`;

// --- Valid days / hours formatting (offer schedule; empty = every day / any time) ---
const DAY_LABELS = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };
const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const formatValidDays = (validDays) => {
  if (!Array.isArray(validDays) || validDays.length === 0) return null; // empty = every day
  const label = DAY_ORDER.filter(d => validDays.includes(d)).map(d => DAY_LABELS[d]).join(', ');
  return label || null;
};

const formatTime = (hhmm) => {
  if (!hhmm || typeof hhmm !== 'string' || !hhmm.includes(':')) return hhmm || '';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'pm' : 'am';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12}${period}` : `${hour12}:${String(m).padStart(2, '0')}${period}`;
};

const formatValidHours = (validHours) => {
  if (!Array.isArray(validHours) || validHours.length === 0) return null;
  const windows = validHours.filter(w => w && w.start && w.end).map(w => `${formatTime(w.start)}–${formatTime(w.end)}`);
  return windows.length ? windows.join(', ') : null;
};

// Card rows for the offer's valid days + hours (only when set).
const scheduleRows = (campaign) => {
  const days = formatValidDays(campaign.validDays);
  const hours = formatValidHours(campaign.validHours);
  return (days ? createTableRow('Valid days', days) : '')
    + (hours ? createTableRow('Valid hours', hours) : '');
};

/**
 * Send notifications when a coupon code is generated
 * Fire-and-forget pattern (non-blocking)
 */
export const codeGeneratedNotification = async ({ couponCode, campaign, store, user }) => {
  if (!user?.email) {
    console.warn('⚠️ User email not available for code generation notification');
    return;
  }

  const formattedExpiryDate = new Date(campaign.expiryDate).toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Get campaign stats from model fields (no queries needed!)
  const totalGenerated = campaign.totalGenerated;
  const totalRedeemed = campaign.totalRedeemed;

  // Generate QR code URL (using external API)
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${couponCode.userCode}`;

  // Email to user
  const userHtml = emailShell(
    'Discount Code Generated',
    `Hi ${user.firstName || 'there'}, your discount code has been generated successfully!`,
    `
    <div style="text-align: center; margin-bottom: 20px;">
      <div style="font-size: 28px; font-weight: 700; letter-spacing: 3px; color: #0d9488;">${couponCode.userCode}</div>
      <img src="${qrCodeUrl}" alt="QR Code" style="display: block; margin: 12px auto 0; width: 200px; height: 200px; border: 3px solid #0d9488; border-radius: 8px; padding: 8px; background-color: #ffffff;" />
    </div>
    ${tableSection('Store Details',
      createTableRow('Store / Business', store.storeName)
      + (store.address?.formattedAddress ? createTableRow('Address', `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(store.address.formattedAddress)}" style="color: #0d9488;">${store.address.formattedAddress}</a>`) : '')
      + (store.contactInfo?.phone ? createTableRow('Phone', `<a href="tel:${store.contactInfo.phone}" style="color: #0d9488;">${store.contactInfo.phone}</a>`) : '')
    )}
    ${tableSection('Offer',
      createTableRow('Discount', `${campaign.discount} on ${campaign.discountProduct}`)
      + createTableRow('Valid until', formattedExpiryDate)
      + scheduleRows(campaign)
      + (campaign.termsConditions ? createTableRow('Terms & Conditions', nl2br(campaign.termsConditions)) : '')
    )}
    <p><strong>How to redeem:</strong> Present the code or QR code in store.</p>
    <p><strong>View your codes anytime:</strong> ${platformName} &gt; Profile &gt; My Discount Codes</p>
    <p>Thank you,<br/>— ${platformTeam}</p>
    `
  );

  // Email to store
  const storeHtml = emailShell(
    'New Discount Code Generated',
    `Hi ${store.storeName} Team, a new discount code has been generated for your campaign.`,
    `
    ${validationCallout(store)}
    ${tableSection('Code Details',
      createTableRow('Code', couponCode.fullCode)
      + createTableRow('Campaign', campaign.campaignName)
      + createTableRow('Discount', `${campaign.discount} on ${campaign.discountProduct}`)
      + createTableRow('Expires', formattedExpiryDate)
      + scheduleRows(campaign)
    )}
    ${tableSection('Campaign Stats',
      createTableRow('Maximum codes', campaign.maxRedemptions > 0 ? campaign.maxRedemptions : 'Unlimited')
      + createTableRow('Generated', totalGenerated)
      + createTableRow('Redeemed', totalRedeemed)
    )}
    <p>Regards,<br/>— ${platformTeam}</p>
    `
  );

  // Email to admin
  const adminEmail = process.env.ADMIN_EMAIL || senderEmail;
  const adminHtml = emailShell(
    'New Coupon Code Generated',
    '',
    `
    ${tableSection('Code Details',
      createTableRow('Code', couponCode.fullCode)
      + createTableRow('Store', `${store.storeName} (${store.storeIdentifier})`)
      + createTableRow('Campaign', campaign.campaignName)
      + createTableRow('Discount', `${campaign.discount} on ${campaign.discountProduct}`)
    )}
    ${tableSection('Campaign Stats',
      createTableRow('Maximum codes', campaign.maxRedemptions > 0 ? campaign.maxRedemptions : 'Unlimited')
      + createTableRow('Generated', totalGenerated)
      + createTableRow('Redeemed', totalRedeemed)
    )}
    `
  );

  try {
    // Send to user
    await sendEmail({
      to: user.email,
      subject: `Coupon Code Generated - ${store.storeName}`,
      html: userHtml,
    });
    console.log(`✅ Code generation email sent to user: ${user.email}`);

    // Send to store (if email available)
    if (store.contactInfo?.email) {
      await sendEmail({
        to: store.contactInfo.email,
        subject: `Coupon Code Generated - ${store.storeName} - ${campaign.campaignName}`,
        html: storeHtml,
      });
      console.log(`✅ Code generation email sent to store: ${store.contactInfo.email}`);
    }

    // Send to admin
    await sendEmail({
      to: adminEmail,
      subject: `Coupon Code Generated - ${store.storeName} - ${campaign.campaignName}`,
      html: adminHtml,
    });
    console.log(`✅ Code generation email sent to admin: ${adminEmail}`);

  } catch (error) {
    console.error(`❌ Failed to send code generation notifications: ${error.message}`);
  }
};

/**
 * Send notifications when a new campaign is created
 * Fire-and-forget pattern (non-blocking)
 */
export const campaignCreatedNotification = async ({ campaign, store }) => {
  const formattedExpiryDate = new Date(campaign.expiryDate).toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Email to store
  const storeHtml = emailShell(
    'New Campaign Created',
    `Hi ${store.storeName} Team, a <strong>new</strong> discount campaign has been created for your store!`,
    `
    ${validationCallout(store)}
    ${tableSection(campaign.campaignName,
      createTableRow('Status', campaign.isActive ? '✅ Active' : '⏸️ Inactive')
      + createTableRow('Discount', campaign.discount)
      + createTableRow('Product/Service/Item', campaign.discountProduct)
      + createTableRow('Valid until', formattedExpiryDate)
      + scheduleRows(campaign)
      + (campaign.maxRedemptions > 0 ? createTableRow('Max codes', campaign.maxRedemptions) : '')
      + (campaign.termsConditions ? createTableRow('Terms & Conditions', nl2br(campaign.termsConditions)) : '')
    )}
    <p>Customers can now generate discount codes for this campaign. You'll receive notifications when codes are generated and redeemed.</p>
    <p>Thank you for being part of ${platformName}!</p>
    <p>Best regards,<br/>— ${platformTeam}</p>
    `
  );

  try {
    // Send to store (if email available)
    if (store.contactInfo?.email) {
      await sendEmail({
        to: store.contactInfo.email,
        subject: `Coupon Code Created: ${campaign.campaignName}`,
        html: storeHtml,
      });
      console.log(`✅ Campaign creation email sent to store: ${store.contactInfo.email}`);
    } else {
      console.warn(`⚠️ Store email not available for campaign creation notification: ${store.storeName}`);
    }

  } catch (error) {
    console.error(`❌ Failed to send campaign creation notifications: ${error.message}`);
  }
};

/**
 * Send notifications when a campaign is updated
 * Fire-and-forget pattern (non-blocking)
 */
export const campaignUpdatedNotification = async ({ campaign, store, changes }) => {
  if (!changes || Object.keys(changes).length === 0) {
    console.log('⏭️ No significant changes to notify');
    return;
  }

  const formattedExpiryDate = new Date(campaign.expiryDate).toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Email to store
  const storeHtml = emailShell(
    'Campaign Updated',
    `Hi ${store.storeName} Team, your discount campaign has been <strong>updated</strong>.`,
    `
    ${validationCallout(store)}
    ${tableSection(campaign.campaignName,
      createTableRow('Status', campaign.isActive ? '✅ Active' : '⏸️ Inactive')
      + createTableRow('Discount', campaign.discount)
      + createTableRow('Product/Service/Item', campaign.discountProduct)
      + createTableRow('Valid until', formattedExpiryDate)
      + scheduleRows(campaign)
      + (campaign.maxRedemptions > 0 ? createTableRow('Max codes', campaign.maxRedemptions) : '')
      + (campaign.termsConditions ? createTableRow('Terms & Conditions', nl2br(campaign.termsConditions)) : '')
    )}
    <p>You'll receive notifications when codes are generated and redeemed.</p>
    <p>Thank you for being part of ${platformName}!</p>
    <p>Best regards,<br/>— ${platformTeam}</p>
    `
  );

  try {
    // Send to store (if email available)
    if (store.contactInfo?.email) {
      await sendEmail({
        to: store.contactInfo.email,
        subject: `Coupon Code Updated: ${campaign.campaignName}`,
        html: storeHtml,
      });
      console.log(`✅ Campaign update email sent to store: ${store.contactInfo.email}`);
    } else {
      console.warn(`⚠️ Store email not available for campaign update notification: ${store.storeName}`);
    }

  } catch (error) {
    console.error(`❌ Failed to send campaign update notifications: ${error.message}`);
  }
};

/**
 * Send notifications when a coupon code is redeemed
 * Fire-and-forget pattern (non-blocking)
 */
export const codeRedeemedNotification = async ({ couponCode, campaign, store, user }) => {
  if (!user?.email) {
    console.warn('⚠️ User email not available for code redemption notification');
    return;
  }

  const redeemedDate = new Date(couponCode.redeemedAt).toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Get campaign stats from model fields (no queries needed!)
  const totalGenerated = campaign.totalGenerated;
  const totalRedeemed = campaign.totalRedeemed;

  // Email to user
  const userHtml = emailShell(
    'Discount Code Redeemed',
    `Hi ${user.firstName || 'there'}, your discount code has been redeemed successfully!`,
    `
    <div style="background-color: #f3f4f6; padding: 20px; margin-bottom: 20px; border-radius: 8px; text-align: center;">
      <h2 style="margin: 0; font-size: 24px; color: #1f2937;">${couponCode.userCode}</h2>
      <p style="margin: 10px 0 0 0; color: #059669; font-weight: bold;">✓ REDEEMED</p>
    </div>
    ${tableSection('Details',
      createTableRow('Store', store.storeName)
      + createTableRow('Discount', `${campaign.discount} on ${campaign.discountProduct}`)
      + createTableRow('Redeemed on', redeemedDate)
    )}
    <p>Thank you for using ${platformName}!</p>
    <p>Best regards,<br/>— ${platformTeam}</p>
    `
  );

  // Email to store
  const storeHtml = emailShell(
    'Discount Code Redeemed',
    `Hi ${store.storeName} Team, a discount code has been redeemed at your store.`,
    `
    ${tableSection('Redemption Details',
      createTableRow('Code', couponCode.fullCode)
      + createTableRow('Campaign', campaign.campaignName)
      + createTableRow('Discount', `${campaign.discount} on ${campaign.discountProduct}`)
      + createTableRow('Redeemed at', redeemedDate)
    )}
    ${tableSection('Campaign Stats',
      createTableRow('Maximum codes', campaign.maxRedemptions > 0 ? campaign.maxRedemptions : 'Unlimited')
      + createTableRow('Generated', totalGenerated)
      + createTableRow('Redeemed', totalRedeemed)
    )}
    <p>Regards,<br/>— ${platformTeam}</p>
    `
  );

  // Email to admin
  const adminEmail = process.env.ADMIN_EMAIL || senderEmail;
  const adminHtml = emailShell(
    'Discount Code Redeemed',
    '',
    `
    ${tableSection('Redemption Details',
      createTableRow('Code', couponCode.fullCode)
      + createTableRow('Store', `${store.storeName} (${store.storeIdentifier})`)
      + createTableRow('Campaign', campaign.campaignName)
      + createTableRow('Discount', `${campaign.discount} on ${campaign.discountProduct}`)
      + createTableRow('Redeemed at', redeemedDate)
    )}
    ${tableSection('Campaign Stats',
      createTableRow('Maximum codes', campaign.maxRedemptions > 0 ? campaign.maxRedemptions : 'Unlimited')
      + createTableRow('Generated', totalGenerated)
      + createTableRow('Redeemed', totalRedeemed)
    )}
    `
  );

  try {
    // Send to user
    await sendEmail({
      to: user.email,
      subject: `Coupon Code Redeemed - ${store.storeName}`,
      html: userHtml,
    });
    console.log(`✅ Code redemption email sent to user: ${user.email}`);

    // Send to store (if email available)
    if (store.contactInfo?.email) {
      await sendEmail({
        to: store.contactInfo.email,
        subject: `Coupon Code Redeemed - ${store.storeName} - ${campaign.campaignName}`,
        html: storeHtml,
      });
      console.log(`✅ Code redemption email sent to store: ${store.contactInfo.email}`);
    }

    // Send to admin
    await sendEmail({
      to: adminEmail,
      subject: `Coupon Code Redeemed - ${store.storeName} - ${campaign.campaignName}`,
      html: adminHtml,
    });
    console.log(`✅ Code redemption email sent to admin: ${adminEmail}`);

  } catch (error) {
    console.error(`❌ Failed to send code redemption notifications: ${error.message}`);
  }
};

/**
 * Notify customers holding un-redeemed codes that an offer has been withdrawn.
 * Fire-and-forget. Called from deleteCampaign BEFORE the cascade delete, and only
 * when the campaign was still valid (not expired) — otherwise the codes were already dead.
 * @param {Array} codes - un-redeemed CouponCodes with userId populated (firstName, email)
 */
export const campaignRemovedNotification = async ({ campaign, store, codes }) => {
  for (const code of codes) {
    const user = code.userId;
    if (!user?.email) continue;

    const html = emailShell(
      'Coupon Offer No Longer Available',
      `Hi ${user.firstName || 'there'}, we're letting you know that ${store.storeName} has ended the offer below, so the coupon code you saved is no longer valid.`,
      `
      ${tableSection('Offer Details',
        createTableRow('Store', store.storeName)
        + createTableRow('Discount', `${campaign.discount} on ${campaign.discountProduct}`)
        + createTableRow('Your code', code.userCode)
      )}
      <p>This offer is no longer being honoured by the business, so <strong>please don't visit the store to redeem this code</strong>. We wanted to let you know so you don't make a wasted trip.</p>
      <p>Thanks for using ${platformName},<br/>— ${platformTeam}</p>
      `
    );

    try {
      await sendEmail({
        to: user.email,
        subject: `Coupon Offer No Longer Available - ${store.storeName}`,
        html,
      });
      console.log(`✅ Offer-withdrawn email sent to customer: ${user.email}`);
    } catch (error) {
      console.error(`❌ Failed to send offer-withdrawn email to ${user.email}: ${error.message}`);
    }
  }
};

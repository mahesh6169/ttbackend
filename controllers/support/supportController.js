import asyncHandler from 'express-async-handler';
import { sendReportEmail } from '../../utils/notifications/support/sendReportEmail.js';
import { sendContactEmail } from '../../utils/notifications/support/sendContactEmail.js';
import { sendRemovalEmail } from '../../utils/notifications/support/sendRemovalEmail.js';
import { verifyRecaptcha } from '../../utils/verifyRecaptcha.js';

// @desc    Submit a report (for listing, event, thread, deal, discount)
// @route   POST /api/support/report
// @access  Public
export const submitReport = asyncHandler(async (req, res) => {
  const { type, id, title, itemUrl, reason, message, senderName, senderEmail, captchaToken } = req.body;

  // ✅ Check required fields (message is optional)
  if (!type || !id || !title || !reason) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // ✅ Verify CAPTCHA
  if (!captchaToken) {
    return res.status(400).json({ success: false, message: 'reCAPTCHA token missing' });
  }

  try {
    const recaptchaResult = await verifyRecaptcha(captchaToken);
    console.log('✅ reCAPTCHA verified for report:', recaptchaResult);
  } catch (error) {
    return res.status(400).json({ success: false, message: 'reCAPTCHA verification failed' });
  }

  // ✅ Proceed with sending the report email
  try {
    await sendReportEmail({ type, id, title, itemUrl, reason, message, senderName, senderEmail });
    res.status(200).json({ success: true, message: 'Report submitted successfully' });
  } catch (error) {
    console.error('❌ Error sending report email:', error);
    res.status(500).json({ success: false, message: 'Failed to send report', error: error.message });
  }
})

// @desc    Submit a contact message (general enquiries)
// @route   POST /api/support/contact
// @access  Public
export const submitContact = asyncHandler(async (req, res) => {
  const { title, category, message, senderName, senderEmail, mobile, captchaToken } = req.body;

  // ✅ Validate required fields
  if (!title || !category || !message) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // ✅ Check CAPTCHA
  if (!captchaToken) {
    return res.status(400).json({ success: false, message: 'reCAPTCHA token missing' });
  }

  try {
    const recaptchaResult = await verifyRecaptcha(captchaToken);
    console.log('✅ reCAPTCHA verified for contact:', recaptchaResult);
  } catch (error) {
    return res.status(400).json({ success: false, message: 'reCAPTCHA verification failed' });
  }

  // ✅ Proceed with sending the contact email
  try {
    await sendContactEmail({ title, category, message, senderName, senderEmail, mobile });
    res.status(200).json({ success: true, message: 'Contact message submitted successfully' });
  } catch (error) {
    console.error('❌ Error sending contact email:', error);
    res.status(500).json({ success: false, message: 'Failed to send contact message', error: error.message });
  }
});

// @desc    Submit a removal request (for listing or event)
// @route   POST /api/support/removal
// @access  Public
export const submitRemoval = asyncHandler(async (req, res) => {
  const { type, id, title, itemUrl, message, senderName, senderEmail, captchaToken } = req.body;

  // ✅ Check required fields (message is optional)
  if (!type || !id || !title) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // ✅ Validate type is listing, event, or deal
  if (!['listing', 'event', 'deal'].includes(type)) {
    return res.status(400).json({ success: false, message: 'Invalid removal type. Must be listing, event, or deal.' });
  }

  // ✅ Verify CAPTCHA
  if (!captchaToken) {
    return res.status(400).json({ success: false, message: 'reCAPTCHA token missing' });
  }

  try {
    const recaptchaResult = await verifyRecaptcha(captchaToken);
    console.log('✅ reCAPTCHA verified for removal:', recaptchaResult);
  } catch (error) {
    return res.status(400).json({ success: false, message: 'reCAPTCHA verification failed' });
  }

  // ✅ Proceed with sending the removal email
  try {
    await sendRemovalEmail({ type, id, title, itemUrl, message, senderName, senderEmail });
    res.status(200).json({ success: true, message: 'Removal request submitted successfully' });
  } catch (error) {
    console.error('❌ Error sending removal email:', error);
    res.status(500).json({ success: false, message: 'Failed to send removal request', error: error.message });
  }
});
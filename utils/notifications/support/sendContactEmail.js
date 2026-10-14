import { sendEmail } from '../sendEmail.js';

export const sendContactEmail = async ({ title, category, message, senderName, senderEmail, mobile }) => {
  const emailContent = `
Contact Form Submission

Category: ${category}
Subject: ${title}
From: ${senderName || 'Anonymous'} (${senderEmail || 'N/A'})
Mobile: ${mobile || 'N/A'}

Message:
${message}
  `;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>New contact form submission received:</p>
      <p><strong>Category:</strong> ${category}<br>
      <strong>Subject:</strong> ${title}<br>
      <strong>From:</strong> ${senderName || 'Anonymous'} (${senderEmail || 'N/A'})<br>
      <strong>Mobile:</strong> ${mobile || 'N/A'}</p>
      <p><strong>Message:</strong><br>
      ${message.replace(/\n/g, '<br>')}</p>
      <p>— ${process.env.NOTIFICATION_PLATFORM_NAME || 'Desify'} Contact System</p>
    </div>
  `;

  try {
    await sendEmail({
      from: { 
        email: process.env.CONTACT_SENDER_EMAIL || process.env.SENDER_EMAIL,
        name: `${process.env.NOTIFICATION_PLATFORM_NAME || 'Desify'} Contact`
      },
      to: process.env.ADMIN_EMAIL,
      subject: `Contact Form: ${category} - ${title}`,
      html: htmlContent,
      text: emailContent
    });
    console.log(`✅ Contact email sent successfully (Category: ${category})`);
  } catch (error) {
    console.error('❌ Failed to send contact email:', error.message);
    throw error;
  }
};

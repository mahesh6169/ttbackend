import { sendEmail } from '../sendEmail.js';

export const sendRemovalEmail = async ({ type, id, title, itemUrl, message, senderName, senderEmail }) => {
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

    const emailContent = `
Removal Request

Type: ${typeLabel}
Title: ${title}
View Item: ${itemUrl || 'N/A'}
Requested by: ${senderName || 'Anonymous'} (${senderEmail || 'N/A'})

Message:
${message || 'No additional details provided'}
    `;

    const htmlContent = `
        <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
            <p>A removal request has been submitted:</p>
            <p><strong>Type:</strong> ${typeLabel}<br>
            <strong>Title:</strong> ${title}<br>
            <strong>View Item:</strong> <a href="${itemUrl}" style="color: #0d9488;">${itemUrl || 'N/A'}</a><br>
            <strong>Requested by:</strong> ${senderName || 'Anonymous'} (${senderEmail || 'N/A'})</p>
            <p><strong>Message:</strong><br>
            ${message ? message.replace(/\n/g, '<br>') : 'No additional details provided'}</p>
            <p>— ${process.env.NOTIFICATION_PLATFORM_NAME || 'Desify'} Support System</p>
        </div>
    `;

    try {
        await sendEmail({
            from: {
                email: process.env.CONTACT_SENDER_EMAIL || process.env.SENDER_EMAIL,
                name: `${process.env.NOTIFICATION_PLATFORM_NAME || 'Desify'} Support`
            },
            to: process.env.ADMIN_EMAIL,
            subject: `Removal Request: ${typeLabel} - ${title}`,
            html: htmlContent,
            text: emailContent
        });
        console.log(`✅ Removal email sent for ${type} ID: ${id}`);
    } catch (error) {
        console.error('❌ Failed to send removal email:', error.message);
        throw error;
    }
};

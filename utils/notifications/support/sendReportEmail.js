import { sendEmail } from '../sendEmail.js';

export const sendReportEmail = async ({ type, id, title, itemUrl, reason, message, senderName, senderEmail }) => {
    const reasonLabel = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'Not specified';

    const emailContent = `
Abuse Report

Type: ${type}
Title: ${title}
Reason: ${reasonLabel}
View Item: ${itemUrl || 'N/A'}
Reported by: ${senderName || 'Anonymous'} (${senderEmail || 'N/A'})

Message:
${message || 'No additional details provided'}
    `;

    const htmlContent = `
        <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
            <p>An abuse report has been submitted:</p>
            <p><strong>Type:</strong> ${type.toUpperCase()}<br>
            <strong>Title:</strong> ${title}<br>
            <strong>Reason:</strong> ${reasonLabel}<br>
            <strong>View Item:</strong> <a href="${itemUrl}" style="color: #0d9488;">${itemUrl || 'N/A'}</a><br>
            <strong>Reported by:</strong> ${senderName || 'Anonymous'} (${senderEmail || 'N/A'})</p>
            <p><strong>Report Message:</strong><br>
            ${message ? message.replace(/\n/g, '<br>') : 'No additional details provided'}</p>
            <p>— ${process.env.NOTIFICATION_PLATFORM_NAME || 'Desify'} Report System</p>
        </div>
    `;

    try {
        await sendEmail({
            from: {
                email: process.env.CONTACT_SENDER_EMAIL || process.env.SENDER_EMAIL,
                name: `${process.env.NOTIFICATION_PLATFORM_NAME || 'Desify'} Report`
            },
            to: process.env.ADMIN_EMAIL,
            subject: `Report: ${type.toUpperCase()} - ${title}`,
            html: htmlContent,
            text: emailContent
        });
        console.log(`✅ Report email sent for ${type} ID: ${id}`);
    } catch (error) {
        console.error('❌ Failed to send report email:', error.message);
        throw error;
    }
};

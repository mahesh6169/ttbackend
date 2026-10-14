import { config } from 'dotenv';
config();

import nodemailer from 'nodemailer';

// Legacy transporter - kept for compatibility but not used
// All emails now go through MailerSend API in sendEmail.js
const transporter = nodemailer.createTransport({
    host: 'smtp.mailersend.net',
    port: 587,
    secure: false,
    auth: {
        user: 'placeholder',
        pass: 'placeholder',
    },
});

// Disable verification since we're using MailerSend API
console.log('📧 Email service: Using MailerSend API (not SMTP)');

export default transporter;

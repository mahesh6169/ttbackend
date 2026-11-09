// Reply-to for the support emails (contact form, report, removal request) - feature 1014.
// The email arrives at support@ from support@, so without this "Reply" goes back to support@.
// Returns the visitor's typed email when it looks like one address, else undefined (no reply-to,
// the email still sends as before). The address is visitor-typed and unverified - it only fills
// the reply box, it is never the sender.
const EMAIL_PATTERN = /^[^\s@<>,;:"'()[\]\\]+@[^\s@<>,;:"'()[\]\\]+\.[^\s@<>,;:"'()[\]\\]+$/;

export const visitorReplyTo = (senderEmail) => {
  if (typeof senderEmail !== 'string') return undefined;
  const email = senderEmail.trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return undefined;
  return email;
};

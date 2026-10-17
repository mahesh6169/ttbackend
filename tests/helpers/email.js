// In test mode sendEmail captures every email in memory instead of sending it. These helpers read
// that capture.
import { getCapturedEmails, clearCapturedEmails } from '../../utils/notifications/sendEmail.js';

export { getCapturedEmails, clearCapturedEmails };

// Call at the top of a suite: every test starts with no captured emails.
export const clearEmailsBeforeEach = () => beforeEach(() => clearCapturedEmails());

// Poll briefly for a captured email - some endpoints send their notification fire-and-forget.
export const waitForEmail = async (match, tries = 30, ms = 50) => {
  for (let i = 0; i < tries; i++) {
    const hit = getCapturedEmails().find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, ms));
  }
  return getCapturedEmails().find(match);
};

import axios from 'axios';

export const verifyRecaptcha = async (token) => {
  // Test mode: bot defence is exercised in E2E via Google's always-pass keys + the dwell-time
  // wait; backend suites short-circuit here so they never depend on a live call to Google.
  if (process.env.NODE_ENV === 'test') {
    return { success: true, score: 0.9, action: 'test', hostname: 'localhost' };
  }

  if (!token) {
    console.error('🚩 Missing reCAPTCHA token from client');
    throw new Error('reCAPTCHA token is missing');
  }

  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  if (!secretKey) {
    console.error('🚩 Missing RECAPTCHA_SECRET_KEY in environment variables');
    throw new Error('Server misconfiguration: missing secret key');
  }

  try {
    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      null,
      {
        params: {
          secret: secretKey,
          response: token,
        },
      }
    );

    const { success, score, action, hostname, 'error-codes': errorCodes } = response.data;

    // 🔍 Log full response for debugging
    console.log('🔎 reCAPTCHA API Response:', response.data);

    if (!success) {
      console.error('❌ reCAPTCHA verification failed. Possible reasons:', errorCodes || 'Unknown issue');
      throw new Error(`reCAPTCHA failed: ${errorCodes ? errorCodes.join(', ') : 'unknown reason'}`);
    }

    // 🟢 Optional: Log hostname and action if you want to check matching site/domain
    console.log(`✅ reCAPTCHA passed: action=${action}, hostname=${hostname}, score=${score}`);

    return { success, score, action, hostname };
  } catch (error) {
    console.error('❌ Error while verifying reCAPTCHA with Google API:', error.message);
    throw new Error('Failed to verify reCAPTCHA');
  }
};

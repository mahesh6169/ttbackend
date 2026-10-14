
import dateFnsTz from 'date-fns-tz';
const { zonedTimeToUtc, utcToZonedTime } = dateFnsTz;

export function getUtcNow() {
  const localNow = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utcTime = zonedTimeToUtc(localNow, timeZone);
  return utcTime.toISOString();
}


/**
 * Converts a UTC date string to the user's local time.
 * @param {string | Date} utcDate - The UTC time (from database).
 * @returns {Date} The local Date object.
 */
export function convertUtcToLocal(utcDate) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return utcToZonedTime(new Date(utcDate), timeZone);
  }
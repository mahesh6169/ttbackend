import dateFnsTz from 'date-fns-tz';
const { formatInTimeZone } = dateFnsTz;

// A campaign's valid days are judged in the store's LOCAL time — a Perth store's
// Sunday is decided on Perth time, even when it's already Monday on the east coast.
// Derived from the store's address.state (stored as the short code, e.g. "WA").
// Full state names are accepted too, just in case. Falls back to Sydney (the same
// default the events feature uses) when the state is missing/unrecognised.
const STATE_TIMEZONES = {
  WA: 'Australia/Perth',
  NT: 'Australia/Darwin',
  SA: 'Australia/Adelaide',
  QLD: 'Australia/Brisbane',
  NSW: 'Australia/Sydney',
  ACT: 'Australia/Sydney',
  VIC: 'Australia/Melbourne',
  TAS: 'Australia/Hobart',
  'WESTERN AUSTRALIA': 'Australia/Perth',
  'NORTHERN TERRITORY': 'Australia/Darwin',
  'SOUTH AUSTRALIA': 'Australia/Adelaide',
  QUEENSLAND: 'Australia/Brisbane',
  'NEW SOUTH WALES': 'Australia/Sydney',
  'AUSTRALIAN CAPITAL TERRITORY': 'Australia/Sydney',
  VICTORIA: 'Australia/Melbourne',
  TASMANIA: 'Australia/Hobart'
};

const DEFAULT_TIMEZONE = 'Australia/Sydney';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Resolve a store's IANA timezone from its state.
export const getStoreTimeZone = (store) => {
  const state = store?.address?.state?.trim().toUpperCase();
  return (state && STATE_TIMEZONES[state]) || DEFAULT_TIMEZONE;
};

// Lowercase weekday name ("monday"…"sunday") right now in the store's timezone.
export const getStoreWeekday = (store) => {
  const zone = getStoreTimeZone(store);
  // 'i' = 1 (Mon) … 7 (Sun); map to our sunday-indexed array.
  const isoDay = Number(formatInTimeZone(new Date(), zone, 'i'));
  return WEEKDAYS[isoDay % 7];
};

// The day gate. True when the campaign has no weekday restriction, or today (in the
// store's timezone) is one of its valid days. `validHours` is intentionally NOT checked
// here — hours are display-only.
export const isValidToday = (validDays, store) => {
  if (!validDays || validDays.length === 0) return true;
  return validDays.includes(getStoreWeekday(store));
};

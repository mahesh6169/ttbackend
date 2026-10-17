// Small date and id helpers shared by the suites.
export const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
export const daysFromNow = (n) => new Date(Date.now() + n * 24 * 3600 * 1000);

// The ids of a list of docs (or API rows) as strings, for toContain checks.
export const ids = (list) => (list || []).map((e) => String(e._id));

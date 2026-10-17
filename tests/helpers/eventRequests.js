// Request builders for the event endpoints, shared by the backend suites. The create/update
// builders post multipart forms like the wizard does. Each takes an overrides object: any key
// becomes a form field (strings are sent as-is, everything else JSON-encoded), and a key set to
// null or undefined is left out of the form.
import request from 'supertest';
import app from '../../app.js';
import { cookieFor, API_KEY } from './factories.js';

export const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
export const PAST = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

export const ADDRESS = {
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney',
  state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
};

// Buyer details for create-payment-intent / confirm-payment calls.
export const BUYER = {
  firstName: 'Bella',
  lastName: 'Buyer',
  email: 'buyer@test.dev',
  phone: '0412000001',
  agreeToTerms: true,
};

// An API call with the API key and (when a user is given) that user's auth cookie.
// e.g. api('patch', url, organiser).send({ ... })
export const api = (method, url, user) => {
  const req = request(app)[method](url).set('x-api-key', API_KEY);
  return user ? req.set('Cookie', cookieFor(user)) : req;
};

const withFields = (req, fields) => {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    req.field(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return req;
};

const commonFields = () => ({
  dateTime: FUTURE(),
  venue: 'Test Hall',
  description: 'A seeded event for automated tests.',
  category: 'Community',
  address: ADDRESS,
  organizer: { name: 'Test Organiser', contact: '0412345678' },
});

// POST /events/add-free-event (free, RSVP and promo events).
export const addFree = (organiser, overrides = {}) =>
  withFields(api('post', '/api/events/add-free-event', organiser), {
    title: 'Test Free Event',
    ...commonFields(),
    isPaid: 'false',
    eventIntent: 'host',
    capacity: 100,
    maxAttendeesPerRegistration: 5,
    ...overrides,
  });

// PUT /events/update-free/:id.
export const updateFree = (organiser, eventId, overrides = {}) =>
  withFields(api('put', `/api/events/update-free/${eventId}`, organiser), {
    title: 'Test Free Event',
    ...commonFields(),
    isPaid: 'false',
    eventIntent: 'host',
    capacity: 100,
    maxAttendeesPerRegistration: 10,
    ...overrides,
  });

// POST /events/add-paid-event. Pass ticketTypes: null to leave the ticket types out entirely.
export const addPaid = (organiser, overrides = {}) =>
  withFields(api('post', '/api/events/add-paid-event', organiser), {
    title: 'Test Paid Event',
    ...commonFields(),
    ticketTypes: [{ name: 'Standard', price: 10 }],
    capacity: 100,
    maxAttendeesPerRegistration: 10,
    ...overrides,
  });

// PUT /events/update-paid/:id. Sends an empty seating layout unless one is given.
export const updatePaid = (organiser, eventId, overrides = {}) =>
  withFields(api('put', `/api/events/update-paid/${eventId}`, organiser), {
    title: 'Test Paid Event',
    ...commonFields(),
    ticketTypes: [{ name: 'Standard', price: 10 }],
    capacity: 100,
    maxAttendeesPerRegistration: 10,
    seatingLayout: [],
    ...overrides,
  });

// RSVP a free event. `body` overrides the default single attendee or adds formResponses.
export const registerFree = (event, user, body = {}) =>
  api('post', `/api/events/${event._id}/free/register`, user)
    .send({ mobile: '0412345678', attendees: [{ name: 'Attendee' }], ...body });

// Create a ticket reservation: tickets is [{ ticketTypeId, quantity }].
export const reserve = (user, eventId, tickets) =>
  api('post', `/api/events/${eventId}/reservation`, user).send({ tickets });

// Price a purchase: tickets is { [ticketTypeId]: quantity }.
export const createPaymentIntent = (user, eventId, tickets, extra = {}) =>
  api('post', `/api/events/${eventId}/paid/create-payment-intent`, user)
    .send({ tickets, buyerInfo: BUYER, ...extra });

// The public (or, with a user, owner) event detail payload.
export const viewEvent = (eventId, user) => api('get', `/api/events/views/${eventId}`, user);

// The public "events by one organiser" page.
export const byOrg = (slug) => api('get', `/api/events/by/${slug}`);

// The public Past strip, as a list of event ids.
export const pastEventIds = async () =>
  ((await api('get', '/api/events/past')).body.events || []).map((e) => String(e._id));

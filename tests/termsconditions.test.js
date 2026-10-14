// events-terms-conditions.md - an organiser Terms & Conditions field on the event's refundPolicy that
// follows the refund policy through the buyer journey. AC2 (persist + snapshot), AC4 (confirmation email
// block), AC5 (ticket/invoice snapshot carries it), AC6 (empty renders nothing).
import request from 'supertest';
import app from '../app.js';
import Event from '../models/eventModel.js';
import EventInvoice from '../models/eventInvoice.js';
import PaidTicket from '../models/paidTicket.js';
import { createEventSnapshot } from '../utils/events/ticketHelpers.js';
import { buildRefundAndTermsBlockHtml } from '../utils/notifications/events/sendPaidTicketNotifications.js';
import { createOrganiser, createPaidEvent, cookieFor, API_KEY } from './helpers/factories.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney', state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

const updatePaid = (organiser, eventId, { refundPolicy }) =>
  request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Terms Test')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for T&C tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify([{ name: 'Standard', price: 10 }]))
    .field('capacity', '50')
    .field('maxAttendeesPerRegistration', '10')
    .field('refundPolicy', JSON.stringify(refundPolicy));

const TC = 'Entry subject to venue conditions; no outside food or drink.';

test('AC2 termsAndConditions persists on the event refundPolicy and is carried into the event snapshot', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 50 });

  const res = await updatePaid(org, event._id, {
    refundPolicy: { processingFeePolicy: 'non-refundable', policyText: 'No change of mind.', termsAndConditions: TC },
  });
  expect(res.status).toBe(200);

  const after = await Event.findById(event._id);
  expect(after.refundPolicy.termsAndConditions).toBe(TC);

  // The snapshot embedded in a ticket/invoice at purchase carries it too.
  const snapshot = createEventSnapshot(after);
  expect(snapshot.refundPolicy.termsAndConditions).toBe(TC);
});

test('AC2 the T&C is capped at 2000 characters on save', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 50 });
  const long = 'x'.repeat(2500);

  const res = await updatePaid(org, event._id, {
    refundPolicy: { processingFeePolicy: 'non-refundable', termsAndConditions: long },
  });
  expect(res.status).toBe(200);
  const after = await Event.findById(event._id);
  expect(after.refundPolicy.termsAndConditions.length).toBe(2000);
});

test('AC4 the paid confirmation email block includes the refund policy AND the T&C', async () => {
  const html = buildRefundAndTermsBlockHtml({
    processingFeePolicy: 'non-refundable', policyText: 'No change of mind.', termsAndConditions: TC,
  });
  expect(html).toMatch(/Refund Policy/i);
  expect(html).toMatch(/non-refundable/i);
  expect(html).toContain('No change of mind.');
  expect(html).toMatch(/Terms &amp; Conditions/i);
  expect(html).toContain(TC);
});

test('AC5 the ticket + invoice snapshot schema carries termsAndConditions (not stripped)', async () => {
  // Mongoose drops paths not in the schema; constructing the docs proves the field is retained.
  const invoice = new EventInvoice({ refundPolicy: { termsAndConditions: TC } });
  expect(invoice.refundPolicy.termsAndConditions).toBe(TC);

  const ticket = new PaidTicket({
    eventSnapshot: { refundPolicy: { termsAndConditions: TC } },
    refundPolicyAcceptance: { termsAndConditions: TC },
  });
  expect(ticket.eventSnapshot.refundPolicy.termsAndConditions).toBe(TC);
  expect(ticket.refundPolicyAcceptance.termsAndConditions).toBe(TC);
});

test('AC6 an empty T&C renders nothing extra - the email block is empty and the snapshot value is blank', async () => {
  expect(buildRefundAndTermsBlockHtml({})).toBe('');
  expect(buildRefundAndTermsBlockHtml({ processingFeePolicy: '', policyText: '', termsAndConditions: '' })).toBe('');

  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 50 });
  const snapshot = createEventSnapshot(event);
  expect(snapshot.refundPolicy.termsAndConditions).toBe('');
});

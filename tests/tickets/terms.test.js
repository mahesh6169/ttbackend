// Organiser Terms & Conditions - see featureplans/events-terms-conditions.md. The T&C lives on the
// event's refundPolicy and follows the refund policy through the buyer journey: saved on the event,
// copied into the ticket/invoice snapshot, and shown in the confirmation email.
import Event from '../../models/eventModel.js';
import EventInvoice from '../../models/eventInvoice.js';
import PaidTicket from '../../models/paidTicket.js';
import { createEventSnapshot } from '../../utils/events/ticketHelpers.js';
import { buildRefundAndTermsBlockHtml } from '../../utils/notifications/events/sendPaidTicketNotifications.js';
import { createOrganiser, createPaidEvent } from '../helpers/factories.js';
import { updatePaid } from '../helpers/eventRequests.js';

const TC = 'Entry subject to venue conditions; no outside food or drink.';

test('the T&C is saved on the event and carried into the ticket and invoice snapshots', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 50 });

  const res = await updatePaid(org, event._id, {
    capacity: 50,
    refundPolicy: { processingFeePolicy: 'non-refundable', policyText: 'No change of mind.', termsAndConditions: TC },
  });
  expect(res.status).toBe(200);

  const after = await Event.findById(event._id);
  expect(after.refundPolicy.termsAndConditions).toBe(TC);

  // The snapshot embedded in a ticket/invoice at purchase carries it too.
  const snapshot = createEventSnapshot(after);
  expect(snapshot.refundPolicy.termsAndConditions).toBe(TC);

  // ...and the ticket + invoice schemas keep it (Mongoose drops paths not in the schema).
  const invoice = new EventInvoice({ refundPolicy: { termsAndConditions: TC } });
  expect(invoice.refundPolicy.termsAndConditions).toBe(TC);
  const ticket = new PaidTicket({
    eventSnapshot: { refundPolicy: { termsAndConditions: TC } },
    refundPolicyAcceptance: { termsAndConditions: TC },
  });
  expect(ticket.eventSnapshot.refundPolicy.termsAndConditions).toBe(TC);
  expect(ticket.refundPolicyAcceptance.termsAndConditions).toBe(TC);
});

test('the T&C is cut to 2000 characters on save', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 50 });
  const long = 'x'.repeat(2500);

  const res = await updatePaid(org, event._id, {
    capacity: 50,
    refundPolicy: { processingFeePolicy: 'non-refundable', termsAndConditions: long },
  });
  expect(res.status).toBe(200);
  const after = await Event.findById(event._id);
  expect(after.refundPolicy.termsAndConditions.length).toBe(2000);
});

test('the paid confirmation email shows the refund policy and the T&C', async () => {
  const html = buildRefundAndTermsBlockHtml({
    processingFeePolicy: 'non-refundable', policyText: 'No change of mind.', termsAndConditions: TC,
  });
  expect(html).toMatch(/Refund Policy/i);
  expect(html).toMatch(/non-refundable/i);
  expect(html).toContain('No change of mind.');
  expect(html).toMatch(/Terms &amp; Conditions/i);
  expect(html).toContain(TC);
});

test('with no T&C the email shows nothing extra and the snapshot value is blank', async () => {
  expect(buildRefundAndTermsBlockHtml({})).toBe('');
  expect(buildRefundAndTermsBlockHtml({ processingFeePolicy: '', policyText: '', termsAndConditions: '' })).toBe('');

  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 50 });
  const snapshot = createEventSnapshot(event);
  expect(snapshot.refundPolicy.termsAndConditions).toBe('');
});

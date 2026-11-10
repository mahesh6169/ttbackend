// Paid ticket purchase end to end (feature 1015): clicking Pay only HOLDS the money; the tickets
// are made by whichever arrives first - the buyer's browser ("I've paid") or Stripe's webhook -
// and only then is the money taken. If the tickets cannot be made the hold is released, so a buyer
// is never charged without tickets. These tests use real Stripe test-mode payments on the test
// connected account (TEST_STRIPE_ACCOUNT_ID) and Stripe's test Visa card.
import { jest } from '@jest/globals';
import Event from '../../models/eventModel.js';
import EventInvoice from '../../models/eventInvoice.js';
import PaidTicket from '../../models/paidTicket.js';
import PendingOrder from '../../models/pendingOrder.js';
import { createOrganiser, createUser, createPaidEvent, createPaidTicket } from '../helpers/factories.js';
import {
  createPaymentIntent, createHoldPaymentIntent, authoriseWithTestCard, stripePayment, confirmPurchase, sendStripeWebhook,
} from '../helpers/eventRequests.js';
import { clearEmailsBeforeEach, getCapturedEmails } from '../helpers/email.js';

jest.setTimeout(60_000);
clearEmailsBeforeEach();

const typeIdOf = (event, i = 0) => event.ticketTypes[i]._id.toString();
const emailsTo = (address) => getCapturedEmails().filter((m) => m.to === address);

// Buyer clicks Pay (hold) and the card is approved; returns the payment id.
const payAndHold = async (buyer, event, qty = 1, extra = {}) => {
  const pay = await createHoldPaymentIntent(buyer, event._id, { [typeIdOf(event)]: qty }, extra);
  expect(pay.status).toBe(200);
  const pi = await authoriseWithTestCard(pay.body.paymentIntentId);
  expect(pi.status).toBe('requires_capture'); // held, not taken
  return pay.body.paymentIntentId;
};

const setup = async (eventOverrides = {}) => {
  const organiser = await createOrganiser({ email: `org_${Date.now()}@test.dev` });
  const buyer = await createUser();
  const event = await createPaidEvent(organiser, { capacity: 10, ...eventOverrides });
  return { organiser, buyer, event };
};

describe('normal purchase', () => {
  test('the browser makes the tickets, the held money is then taken, and each email goes out once', async () => {
    const { organiser, buyer, event } = await setup();
    const piId = await payAndHold(buyer, event, 2);

    const res = await confirmPurchase(buyer, event._id, piId);
    expect(res.status).toBe(200);
    expect(res.body.ticketCount).toBe(2);
    expect((await stripePayment(piId)).status).toBe('succeeded');
    expect(await PaidTicket.countDocuments({ paymentIntentId: piId })).toBe(2);
    expect((await PendingOrder.findOne({ paymentIntentId: piId })).status).toBe('done');

    // A refresh / retry returns the same order and sends nothing more.
    const again = await confirmPurchase(buyer, event._id, piId);
    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);
    expect(await EventInvoice.countDocuments({ 'payment.paymentIntentId': piId })).toBe(1);
    expect(emailsTo('buyer@test.dev')).toHaveLength(1);
    expect(emailsTo(organiser.email)).toHaveLength(1);
  });

  test('the older checkout (charged at Pay, no hold) still makes the tickets', async () => {
    const { buyer, event } = await setup();
    const pay = await createPaymentIntent(buyer, event._id, { [typeIdOf(event)]: 1 });
    expect(pay.status).toBe(200);
    expect((await authoriseWithTestCard(pay.body.paymentIntentId)).status).toBe('succeeded');

    const res = await confirmPurchase(buyer, event._id, pay.body.paymentIntentId, { tickets: { [typeIdOf(event)]: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.ticketCount).toBe(1);
  });
});

describe('the buyer\'s page closes after paying', () => {
  test('Stripe\'s message makes the tickets with the registration answers, takes the money and sends the emails', async () => {
    const { organiser, buyer, event } = await setup({
      registrationFields: [{ qid: 'q-1', fieldName: 'Meal choice', fieldType: 'text', isRequired: false }],
    });
    const piId = await payAndHold(buyer, event, 1, { formResponses: { 'Meal choice': 'Vegetarian' } });

    const hook = await sendStripeWebhook('payment_intent.amount_capturable_updated', piId);
    expect(hook.status).toBe(200);

    const tickets = await PaidTicket.find({ paymentIntentId: piId });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].formResponses[0]).toMatchObject({ fieldName: 'Meal choice', qid: 'q-1', response: 'Vegetarian' });
    expect((await stripePayment(piId)).status).toBe('succeeded');
    expect(emailsTo('buyer@test.dev')).toHaveLength(1);
    expect(emailsTo(organiser.email)).toHaveLength(1);

    // Stripe's follow-up "succeeded" message and a late browser call change nothing.
    expect((await sendStripeWebhook('payment_intent.succeeded', piId)).status).toBe(200);
    const late = await confirmPurchase(buyer, event._id, piId);
    expect(late.status).toBe(200);
    expect(await PaidTicket.countDocuments({ paymentIntentId: piId })).toBe(1);
    expect(emailsTo('buyer@test.dev')).toHaveLength(1);
  });

  test('browser and Stripe arriving at the same moment make exactly one order', async () => {
    const { buyer, event } = await setup();
    const piId = await payAndHold(buyer, event, 2);

    const [browser, hook] = await Promise.all([
      confirmPurchase(buyer, event._id, piId),
      sendStripeWebhook('payment_intent.amount_capturable_updated', piId),
    ]);
    expect(browser.status).toBe(200);
    expect(hook.status).toBe(200);
    expect(await EventInvoice.countDocuments({ 'payment.paymentIntentId': piId })).toBe(1);
    expect(await PaidTicket.countDocuments({ paymentIntentId: piId })).toBe(2);
    expect(emailsTo('buyer@test.dev')).toHaveLength(1);
  });

  test('a discount code is counted once even when both paths finish the order', async () => {
    const { buyer, event } = await setup({
      ticketTypes: [{ name: 'Standard', price: 20 }],
      discountCodes: [{ code: 'TEN', kind: 'percent', value: 10, appliesToTicketTypes: ['Standard'], active: true, remainingUses: 5 }],
    });
    const piId = await payAndHold(buyer, event, 1, { discountCode: 'TEN' });

    await confirmPurchase(buyer, event._id, piId);
    await sendStripeWebhook('payment_intent.amount_capturable_updated', piId);

    const code = (await Event.findById(event._id)).discountCodes[0];
    expect(code.usedCount).toBe(1);
    expect(code.remainingUses).toBe(4);
  });
});

describe('Stripe messages for payments this server does not know', () => {
  test('are ignored - the held money is never released by a server that did not take the order', async () => {
    const { buyer, event } = await setup();
    const piId = await payAndHold(buyer, event);
    await PendingOrder.deleteOne({ paymentIntentId: piId }); // as if the order lives on another server

    const hook = await sendStripeWebhook('payment_intent.amount_capturable_updated', piId);
    expect(hook.status).toBe(200);
    expect((await stripePayment(piId)).status).toBe('requires_capture');
    expect(await PaidTicket.countDocuments({ paymentIntentId: piId })).toBe(0);
  });
});

describe('the tickets cannot be made while paying - the buyer is not charged', () => {
  test('sold out while paying: the hold is released, no tickets, and the buyer is told they were not charged', async () => {
    const { buyer, event } = await setup({ capacity: 1 });
    const piId = await payAndHold(buyer, event, 1);
    await createPaidTicket(event, await createUser()); // someone else takes the last place

    const res = await confirmPurchase(buyer, event._id, piId);
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('NOT_CHARGED');
    expect(res.body.message).toMatch(/sold out.*not been charged/i);
    expect((await stripePayment(piId)).status).toBe('canceled');
    expect(await PaidTicket.countDocuments({ paymentIntentId: piId })).toBe(0);
    const mail = emailsTo('buyer@test.dev');
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toMatch(/Not charged/);

    // Stripe's message afterwards does nothing more.
    await sendStripeWebhook('payment_intent.amount_capturable_updated', piId);
    expect(emailsTo('buyer@test.dev')).toHaveLength(1);
  });

  test('two buyers paying for the last ticket at the same moment: exactly one gets it, the other is not charged', async () => {
    const { event } = await setup({ capacity: 1 });
    const a = await createUser();
    const b = await createUser();
    const piA = await payAndHold(a, event);
    const piB = await payAndHold(b, event);

    const [ra, rb] = await Promise.all([confirmPurchase(a, event._id, piA), confirmPurchase(b, event._id, piB)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(await PaidTicket.countDocuments({ event: String(event._id) })).toBe(1);
    const statuses = [(await stripePayment(piA)).status, (await stripePayment(piB)).status].sort();
    expect(statuses).toEqual(['canceled', 'succeeded']);
  });

  test('a ticket type switched off by the organiser while paying: not charged', async () => {
    const { buyer, event } = await setup();
    const piId = await payAndHold(buyer, event);
    await Event.updateOne({ _id: event._id }, { $set: { 'ticketTypes.0.active': false } });

    const res = await confirmPurchase(buyer, event._id, piId);
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('NOT_CHARGED');
    expect((await stripePayment(piId)).status).toBe('canceled');
  });
});

describe('things that change while paying are judged at Pay', () => {
  test('an early-bird that ends while paying is still honoured', async () => {
    const { buyer, event } = await setup();
    const piId = await payAndHold(buyer, event);
    // It ended just after Pay was clicked (and before the order is finished).
    const startedAt = (await PendingOrder.findOne({ paymentIntentId: piId })).createdAt;
    await Event.updateOne({ _id: event._id }, { $set: { 'ticketTypes.0.expiryDate': new Date(startedAt.getTime() + 50) } });

    const res = await confirmPurchase(buyer, event._id, piId);
    expect(res.status).toBe(200);
    expect(res.body.ticketCount).toBe(1);
  });

  test('...but not when the payment finishes more than 15 minutes after Pay', async () => {
    const { buyer, event } = await setup();
    const piId = await payAndHold(buyer, event);
    await Event.updateOne({ _id: event._id }, { $set: { 'ticketTypes.0.expiryDate': new Date(Date.now() - 1000) } });
    await PendingOrder.collection.updateOne({ paymentIntentId: piId }, { $set: { createdAt: new Date(Date.now() - 20 * 60_000) } });

    const res = await confirmPurchase(buyer, event._id, piId);
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('NOT_CHARGED');
  });

  test('a price changed by the organiser while paying: the ticket and invoice keep the price agreed at Pay', async () => {
    const { buyer, event } = await setup({ ticketTypes: [{ name: 'Standard', price: 20 }] });
    const piId = await payAndHold(buyer, event);
    await Event.updateOne({ _id: event._id }, { $set: { 'ticketTypes.0.price': 35 } });

    const res = await confirmPurchase(buyer, event._id, piId);
    expect(res.status).toBe(200);
    const ticket = await PaidTicket.findOne({ paymentIntentId: piId });
    expect(ticket.priceDetails.totalPrice).toBe(20);
    const invoice = await EventInvoice.findOne({ 'payment.paymentIntentId': piId });
    expect(invoice.amounts.total).toBe(20);
    expect((await stripePayment(piId)).amount_received).toBe(2000);
  });
});

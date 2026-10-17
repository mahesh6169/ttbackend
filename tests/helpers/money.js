// Money helpers: a paid ticket at a given price, and the real refund engine driven directly.
// The refund HTTP endpoint needs a real Stripe refund against a live charge, so suites call
// applyRefundSuccessData (the piece that frees capacity and cancels tickets) with per-ticket amounts.
import { applyRefundSuccessData } from '../../utils/events/refundHelpers.js';
import { createPaidTicket } from './factories.js';

// A confirmed paid ticket for the event's first ticket type at `price` dollars.
export const paidTicketAt = (event, buyer, price, overrides = {}) =>
  createPaidTicket(event, buyer, {
    price,
    ticketType: { name: event.ticketTypes?.[0]?.name || 'Standard', price },
    ...overrides,
  });

// Refund `amount` dollars of one ticket through the real refund engine (full = its whole price).
export const applyRefund = async (ticket, amount, organiser) => {
  const refundRequest = {
    refundAmounts: new Map([[ticket.ticketNumber, amount]]),
    stripeRefundId: 're_test',
    refundRequestId: 'REF-TEST-0001',
    reason: 'test',
    totalAmount: amount,
  };
  const invoice = {
    amounts: { total: 1000, totalRefunded: 0, netAmount: 1000 },
    refunds: [],
    status: 'paid',
    save: async () => {},
  };
  // No seats here (general admission) -> pass null so the engine's seat step is skipped.
  await applyRefundSuccessData(null, refundRequest, [ticket], invoice, organiser._id);
};

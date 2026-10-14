// Read-only DB introspection for E2E assertions, run as a short-lived script (no served route).
// Usage: node tests/introspect.js <kind> <eventId>
//   count kinds:  freeTickets | paidTickets | invoices   -> prints COUNT=<n>
//   ticketBasePrices <eventId>                            -> prints BASEPRICES=[...] PAIDPRICES=[...]
//   invoiceTotal <eventId>                                -> prints TOTAL=<n>
//   sold <eventId>                                        -> prints SOLD=<n> (capacity-consuming tickets)
//   packTags <eventId>                                    -> prints PACKIDS=[...] (each ticket's pack.id)
import './setup.env.js';
import mongoose from 'mongoose';
import Event from '../models/eventModel.js';
import FreeTicket from '../models/freeTicket.js';
import PaidTicket from '../models/paidTicket.js';
import EventInvoice from '../models/eventInvoice.js';
import { calculateCurrentTicketsSold } from '../utils/events/ticketHelpers.js';

const [, , kind, eventId] = process.argv;
const countModels = { freeTickets: FreeTicket, paidTickets: PaidTicket, invoices: EventInvoice };

await mongoose.connect(process.env.MONGO_URI);

if (countModels[kind]) {
  const count = await countModels[kind].countDocuments(eventId ? { event: eventId } : {});
  console.log('COUNT=' + count);
} else if (kind === 'ticketBasePrices') {
  const tickets = await PaidTicket.find({ event: eventId }).select('priceDetails');
  console.log('BASEPRICES=' + JSON.stringify(tickets.map((t) => t.priceDetails?.basePrice)));
  console.log('PAIDPRICES=' + JSON.stringify(tickets.map((t) => t.priceDetails?.totalPrice)));
} else if (kind === 'invoiceTotal') {
  const inv = await EventInvoice.findOne({ event: eventId });
  console.log('TOTAL=' + (inv?.amounts?.total ?? -1));
} else if (kind === 'sold') {
  console.log('SOLD=' + (await calculateCurrentTicketsSold(eventId)));
} else if (kind === 'packTags') {
  const tickets = await PaidTicket.find({ event: eventId }).select('pack');
  console.log('PACKIDS=' + JSON.stringify(tickets.map((t) => t.pack?.id || null)));
} else if (kind === 'editFlags') {
  // Edit-locking signals set at first sale (events-edit-locking.md AC1): event.hasActivity and any
  // ticket type's hasSold.
  const e = await Event.findById(eventId).select('hasActivity ticketTypes');
  console.log('HASACTIVITY=' + (e?.hasActivity ? 1 : 0));
  console.log('HASSOLD=' + ((e?.ticketTypes || []).some((t) => t.hasSold) ? 1 : 0));
} else {
  console.log('COUNT=-1');
}

await mongoose.disconnect();
process.exit(0);

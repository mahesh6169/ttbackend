// Seat layout locking - see featureplans/fix-events-seatmap-salelock.md, events-edit-locking.md and
// events-layout-tools.md. Saving a layout marks the event as seated. Before any sale (and with no
// live hold) the layout can be restructured freely; once a seat sells the hall is a fixed room: every
// structural change (rows, seats, aisles, labels, orientation) is refused and only reserving or
// releasing free seats stays live. Seated capacity cannot drop below the booked seats, and a
// general-admission event that has sold cannot become seated.
import Event from '../../models/eventModel.js';
import { createOrganiser, createUser, createPaidEvent, createPaidTicket } from '../helpers/factories.js';
import { updatePaid } from '../helpers/eventRequests.js';
import { grid, rowShape, seatById } from '../helpers/seating.js';

describe('before any sale', () => {
  test('saving a seat layout marks the event as seated', async () => {
    const organiser = await createOrganiser();
    const event = await createPaidEvent(organiser, { capacity: 100 }); // no layout yet

    expect(event.hasSeating).toBe(false);

    const res = await updatePaid(organiser, event._id, { seatingLayout: grid(['A', 'B'], 5) });
    expect(res.status).toBe(200);

    const after = await Event.findById(event._id);
    expect(after.hasSeating).toBe(true);
  });

  test('an unsold seated event can be restructured and the new layout is stored', async () => {
    const org = await createOrganiser();
    const event = await createPaidEvent(org, { capacity: 100, seatingLayout: grid(['A', 'B'], 5) });

    const res = await updatePaid(org, event._id, { seatingLayout: grid(['A', 'B', 'C'], 8) });

    expect(res.status).toBe(200);
    const after = await Event.findById(event._id);
    expect(rowShape(after)).toEqual([8, 8, 8]); // 3 rows of 8 - the new layout
  });

  test('a live seat hold blocks a restructure with a try-again message until the hold clears', async () => {
    const org = await createOrganiser();
    const event = await createPaidEvent(org, { capacity: 100, seatingLayout: grid(['A', 'B'], 5) });

    // Place a live attendee hold on seat A-1 (unexpired reservedUntil).
    const held = await Event.findById(event._id);
    held.seatingLayout[0].seats[0].status = 'selected';
    held.seatingLayout[0].seats[0].reservedUntil = new Date(Date.now() + 5 * 60 * 1000);
    await held.save();

    const refused = await updatePaid(org, event._id, { seatingLayout: grid(['A', 'B', 'C'], 8) });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/again/i);
    expect(rowShape(await Event.findById(event._id))).toEqual([5, 5]); // untouched while held

    // Release the hold; the same restructure now succeeds.
    const cleared = await Event.findById(event._id);
    cleared.seatingLayout[0].seats[0].status = 'available';
    cleared.seatingLayout[0].seats[0].reservedUntil = null;
    await cleared.save();

    const ok = await updatePaid(org, event._id, { seatingLayout: grid(['A', 'B', 'C'], 8) });
    expect(ok.status).toBe(200);
    expect(rowShape(await Event.findById(event._id))).toEqual([8, 8, 8]);
  });
});

describe('after a seat sells', () => {
  test('the layout is frozen: every structural change is refused, while reserving a free seat still works', async () => {
    const org = await createOrganiser();
    const seed = () => createPaidEvent(org, { capacity: 20, seatingLayout: grid(['A', 'B'], 5, 'A-3') }); // A-3 booked
    const save = (event, seatingLayout, capacity = 20) => updatePaid(org, event._id, { seatingLayout, capacity });

    // A restructure is refused with a clear message, and the stored layout and the sale survive.
    const eRestructure = await seed();
    const restructure = await save(eRestructure, grid(['A', 'B', 'C'], 8), 100);
    expect(restructure.status).toBe(409);
    expect(restructure.body.message).toMatch(/sold/i);
    const kept = await Event.findById(eRestructure._id);
    expect(rowShape(kept)).toEqual([5, 5]);
    expect(seatById(kept, 'A-3').status).toBe('booked');

    // Clearing the layout, resizing a row, adding a row or appending a seat are all refused.
    expect((await save(await seed(), [])).status).toBe(409);
    expect((await save(await seed(), grid(['A', 'B'], 2))).status).toBe(409);
    expect((await save(await seed(), grid(['A', 'B', 'C'], 5, 'A-3'), 25)).status).toBe(409);
    const appendLayout = grid(['A', 'B'], 5, 'A-3');
    appendLayout[0].seats.push({ seatId: 'A-6', seatNumber: '6', row: 'A', status: 'available' });
    expect((await save(await seed(), appendLayout, 21)).status).toBe(409);

    // Adding an aisle (the wizard resends seats without ids, plus the new walkway) is refused too,
    // and seat status and count are untouched.
    const eAisle = await seed();
    const aisleLayout = grid(['A', 'B'], 5, 'A-3').map((row) => ({
      rowLabel: row.rowLabel,
      walkwayPositions: row.rowLabel === 'A' ? [2] : [],
      seats: row.seats.map((s) => ({ seatNumber: s.seatNumber, status: s.status })),
    }));
    const aisle = await save(eAisle, aisleLayout);
    expect(aisle.status).toBe(409);
    expect(aisle.body.message).toMatch(/sold/i);
    const afterAisle = await Event.findById(eAisle._id);
    const rowA = afterAisle.seatingLayout.find((r) => r.rowLabel === 'A');
    expect([...rowA.walkwayPositions]).toEqual([]); // aisle NOT added
    expect(rowShape(afterAisle)).toEqual([5, 5]);
    expect(afterAisle.seatingLayout.flatMap((r) => r.seats).filter((s) => s.status === 'booked')).toHaveLength(1);
    expect(seatById(afterAisle, 'A-3').status).toBe('booked');

    // Disturbing the SOLD seat (A-3 -> reserved) is refused.
    const toReserved = grid(['A', 'B'], 5);
    toReserved[0].seats[2].status = 'reserved'; // A-3
    expect((await save(await seed(), toReserved)).status).toBe(409);

    // Reserving an UNBOOKED free seat (A-1) is accepted - a seat-status change, not a structure change.
    const reserveUnbooked = grid(['A', 'B'], 5, 'A-3');
    reserveUnbooked[0].seats[0].status = 'reserved'; // A-1
    expect((await save(await seed(), reserveUnbooked)).status).toBe(200);
  });

  test('a sold event can still change other details when the layout is resent unchanged', async () => {
    const org = await createOrganiser();
    const event = await createPaidEvent(org, { capacity: 100, seatingLayout: grid(['A', 'B'], 5, 'A-3') });

    // Re-submit the identical structure (the builder round-trips it) with a new title.
    const res = await updatePaid(org, event._id, { title: 'Renamed Fest', seatingLayout: grid(['A', 'B'], 5, 'A-3') });

    expect(res.status).toBe(200);
    const after = await Event.findById(event._id);
    expect(after.title).toBe('Renamed Fest');
    expect(rowShape(after)).toEqual([5, 5]);
    expect(seatById(after, 'A-3').status).toBe('booked');
  });

  test('seated capacity cannot drop below the number of booked seats', async () => {
    const org = await createOrganiser();
    const manyBooked = grid(['A', 'B'], 5);
    for (let i = 0; i < 5; i++) manyBooked[0].seats[i].status = 'booked'; // A-1..A-5 booked
    const event = await createPaidEvent(org, { capacity: 20, seatingLayout: manyBooked });

    // Keep the layout (booked seats preserved) but drop capacity below the 5 booked -> refused.
    const res = await updatePaid(org, event._id, { seatingLayout: manyBooked, capacity: 3 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/capacity/i);
  });

  test('a general-admission event that has sold a ticket cannot become seated', async () => {
    const org = await createOrganiser();
    const buyer = await createUser({ email: 'ga-buyer@test.dev' });
    const event = await createPaidEvent(org, { capacity: 100, ticketTypes: [{ name: 'GA', price: 10 }] }); // non-seated
    await createPaidTicket(event, buyer, { ticketType: { name: 'GA', price: 10 } }); // a general-admission sale

    // The buyers have no seat, so introducing a layout is refused.
    const res = await updatePaid(org, event._id, {
      ticketTypes: [{ name: 'GA', price: 10 }],
      seatingLayout: grid(['A', 'B'], 5),
      capacity: 100,
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/sold/i);
  });
});

describe('layout tools', () => {
  test('a horizontal flip is refused once a seat is booked and saved when none are', async () => {
    const org = await createOrganiser();

    // Booked event: turning the flip on is refused, and the stored flag stays false.
    const booked = await createPaidEvent(org, { capacity: 10, seatingLayout: grid(['A'], 10, 'A-3') });
    const rejected = await updatePaid(org, booked._id, { seatingLayout: grid(['A'], 10, 'A-3'), capacity: 10, seatingLayoutFlipH: true });
    expect(rejected.status).toBe(409);
    expect(rejected.body.message).toMatch(/orientation is locked/i);
    expect((await Event.findById(booked._id)).seatingLayoutFlipH).toBe(false);

    // Clean event: the flip is accepted and persists as a boolean flag (no seat data changed).
    const clean = await createPaidEvent(org, { capacity: 10, seatingLayout: grid(['A'], 10) });
    const ok = await updatePaid(org, clean._id, { seatingLayout: grid(['A'], 10), capacity: 10, seatingLayoutFlipH: true });
    expect(ok.status).toBe(200);
    expect((await Event.findById(clean._id)).seatingLayoutFlipH).toBe(true);
  });

  test('relabelling rows (as skipping a row letter does) is refused once a seat is booked and saved when none are', async () => {
    const org = await createOrganiser();

    // Booked event: relabeling rows (B becomes C) changes seat ids - a structural change - so it is
    // refused and the stored labels are untouched.
    const booked = await createPaidEvent(org, { capacity: 20, seatingLayout: grid(['A', 'B'], 10, 'A-3') });
    const rejected = await updatePaid(org, booked._id, { seatingLayout: grid(['A', 'C'], 10, 'A-3'), capacity: 20 });
    expect(rejected.status).toBe(409);
    const after = await Event.findById(booked._id);
    expect(after.seatingLayout.map((r) => r.rowLabel)).toEqual(['A', 'B']);

    // Clean event: the same relabel is accepted.
    const clean = await createPaidEvent(org, { capacity: 20, seatingLayout: grid(['A', 'B'], 10) });
    const ok = await updatePaid(org, clean._id, { seatingLayout: grid(['A', 'C'], 10), capacity: 20 });
    expect(ok.status).toBe(200);
    expect((await Event.findById(clean._id)).seatingLayout.map((r) => r.rowLabel)).toEqual(['A', 'C']);
  });
});

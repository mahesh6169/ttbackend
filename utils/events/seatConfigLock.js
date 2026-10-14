// Seat-configuration lock helpers - see featureplans/fix-events-seatmap-salelock.md.
// The seating layout is freely editable until the event's first sale; after a sale it is locked, and
// a structural rebuild is also refused while a live attendee hold exists. These pure helpers let the
// paid-event update endpoint tell a real restructure apart from a harmless (title/desc) update.

// A seat is SOLD once it is booked; that is the in-layout signal of a sale.
export const hasBookedSeat = (layout = []) =>
  (layout || []).some((row) => (row.seats || []).some((s) => s.status === 'booked'));

// A live attendee hold is an unexpired buyer reservation on a seat (reservedUntil in the future).
// Organiser permanent holds carry reservedUntil = null and are NOT live holds.
export const hasLiveHold = (layout = [], now = new Date()) =>
  (layout || []).some((row) =>
    (row.seats || []).some((s) => s.reservedUntil && new Date(s.reservedUntil) > now));

// A stable fingerprint of the layout's STRUCTURE only - rows, aisle positions, and seat identities.
// Deliberately ignores seat status / holds (booking changes those without restructuring the hall), so
// re-submitting the same hall (e.g. a title-only edit) compares equal.
export const structuralFingerprint = (layout = []) =>
  JSON.stringify(
    (layout || []).map((row) => ({
      rowLabel: String(row.rowLabel ?? ''),
      walkwayPositions: [...(row.walkwayPositions || [])].map(Number).sort((a, b) => a - b),
      seats: (row.seats || []).map((s) => ({
        seatId: String(s.seatId ?? ''),
        seatNumber: String(s.seatNumber ?? ''),
        row: String(s.row ?? ''),
      })),
    }))
  );

// True when the submitted layout restructures the stored one (rows/counts/aisles/identities changed).
export const isStructuralLayoutChange = (storedLayout, submittedLayout) =>
  structuralFingerprint(storedLayout) !== structuralFingerprint(submittedLayout);

// The booked seats in a layout (each = one sold ticket).
export const bookedSeats = (layout = []) =>
  (layout || []).flatMap((row) => (row.seats || []).filter((s) => s.status === 'booked'));

// Granular seated edit lock (events-edit-locking.md D12): with bookings present, a booked seat may not
// be removed, moved, renumbered, released, or re-reserved - but safe edits (add a row, append seats to
// the end, change aisles, reserve/release UNBOOKED seats, remove unbooked seats) are fine because only
// booked seats are checked. Each booked seat must reappear in the submitted layout at the same seatId,
// row, and seat number, still booked. Throws a tagged 409 ("sold" in the message) on a violation.
export const assertBookedSeatsPreserved = (storedLayout, submittedLayout) => {
  const booked = bookedSeats(storedLayout);
  if (booked.length === 0) return;
  const submittedById = new Map();
  for (const row of submittedLayout || []) {
    for (const s of row.seats || []) submittedById.set(String(s.seatId), s);
  }
  const fail = (msg) => {
    const e = new Error(msg);
    e.statusCode = 409;
    e.code = 'SEATS_SOLD_LOCKED';
    throw e;
  };
  for (const b of booked) {
    const m = submittedById.get(String(b.seatId));
    if (!m) fail(`Seat ${b.row}${b.seatNumber} has been sold and can't be removed or the layout cleared.`);
    if (String(m.row) !== String(b.row) || String(m.seatNumber) !== String(b.seatNumber)) {
      fail(`Seat ${b.row}${b.seatNumber} has been sold, so it can't be moved or renumbered.`);
    }
    if (m.status !== 'booked') fail(`Seat ${b.row}${b.seatNumber} has been sold, so it can't be released or reserved.`);
  }
};

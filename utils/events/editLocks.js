// Activity-based edit locks - see featureplans/events-edit-locking.md (D8, D9, D10).
// These are the SERVER WALL: the edit form disables the same things for courtesy, but every lock is
// re-checked here at save against the freshly-loaded stored event. A violation throws a tagged 409.

const lockError = (message) => {
  const e = new Error(message);
  e.statusCode = 409;
  e.code = 'EDIT_LOCKED';
  return e;
};

// D7: the event type is locked from creation, regardless of activity. promo (advertise-only) takes
// precedence over the free/paid split (a promo event can be free or paid underneath).
export const eventTypeOf = ({ isAdvertiseOnly, isPaid } = {}) =>
  isAdvertiseOnly ? 'promo' : isPaid ? 'paid' : 'free';

export const assertEventTypeUnchanged = (stored, submitted) => {
  if (eventTypeOf(stored) !== eventTypeOf(submitted)) {
    const e = new Error('The event type (free, paid, or promo) cannot be changed after creation.');
    e.statusCode = 409;
    e.code = 'EDIT_LOCKED';
    throw e;
  }
};

// D11: capacity can always increase; it can only decrease down to the committed count (people already
// registered/sold), never below. Capacity 0/unset = unlimited, so it is never floored. committedCount
// is computed FRESH at save by the caller.
export const assertCapacityFloor = (submittedCapacity, committedCount) => {
  const cap = Number(submittedCapacity);
  if (!Number.isFinite(cap) || cap <= 0) return; // unlimited -> no floor
  if (committedCount > 0 && cap < committedCount) {
    const e = new Error(`Capacity can't be lower than the ${committedCount} people already registered.`);
    e.statusCode = 409;
    e.code = 'EDIT_LOCKED';
    throw e;
  }
};

const nameKey = (v) => String(v || '').trim();
const codeKey = (v) => String(v || '').trim().toUpperCase();
const bundleOf = (t) =>
  t?.bundleSize === undefined || t?.bundleSize === null || t?.bundleSize === '' ? null : Number(t.bundleSize);

// D8: once a ticket type has sold, its price, bundle toggle/size, name, and existence lock. A sold
// type is matched by NAME (it can't be renamed, so the name is its stable identity) - a rename or a
// delete both show up as the sold name missing from the submitted set. Carries hasSold forward from
// the stored event (the client can never set it). Returns the reconciled ticketTypes array; throws
// on a locked change. Unsold types pass through freely; adding new types is always allowed.
export const reconcileTicketTypeLocks = (submitted = [], stored = []) => {
  const submittedArr = Array.isArray(submitted) ? submitted : [];
  const storedArr = Array.isArray(stored) ? stored : [];
  const soldStored = storedArr.filter((t) => t?.hasSold);
  const byName = new Map(submittedArr.map((t) => [nameKey(t?.name), t]));

  for (const s of soldStored) {
    const match = byName.get(nameKey(s.name));
    if (!match) {
      throw lockError(`"${s.name}" has sold tickets and cannot be renamed or deleted.`);
    }
    if (Number(match.price) !== Number(s.price)) {
      throw lockError(`"${s.name}" has sold tickets, so its price cannot be changed.`);
    }
    if (bundleOf(match) !== bundleOf(s)) {
      throw lockError(`"${s.name}" has sold tickets, so its bundle setting cannot be changed.`);
    }
  }

  const soldNames = new Set(soldStored.map((t) => nameKey(t.name)));
  return submittedArr.map((t) => ({ ...t, hasSold: soldNames.has(nameKey(t?.name)) }));
};

// D9: once a discount code has been used (usedCount > 0), its text, value/kind, and which ticket
// types it applies to lock, and it cannot be deleted. Its max-uses floor + usedCount preservation are
// handled separately by reconcileDiscountCounters; its window/deactivate/advertise stay editable.
// Throws on a locked change; matches used codes by their (immutable) code text.
export const assertDiscountLocks = (stored = [], submitted = []) => {
  const storedArr = Array.isArray(stored) ? stored : [];
  const submittedArr = Array.isArray(submitted) ? submitted : [];
  const byCode = new Map(submittedArr.map((d) => [codeKey(d?.code), d]));
  const setEq = (a = [], b = []) =>
    a.length === b.length && [...a].map(String).sort().join('|') === [...b].map(String).sort().join('|');

  for (const s of storedArr) {
    if (!(Number(s?.usedCount) > 0)) continue; // only USED codes lock
    const match = byCode.get(codeKey(s.code));
    if (!match) {
      throw lockError(`Code "${s.code}" has been used and cannot be renamed or deleted.`);
    }
    if (String(match.kind) !== String(s.kind) || Number(match.value) !== Number(s.value)) {
      throw lockError(`Code "${s.code}" has been used, so its type and value cannot be changed.`);
    }
    if (!setEq(match.appliesToTicketTypes || [], s.appliesToTicketTypes || [])) {
      throw lockError(`Code "${s.code}" has been used, so the ticket types it applies to cannot be changed.`);
    }
  }
};

// Question edit-lock, id-anchored (events-rsvp-question-editing.md D5/D6). Once an event has activity
// each stored question must reappear (matched by its stable qid; name as a fallback for questions
// saved before ids landed). A stored question missing from the submitted set is a delete - rejected.
// PAID events keep the full freeze (any change to an answered question is rejected, rename included).
// FREE events allow label-safe edits (reword the label, APPEND a new option, edit scale labels, edit
// the stopped-registration message) while the meaning-changing parts stay locked: the type, the
// "Also ask time" flag, removing/renaming an existing option, and which options stop registration.
const CHOICE_TYPES = ['select', 'radio', 'checkboxes'];
const sortedEq = (a = [], b = []) =>
  a.length === b.length && [...a].map(String).sort().join('|') === [...b].map(String).sort().join('|');

// Paid full-freeze signature: any difference in name/type/options/required/includeTime rejects.
const paidQuestionSig = (q) =>
  JSON.stringify({
    n: nameKey(q?.fieldName),
    t: String(q?.fieldType || '').trim(),
    o: [...(q?.fieldOptions || [])].map((o) => String(o).trim()).sort(),
    r: !!q?.isRequired,
    it: !!q?.includeTime,
  });

// Free-event check: the immutable parts of an answered question must be unchanged. Throws on a
// meaning-changing edit; returns quietly when only label-safe parts differ.
const assertFreeQuestionEditable = (stored, submitted) => {
  const name = stored?.fieldName || 'this question';
  if (String(submitted?.fieldType) !== String(stored?.fieldType)) {
    throw lockError(`"${name}" has answers, so its question type can't be changed.`);
  }
  if (!!submitted?.includeTime !== !!stored?.includeTime) {
    throw lockError(`"${name}" has answers, so its date/time setting can't be changed.`);
  }
  if (!sortedEq(submitted?.blockingOptions || [], stored?.blockingOptions || [])) {
    throw lockError(`"${name}" has answers, so which answers stop registration can't be changed.`);
  }
  // Choice-type options are immutable except for NEW options appended at the end: the stored option
  // list must remain a prefix of the submitted one (same values, same order). Scale "options" are
  // just number labels and stay fully editable.
  if (CHOICE_TYPES.includes(String(stored?.fieldType))) {
    const oldOpts = (stored?.fieldOptions || []).map((o) => String(o).trim());
    const newOpts = (submitted?.fieldOptions || []).map((o) => String(o).trim());
    const preserved = oldOpts.every((o, i) => newOpts[i] === o);
    if (!preserved) {
      throw lockError(`"${name}" has answers, so an existing option can't be removed or renamed (you can still add new options).`);
    }
  }
};

export const assertQuestionLocks = (hasActivity, stored = [], submitted = [], isPaid = false) => {
  if (!hasActivity) return; // no activity -> questions fully editable
  const storedArr = Array.isArray(stored) ? stored : [];
  const submittedArr = Array.isArray(submitted) ? submitted : [];

  const subByQid = new Map();
  const subByName = new Map();
  for (const s of submittedArr) {
    if (s?.qid) subByQid.set(String(s.qid), s);
    subByName.set(nameKey(s?.fieldName), s);
  }

  for (const q of storedArr) {
    const match = (q?.qid && subByQid.get(String(q.qid))) || subByName.get(nameKey(q?.fieldName));
    if (!match) {
      throw lockError(
        `This event has attendees, so the question "${q.fieldName}" can't be removed. You can still add new questions.`
      );
    }
    if (isPaid) {
      if (paidQuestionSig(match) !== paidQuestionSig(q)) {
        throw lockError(
          `This is a paid event with attendees, so the question "${q.fieldName}" can't be edited. You can still add new questions.`
        );
      }
    } else {
      assertFreeQuestionEditable(q, match);
    }
  }
};

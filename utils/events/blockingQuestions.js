// Blocking answers on free-RSVP dropdown questions - see featureplans/events-rsvp-blocking-questions.md.
// Two pure helpers: one normalises/validates the organiser's config on create/update (the server is the
// source of truth, mirroring the wizard), the other is the registration WALL that judges an attendee's
// answers against the event's own questions. Free RSVP only.
import { DEFAULT_BLOCK_MESSAGE } from '../constants/registrationMessages.js';

// Stage 1: normalise each registration field's blocking config.
// - Blocking is dropdown-only: a non-select field carries no blocking.
// - A blocking value must be a non-blank option that exists in the field's own options (drop the rest).
// - A question may NOT block every option (at least one answer must allow registration) -> throws.
// - Any blocking option coerces the question to required (blocking implies required).
// - blockingMessage is trimmed and capped at 150 chars.
export const normalizeBlockingConfig = (fields = []) =>
  (Array.isArray(fields) ? fields : []).map((f, i) => {
    const field = { ...f };
    if (field.fieldType !== 'select') {
      field.blockingOptions = [];
      field.blockingMessage = '';
      return field;
    }
    const options = (Array.isArray(field.fieldOptions) ? field.fieldOptions : []).map((o) => String(o));
    const optionSet = new Set(options);
    const blocking = [
      ...new Set(
        (Array.isArray(field.blockingOptions) ? field.blockingOptions : [])
          .map((v) => String(v))
          .filter((v) => v.trim() !== '' && optionSet.has(v))
      ),
    ];
    if (blocking.length > 0 && optionSet.size > 0 && blocking.length >= optionSet.size) {
      throw new Error(
        `The question "${field.fieldName || `#${i + 1}`}" blocks every answer - leave at least one answer that allows registration.`
      );
    }
    field.blockingOptions = blocking;
    field.blockingMessage =
      typeof field.blockingMessage === 'string' ? field.blockingMessage.trim().slice(0, 150) : '';
    if (blocking.length > 0) field.isRequired = true;
    return field;
  });

// Stage 4: the WALL. Given the event's registration fields + the attendee's formResponses, return
// { blocked, message } if any answer chooses a blocking option for ITS question, or a blocking (hence
// required) question is missing/empty. Matched per-question by fieldName (no global value matching).
export const evaluateRegistrationBlock = (fields = [], formResponses = []) => {
  const answers = new Map();
  (Array.isArray(formResponses) ? formResponses : []).forEach((r) => {
    if (r && r.fieldName != null) answers.set(String(r.fieldName), r.response);
  });

  for (const field of Array.isArray(fields) ? fields : []) {
    const blocking = (Array.isArray(field.blockingOptions) ? field.blockingOptions : []).map((v) => String(v));
    if (blocking.length === 0) continue; // only blocking questions gate here
    const raw = answers.get(String(field.fieldName));
    const answer = raw == null ? '' : String(raw).trim();
    const message = (field.blockingMessage && field.blockingMessage.trim()) || DEFAULT_BLOCK_MESSAGE;
    // A blocking question is required, so a missing/empty answer is itself a block.
    if (answer === '' || blocking.includes(answer)) {
      return { blocked: true, message };
    }
  }
  return { blocked: false };
};

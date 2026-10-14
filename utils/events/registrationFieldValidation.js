// Registration-field validation - see featureplans/events-rsvp-question-types.md.
// The SERVER is the source of truth. Two pure functions:
//   finalizeRegistrationFields(fields, isPaid) - clean + validate the organiser's questions on
//     create/update (throws a 400-tagged Error on a violation).
//   validateRegistrationAnswers(fields, formResponses) - the registration WALL: enforce required
//     answers of every type, each answer's shape, and blocking; return the cleaned answers to store.
import {
  QUESTION_TYPES,
  PAID_QUESTION_TYPES,
  LABEL_MAX,
  OPTION_MAX,
  MIN_OPTIONS,
  TEXT_ANSWER_MAX,
  SCALE_MIN,
  SCALE_MAX,
  SCALE_LABEL_MAX,
  isChoiceType,
  isBlockableType,
} from './questionTypes.js';
import { DEFAULT_BLOCK_MESSAGE } from '../constants/registrationMessages.js';
import { randomUUID } from 'crypto';

const badRequest = (message) => {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
};

// --- Create / update finalizer (D2, D3, D5, D9) ---
// Returns the normalised field array; throws on any violation. isPaid decides which types are
// allowed and whether blocking survives. Promotional events pass [] here (they carry no questions).
export const finalizeRegistrationFields = (fields = [], isPaid = false) => {
  const arr = Array.isArray(fields) ? fields : [];
  const allowed = isPaid ? PAID_QUESTION_TYPES : QUESTION_TYPES;
  const seenNames = new Set();

  return arr.map((raw, i) => {
    const field = { ...raw };
    const label = String(field.fieldName ?? '').trim();
    const type = String(field.fieldType ?? '').trim();
    const qn = label || `#${i + 1}`;

    // Type gate (D2): paid events accept only text + dropdown; the six new types are free-only.
    if (!allowed.includes(type)) {
      if (isPaid && QUESTION_TYPES.includes(type)) {
        throw badRequest('Paid events support only text and dropdown questions.');
      }
      throw badRequest(`"${qn}" has an unknown question type.`);
    }

    // Label: required + capped (D5, D9).
    if (!label) throw badRequest(`Every question needs a label.`);
    if (label.length > LABEL_MAX) {
      throw badRequest(`A question label can be at most ${LABEL_MAX} characters.`);
    }

    // Unique name, case-insensitive + trimmed (D9).
    const nameKey = label.toLowerCase();
    if (seenNames.has(nameKey)) {
      throw badRequest(`Question names must be unique: "${label}" is used more than once.`);
    }
    seenNames.add(nameKey);

    // Stable id (D1): preserve the id the wizard round-tripped; mint one when it's absent (a new
    // question, or one saved before this feature). This is what answers link to going forward.
    field.qid = (typeof field.qid === 'string' && field.qid.trim()) ? field.qid.trim() : randomUUID();
    field.fieldName = label;
    field.fieldType = type;
    field.isRequired = !!field.isRequired;
    // "Also ask time" lives on date questions only; any other type carries false.
    field.includeTime = type === 'date' ? !!field.includeTime : false;

    // Options (choice types only) - non-empty, capped, unique (D5).
    if (isChoiceType(type)) {
      const options = (Array.isArray(field.fieldOptions) ? field.fieldOptions : []).map((o) => String(o).trim());
      if (options.length < MIN_OPTIONS) throw badRequest(`"${qn}" needs at least ${MIN_OPTIONS} options.`);
      if (options.some((o) => o === '')) throw badRequest(`"${qn}" has an empty option.`);
      if (options.some((o) => o.length > OPTION_MAX)) {
        throw badRequest(`An option can be at most ${OPTION_MAX} characters.`);
      }
      const lowered = options.map((o) => o.toLowerCase());
      if (new Set(lowered).size !== lowered.length) throw badRequest(`"${qn}" has duplicate options.`);
      field.fieldOptions = options;
    } else if (type === 'scale') {
      // Scale labels ride fieldOptions POSITIONALLY (slot 0 = number 1): up to 5, each optional
      // (may be ''), capped like a choice option. All-empty stores [].
      const labels = (Array.isArray(field.fieldOptions) ? field.fieldOptions : [])
        .slice(0, SCALE_MAX)
        .map((o) => String(o).trim());
      if (labels.some((l) => l.length > SCALE_LABEL_MAX)) {
        throw badRequest(`A scale label can be at most ${SCALE_LABEL_MAX} characters.`);
      }
      field.fieldOptions = labels.some((l) => l !== '') ? labels : [];
    } else {
      field.fieldOptions = [];
    }

    // Blocking (D3): select + radio, free events only. Drop values not in the option list, coerce
    // the question to required, and reject a question that blocks every answer. Paid strips it.
    const canBlock = !isPaid && isBlockableType(type);
    if (canBlock) {
      const optionSet = new Set(field.fieldOptions);
      const blocking = [
        ...new Set(
          (Array.isArray(field.blockingOptions) ? field.blockingOptions : [])
            .map((v) => String(v))
            .filter((v) => v.trim() !== '' && optionSet.has(v))
        ),
      ];
      if (blocking.length > 0 && optionSet.size > 0 && blocking.length >= optionSet.size) {
        throw badRequest(`"${qn}" blocks every answer - leave at least one answer that allows registration.`);
      }
      field.blockingOptions = blocking;
      field.blockingMessage =
        typeof field.blockingMessage === 'string' ? field.blockingMessage.trim().slice(0, 150) : '';
      if (blocking.length > 0) field.isRequired = true;
    } else {
      field.blockingOptions = [];
      field.blockingMessage = '';
    }

    // Never persist client-only edit flags.
    delete field._existing;
    delete field._lockedOptions;
    return field;
  });
};

// --- Registration answer wall (D7, D8, D11) ---
const isEmptyAnswer = (v) =>
  v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');

const isValidDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(String(v)));
const isValidTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
// The browser's combined date-and-time box submits "YYYY-MM-DDTHH:MM".
const isValidDateTime = (v) =>
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) && !Number.isNaN(Date.parse(String(v)));

// Given the event's registration fields + the attendee's submitted formResponses, decide whether
// the registration may proceed. Returns { ok:true, answers } (answers = the cleaned list to store)
// or { ok:false, message } (a 400 reason). Blocking and required-missing on a blocking question
// return the block message; other required/shape failures return a plain reason.
export const validateRegistrationAnswers = (fields = [], formResponses = []) => {
  const submitted = new Map();
  (Array.isArray(formResponses) ? formResponses : []).forEach((r) => {
    if (r && r.fieldName != null) submitted.set(String(r.fieldName), r.response);
  });

  const answers = [];

  for (const field of Array.isArray(fields) ? fields : []) {
    const type = String(field.fieldType || '');
    const label = String(field.fieldName || '');
    const raw = submitted.get(label);
    const blocking = (Array.isArray(field.blockingOptions) ? field.blockingOptions : []).map(String);
    const blockMessage = (field.blockingMessage && field.blockingMessage.trim()) || DEFAULT_BLOCK_MESSAGE;
    const options = Array.isArray(field.fieldOptions) ? field.fieldOptions.map(String) : [];

    // Yes/No: an unticked box records "No" (D7), so an optional one is never "missing".
    let stored = raw;
    if (type === 'yesno' && isEmptyAnswer(raw)) stored = 'No';

    // Blocking wall (a blocking question is always required): an empty answer or a blocking option
    // both refuse with the block message.
    if (blocking.length > 0) {
      if (isEmptyAnswer(raw) || blocking.includes(String(raw).trim())) {
        return { ok: false, message: blockMessage };
      }
    }

    // Required (D11) - every type. Yes/No required means the box must be ticked (answer "Yes").
    if (field.isRequired) {
      if (type === 'yesno') {
        if (String(stored).trim() !== 'Yes') return { ok: false, message: `${label} is required.` };
      } else if (isEmptyAnswer(raw)) {
        return { ok: false, message: `${label} is required.` };
      }
    }

    // Shape (D11) - only when an answer is present. Unknown/legacy types skip shape checks.
    if (!isEmptyAnswer(stored)) {
      switch (type) {
        case 'text':
          if (String(stored).length > TEXT_ANSWER_MAX) {
            return { ok: false, message: `${label} answer is too long (max ${TEXT_ANSWER_MAX} characters).` };
          }
          break;
        case 'select':
        case 'radio':
          if (options.length > 0 && !options.includes(String(stored))) {
            return { ok: false, message: `${label} has an invalid answer.` };
          }
          break;
        case 'checkboxes': {
          const chosen = Array.isArray(stored) ? stored.map(String) : [String(stored)];
          if (options.length > 0 && !chosen.every((c) => options.includes(c))) {
            return { ok: false, message: `${label} has an invalid answer.` };
          }
          stored = chosen;
          break;
        }
        case 'scale': {
          const n = Number(stored);
          if (!Number.isInteger(n) || n < SCALE_MIN || n > SCALE_MAX) {
            return { ok: false, message: `${label} must be between ${SCALE_MIN} and ${SCALE_MAX}.` };
          }
          break;
        }
        case 'date':
          // With "Also ask time" on, the answer is one combined date-and-time value.
          if (field.includeTime) {
            if (!isValidDateTime(stored)) return { ok: false, message: `${label} has an invalid date and time.` };
          } else if (!isValidDate(stored)) {
            return { ok: false, message: `${label} has an invalid date.` };
          }
          break;
        case 'time':
          if (!isValidTime(stored)) return { ok: false, message: `${label} has an invalid time.` };
          break;
        case 'yesno':
          if (String(stored) !== 'Yes' && String(stored) !== 'No') {
            return { ok: false, message: `${label} has an invalid answer.` };
          }
          break;
        default:
          break; // legacy/unknown type: no shape rule
      }
    }

    // Store the cleaned answer (skip truly empty ones, but always record a yes/no). The answer links
    // to its question by qid (events-rsvp-question-editing.md D2), keeping the text too (additive).
    if (!isEmptyAnswer(stored) || type === 'yesno') {
      answers.push({ fieldName: label, qid: field.qid, response: stored });
    }
  }

  return { ok: true, answers };
};

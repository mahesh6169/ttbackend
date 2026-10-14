// Canonical RSVP question types - see featureplans/events-rsvp-question-types.md (D1, D2, D5).
// One source of truth shared by the create/update finalizer and the registration answer wall.
// The frontend mirrors this list in ttfrontend/utils/events/questionTypes.js.
//
// The eight types: text and dropdown (select) ship on free AND paid; the other six are free-only
// (D2 - the server rejects a new-type question on a paid event). Blocking (D3) is limited to the
// two single-pick choice types (select, radio) and to free events.

// All eight types a FREE event may carry.
export const QUESTION_TYPES = ['text', 'select', 'radio', 'checkboxes', 'scale', 'date', 'time', 'yesno'];

// The only two types a PAID event may carry (unchanged from before this feature).
export const PAID_QUESTION_TYPES = ['text', 'select'];

// Choice types carry an option list (fieldOptions).
export const CHOICE_TYPES = ['select', 'radio', 'checkboxes'];

// Single-pick choice types that may carry blocking (free events only).
export const BLOCKABLE_TYPES = ['select', 'radio'];

// Server caps (D5) - enforced on save, not just in the browser.
export const LABEL_MAX = 200;   // question label / fieldName
export const OPTION_MAX = 150;  // each choice option
export const MIN_OPTIONS = 2;   // a choice question needs at least two real options
export const TEXT_ANSWER_MAX = 500; // a typed text answer

// Linear scale is a fixed 1..5 (D6).
export const SCALE_MIN = 1;
export const SCALE_MAX = 5;
export const SCALE_LABEL_MAX = 15; // per-number label - short so it fits inside the pill

export const isChoiceType = (t) => CHOICE_TYPES.includes(t);
export const isBlockableType = (t) => BLOCKABLE_TYPES.includes(t);

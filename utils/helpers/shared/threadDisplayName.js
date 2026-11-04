// Feature 1012: the name shown for a thread everywhere (lists, home, cards) is the author name the
// writer typed. Older threads without one fall back to "Desify Team" for curated threads, else the
// account name. Used inside aggregation pipelines that have looked up the owner as `ownerData`.
export const threadDisplayNameExpr = {
  $let: {
    vars: { a: { $trim: { input: { $ifNull: ['$author.name', ''] } } } },
    in: {
      $cond: [
        { $gt: [{ $strLenCP: '$$a' }, 0] },
        '$$a',
        { $cond: ['$isCuratedThread', 'Desify Team', { $arrayElemAt: ['$ownerData.name', 0] }] },
      ],
    },
  },
};

// Same rule for a plain thread document with `owner` populated (name).
export const threadDisplayName = (t) =>
  (t?.author?.name || '').trim() || (t?.isCuratedThread ? 'Desify Team' : t?.owner?.name) || '';

export const AUTHOR_NAME_MAX = 100;

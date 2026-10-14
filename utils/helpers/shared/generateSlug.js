const MAX_SLUG_LENGTH = 50;

const generateSlug = (title, maxLength = MAX_SLUG_LENGTH) => {
  if (!title || typeof title !== 'string') return 'untitled';
  
  let slug = title.toLowerCase().trim();

  // 3-step slugify (see designGuides/SEO/detailspage/listings.md, Phase 1):
  //   1) strip apostrophes so "mum's" -> "mums" (not "mum-s")
  //   2) turn every other non-alphanumeric run into a single dash, so words
  //      stay apart: "fish&chips" -> "fish-chips", "chicken/veg" -> "chicken-veg"
  //   3) trim dashes off the ends
  slug = slug
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) return 'untitled';
  
  if (slug.length > maxLength) {
    slug = slug.substring(0, maxLength);
    
    const lastHyphen = slug.lastIndexOf('-');
    if (lastHyphen > maxLength * 0.7) {
      slug = slug.substring(0, lastHyphen);
    }
    
    slug = slug.replace(/-+$/, '');
  }
  
  return slug || 'untitled';
};

// Ensure the slug is unique for this Model: baseSlug, then baseSlug-1, -2, ...
const ensureUniqueSlug = async (Model, baseSlug, excludeId = null) => {
  let slug = baseSlug;
  let counter = 1;

  while (true) {
    const query = { slug };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const existing = await Model.findOne(query);

    if (!existing) {
      return slug;
    }

    slug = `${baseSlug}-${counter}`;
    counter++;
  }
};

export { generateSlug, ensureUniqueSlug };

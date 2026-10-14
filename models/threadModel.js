import mongoose from 'mongoose';

const threadSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    question: {
      type: String,
      required: true,
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    category: {
      type: String,
      required: true,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
    ],

    // ✅ Add Cloudinary image support
    images: [
      {
        url: { type: String },
        publicId: { type: String },
        originalFilename: { type: String },
      },
    ],

    // ✅ Add suburb field like in User model
    suburb: {
      name: { type: String, required: true },          // e.g. "Subiaco"
      state: { type: String, required: true },         // e.g. "WA"
      postalCode: { type: String, required: false, default: '' },    // Now optional
      location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true }, // [lng, lat]
      },
    },
    
    // ✅ Add communities field for language/community targeting
    communities: [{
      type: String,
      trim: true,
      lowercase: true
    }],

    // ✅ Curated thread flag (auto-set when creator's email is in CURATOR_EMAILS)
    isCuratedThread: {
      type: Boolean,
      default: false,
    },

    // Author details (optional)
    author: {
      name: {
        type: String,
        trim: true
      },
      website: {
        type: String,
        trim: true
      },
      contact: {
        type: String,
        trim: true
      },
      email: {
        type: String,
        trim: true,
        lowercase: true
      },
      aboutMyself: {
        type: String,
        trim: true,
        maxlength: 500
      },
      socialMedia: [{
        platform: {
          type: String,
          trim: true
        },
        url: {
          type: String,
          trim: true
        }
      }]
    },
    
  },
  { timestamps: true }
);

// ✅ Add a 2dsphere index on the location field for geospatial queries
threadSchema.index({ 'suburb.location': '2dsphere' });
// ✅ Add index for communities field for better search performance
threadSchema.index({ communities: 1 });
// ✅ Add text index for full-text search on title and question
threadSchema.index({ title: 'text', question: 'text' });

const Thread = mongoose.model('Thread', threadSchema);
export default Thread;
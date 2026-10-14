import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    // 'advert', 'event', or 'deal'
    relatedTo: {
      type: String,
      enum: ['advert', 'event', 'deal'],
      required: true,
    },

    // One of these will be populated based on relatedTo
    advert: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Advert',
    },
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
    },
    deal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DailyDeal',
    },

    // Messaging parties
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    participant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    senderRole: {
      type: String,
      enum: ['owner', 'participant'],
      required: true,
    },

    message: {
      type: String,
      required: true,
    },

    readBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    deletedBy: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },
    
    // Reply feature
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    
    // Soft delete timestamp
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Message = mongoose.model('Message', messageSchema);
export default Message;

import mongoose from 'mongoose';

const threadMessageSchema = new mongoose.Schema(
  {
    thread: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Thread',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ThreadMessage',
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    likes: { 
      type: Number, 
      default: 0 // ✅ Store the number of likes
    },
    dislikes: { 
      type: Number, 
      default: 0 // ✅ Store the number of dislikes
    }
  },
  { timestamps: true  }
);

const ThreadMessage = mongoose.model('ThreadMessage', threadMessageSchema);
export default ThreadMessage;

import mongoose from 'mongoose';

const freeTicketSchema = new mongoose.Schema(
  {
    // 🎫 Ticket Information
     event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true
    },
    registrationNumber: {
      type: String,
      required: true
    },
    
    // 🔄 Recurring Event Instance Information
    instanceDate: {
      type: Date,
      default: null // Set for recurring event registrations
    },
    parentEventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      default: null // Link to parent recurring event
    },
    isRecurringInstance: {
      type: Boolean,
      default: false
    },
    
    // 👤 Attendee Information
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    email: {
      type: String,
      required: true,
    },
    mobile: {
      type: String,
      required: true,
      trim: true
    },
    attendees: [
      {
        name: {
          type: String,
          required: true
        },
        checkedIn: {
          type: Boolean,
          default: false
        },
        checkInTime: Date,
      },
    ],
    
    // 📝 Form Responses. qid links the answer to its question (events-rsvp-question-editing.md D2);
    // fieldName is kept as the label asked under (displays prefer the question's CURRENT label by qid,
    // and fall back to this text for answers stored before ids landed).
    formResponses: [{
      fieldName: String,
      qid: String,
      response: mongoose.Schema.Types.Mixed
    }],

    // Event Details from Event Schema
    eventSnapshot: {
  eventCode: String,
  title: String,
  dateTime: Date,
  timeZone: String,
  venue: String,
  address: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  category: String,
  capacity: Number,
  organizer: {
    name: String,
    email: String,
    phone: String
  },
  postedBy: String
},
    
    // 🔄 Status Information
    status: {
      type: String,
      default: 'registered',
      index: true
    },
    
    // ✅ Check-In Information
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    
    // 📱 Communication
    confirmationSentAt: {
  type: Date,
  default: null
},
reminderSentAt: {
  type: Date,
  default: null
},
  },
  { 
    timestamps: true 
  }
);

// Indexes
freeTicketSchema.index({ event: 1, status: 1 });


const FreeTicket = mongoose.model('FreeTicket', freeTicketSchema);
export default FreeTicket;
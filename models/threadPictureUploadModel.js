import mongoose from 'mongoose';

// Feature 1012: every picture uploaded from the thread editor is noted here when it is uploaded
// (before the thread exists). Pictures still not used by any thread after 24 hours (the writer
// pressed Cancel, closed the page, never pressed Create) are deleted from Cloudinary by the tidy-up
// in threadController.uploadThreadPicture.
const threadPictureUploadSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

threadPictureUploadSchema.index({ createdAt: 1 });

export default mongoose.model('ThreadPictureUpload', threadPictureUploadSchema);

import { config } from 'dotenv';
// Configure dotenv with the path to the .env file
config();

import { v2 as cloudinary } from 'cloudinary';

if (process.env.NODE_ENV === 'development') {
  console.log('CLOUDINARY_CLOUD_NAME:', process.env.CLOUDINARY_CLOUD_NAME);
  console.log('CLOUDINARY_API_KEY:', process.env.CLOUDINARY_API_KEY);
}
console.log('CLOUDINARY_API_SECRET:', process.env.CLOUDINARY_API_SECRET ? '✓ LOADED' : '✗ NOT LOADED');

// Configure Cloudinary with environment variables
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Example async upload function (commented out as in the original)
// (async function () {
//     const result = await cloudinary.uploader.upload('../images/waiter.jpg');
//     console.log(result);
// })();

export default cloudinary;
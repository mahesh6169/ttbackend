import multer from 'multer';

// Configure Multer to store files in memory for direct Cloudinary uploads
const storage = multer.memoryStorage();

// Basic file filter - only check if it's actually an image file
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed.'));
    }
};

// Generous limits - let business logic handle specific restrictions
const upload = multer({
    storage,
    limits: { 
        fileSize: 50 * 1024 * 1024, // 50MB - generous limit, controllers decide actual limits
        files: 20 // Max 20 files - controllers decide actual limits
    },
    fileFilter,
}).fields([
    { name: 'images', maxCount: 20 },
    { name: 'seatingLayoutImageFiles', maxCount: 4 },
    { name: 'logo', maxCount: 1 }
]);

// Middleware for handling uploads
const multerMiddleware = (req, res, next) => {
    upload(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ 
                    message: 'File too large. Maximum file size exceeded.' 
                });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ 
                    message: 'Too many files uploaded.' 
                });
            }
            return res.status(400).json({ message: err.message });
        }
        
        if (err) {
            console.error('Upload Error:', err.message);
            return res.status(400).json({ message: err.message });
        }
        
        // Keep the original req.files structure when using .fields()
        // This preserves both 'images' and 'seatingLayoutImageFiles'
        // For backward compatibility, some functions may still expect req.files as array
        // but the seating image functions will access req.files.seatingLayoutImageFiles directly
        
        next();
    });
};

export { multerMiddleware };
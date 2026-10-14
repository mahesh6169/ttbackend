import jwt from 'jsonwebtoken';

const authAdminMiddleware = (req, res, next) => {
    const token = req.cookies?.token;


    if (!token) {
        console.log('No token provided.');
        return res.status(401).json({ message: 'Authentication required. Please log in.' });
    }

    try {
        //console.log("🔑 JWT_SECRET in middleware:", process.env.JWT_SECRET);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Attach decoded user data [id, role, exp] to request

        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Admin access required.' });
        }

        next(); // Proceed to the next middleware or route handler
    } catch (error) {
        console.error('Token verification failed:', error.message);
        return res.status(401).json({ message: 'Invalid or expired token. Please log in again.' });
    }
};

export default authAdminMiddleware;

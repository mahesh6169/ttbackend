const accessMiddleware = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !req.user.role) {
            return res.status(403).json({ message: 'Access denied. No user role found.' });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
        }

        next(); // User has permission, proceed to the controller
    };
};

export default accessMiddleware;
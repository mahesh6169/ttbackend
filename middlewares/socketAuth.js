import cookie from 'cookie';
import jwt from 'jsonwebtoken';

const socketAuth = (socket, next) => {
  try {
    // First check API key authentication
    const apiKey = socket.handshake.auth?.apiKey || socket.handshake.headers['x-api-key'];
    const expectedKey = process.env.FRONTEND_API_KEY;
    const apiKeyMode = process.env.API_KEY_MODE || 'warn';
    
    if (apiKeyMode !== 'off') {
      const isValidKey = apiKey && apiKey === expectedKey;
      
      if (!isValidKey) {
        const reason = !apiKey ? 'missing-api-key' : 'invalid-api-key';
        
        if (apiKeyMode === 'warn') {
          console.warn(`⚠️ [WARN MODE - Socket.io] ${reason} for socket connection`);
          // In warn mode, continue with JWT auth
        } else if (apiKeyMode === 'enforce') {
          console.error(`❌ [ENFORCE MODE - Socket.io] ${reason} for socket connection`);
          return next(new Error('Unauthorized: Invalid or missing API key'));
        }
      }
    }
    
    // Continue with existing JWT authentication
    const cookieHeader = socket.handshake.headers.cookie;

    if (!cookieHeader) {
      console.log('No cookie header provided.');
      return next(new Error('No cookie header provided.'));
    }

    const cookies = cookie.parse(cookieHeader);
    const token = cookies.token;

    if (!token) {
      console.log('No token provided in cookies.');
      return next(new Error('Authentication required.'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded; // Attach user data to the socket
    next(); // Allow connection
  } catch (error) {
    console.error('Socket authentication failed:', error.message);
    next(new Error('Authentication failed.'));
  }
};

export default socketAuth;

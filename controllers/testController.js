const testController = {
  // Test endpoint
  testRoute: async (req, res) => {
    try {
      res.status(200).json({
        success: true,
        message: 'Test controller is working',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Test controller error',
        error: error.message
      });
    }
  },

  // Health check endpoint
  healthCheck: async (req, res) => {
    try {
      res.status(200).json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
      });
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        error: error.message
      });
    }
  },

  // Hello function
  hello: async (req, res) => {
    try {
      const name = req.query.name || 'World';
      res.status(200).json({
        success: true,
        message: `Hello ${name}, how is your day today`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Error in hello function',
        error: error.message
      });
    }
  }
};

module.exports = testController;
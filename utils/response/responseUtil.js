// utils/responseBuilder.js

export const sendSuccess = (res, message, data = {}, statusCode = 200) => {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
    });
  };
  
  export const sendValidationError = (res, errors = [], message = 'Validation failed', statusCode = 400) => {
    return res.status(statusCode).json({
      success: false,
      message,
      errors,
    });
  };
  
  export const sendError = (res, message = 'Something went wrong', error = null, statusCode = 500) => {
    const response = {
      success: false,
      message,
    };
  
    if (error) {
      response.error = error.message || error;
    }
  
    return res.status(statusCode).json(response);
  };
  
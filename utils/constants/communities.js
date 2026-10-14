// Community/Language constants used across the application

export const COMMUNITIES = [
  { value: 'punjabi', label: 'Punjabi' },
  { value: 'hindi', label: 'Hindi' },
  { value: 'urdu', label: 'Urdu' },
  { value: 'tamil', label: 'Tamil' },
  { value: 'gujarati', label: 'Gujarati' },
  { value: 'malayalam', label: 'Malayalam' },
  { value: 'bengali', label: 'Bengali' },
  { value: 'telugu', label: 'Telugu' },
  { value: 'marathi', label: 'Marathi' },
  { value: 'kannada', label: 'Kannada' },
  { value: 'sindhi', label: 'Sindhi' },
  { value: 'odia', label: 'Odia' },
  { value: 'konkani', label: 'Konkani' }
];


// For validation purposes
export const COMMUNITY_VALUES = COMMUNITIES.map(c => c.value);

export default COMMUNITIES;
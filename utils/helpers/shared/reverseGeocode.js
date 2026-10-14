import axios from '@/utils/axiosConfig';

export const reverseGeocode = async (lat, lng) => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          latlng: `${lat},${lng}`,
          key: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
        },
      }
    );

    const result = response.data.results[0];
    return result ? result.formatted_address : '';
  } catch (error) {
    console.error('Reverse Geocode Error:', error);
    return '';
  }
};

import Advert from '../models/advertModel.js';
import Event from '../models/eventModel.js';
import DailyDeal from '../models/dailydeals/dailyDeal.js';

export const getResourceModel = (type) => {
  if (type === 'advert') return Advert;
  if (type === 'event') return Event;
  if (type === 'deal') return DailyDeal;
  throw new Error('Invalid resource type');
};

// models/platformSettingModel.js
// Site-wide switches the admin sets on the Platform Settings page. One document only, found by
// key 'site'. A missing document means every switch is at its default (everything shown), so a
// fresh database or a failed read never hides a section by accident.
import mongoose from 'mongoose';

export const PLATFORM_SETTINGS_KEY = 'site';

// The switches, with their defaults. Add a new switch here and it flows through the public
// and admin endpoints (controllers/platformSettingController.js).
export const PLATFORM_SETTING_DEFAULTS = {
  showDeals: true,   // Deals in the site menus, profile tile and profile menu
  showCoupons: true, // Coupons in the site menus
};

const platformSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: PLATFORM_SETTINGS_KEY },
    showDeals: { type: Boolean, default: PLATFORM_SETTING_DEFAULTS.showDeals },
    showCoupons: { type: Boolean, default: PLATFORM_SETTING_DEFAULTS.showCoupons },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const PlatformSetting = mongoose.model('PlatformSetting', platformSettingSchema);

export default PlatformSetting;

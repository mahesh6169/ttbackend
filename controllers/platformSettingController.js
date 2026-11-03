// controllers/platformSettingController.js
// Site-wide switches (models/platformSettingModel.js): a public read for the site menus and an
// admin read/update for the Platform Settings page.
import asyncHandler from 'express-async-handler';
import PlatformSetting, {
  PLATFORM_SETTINGS_KEY,
  PLATFORM_SETTING_DEFAULTS,
} from '../models/platformSettingModel.js';
import { refreshFrontendCache } from '../utils/refreshFrontendCache.js';

const SWITCHES = Object.keys(PLATFORM_SETTING_DEFAULTS);

// The stored switches merged over the defaults, so a missing document reads as "all shown".
const readSwitches = async () => {
  const doc = await PlatformSetting.findOne({ key: PLATFORM_SETTINGS_KEY }).lean();
  const out = {};
  for (const name of SWITCHES) {
    out[name] = typeof doc?.[name] === 'boolean' ? doc[name] : PLATFORM_SETTING_DEFAULTS[name];
  }
  return { switches: out, updatedAt: doc?.updatedAt || null };
};

// GET /api/settings - public, used by the frontend layout to build the menus.
export const getPublicSettings = asyncHandler(async (req, res) => {
  const { switches } = await readSwitches();
  res.status(200).json({ success: true, settings: switches });
});

// GET /api/admin/platform-settings
export const getAdminSettings = asyncHandler(async (req, res) => {
  const { switches, updatedAt } = await readSwitches();
  res.status(200).json({ success: true, settings: switches, updatedAt });
});

// PUT /api/admin/platform-settings  body: any of { showDeals, showCoupons } as true/false.
export const updateAdminSettings = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const update = {};

  for (const name of SWITCHES) {
    if (body[name] === undefined) continue;
    if (typeof body[name] !== 'boolean') {
      return res.status(400).json({ success: false, message: `${name} must be true or false` });
    }
    update[name] = body[name];
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({
      success: false,
      message: `Send at least one of: ${SWITCHES.join(', ')}`,
    });
  }

  await PlatformSetting.findOneAndUpdate(
    { key: PLATFORM_SETTINGS_KEY },
    { $set: { ...update, updatedBy: req.user?.id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // The menus are cached on the frontend under this tag; drop it so the change shows at once.
  await refreshFrontendCache('platform-settings');

  const { switches, updatedAt } = await readSwitches();
  res.status(200).json({ success: true, settings: switches, updatedAt });
});

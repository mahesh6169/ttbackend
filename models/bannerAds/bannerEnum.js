// State codes for Australian states
export const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT", "ALL"];

// Status enums
export const BANNER_STATUS = ["active", "paused", "expired"];
export const BUSINESS_STATUS = ["active", "paused"];

// Destination and visibility enums
export const DESTINATION_TYPE = ["internal", "external"];
export const PLACEMENT_VISIBILITY = ["all", "desktopOnly", "mobileOnly"];
export const DEVICE_ENUM = ["desktop", "mobile"];

// Placement IDs - Horizontal (H) and Vertical (V)
export const PLACEMENT_IDS = {
  // Horizontal placements
  TOP_FULL: "H1",
  TOP_SPLIT_1: "H1-1",
  TOP_SPLIT_2: "H1-2",
  BOTTOM_FULL: "H2",
  BOTTOM_SPLIT_1: "H2-1",
  BOTTOM_SPLIT_2: "H2-2",
  
  // Vertical placements
  LEFT_FULL: "V1",
  LEFT_SPLIT_1: "V1-1",
  LEFT_SPLIT_2: "V1-2",
  RIGHT_FULL: "V2",
  RIGHT_SPLIT_1: "V2-1",
  RIGHT_SPLIT_2: "V2-2"
};

// All valid placement IDs for validation
export const ALL_PLACEMENT_IDS = Object.values(PLACEMENT_IDS);
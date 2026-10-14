import mongoose from 'mongoose';
import { BannerPlacement } from '../models/bannerAds/index.js';
import dotenv from 'dotenv';

dotenv.config();

// Initial placement data
const initialPlacements = [
  {
    placementId: "H1",
    name: "Top Banner",
    visibility: "all",
    layoutType: "full",
    children: [],
    dimensions: {
      width: 1472,
      height: 100
    },
    status: "active",
    maxAds: 5,
    defaultWeight: 10
  },
  {
    placementId: "H2", 
    name: "Bottom Banner",
    visibility: "all",
    layoutType: "full",
    children: [],
    dimensions: {
      width: 1472,
      height: 100
    },
    status: "active",
    maxAds: 5,
    defaultWeight: 10
  },
  {
    placementId: "V1",
    name: "Left Sidebar",
    visibility: "desktopOnly",
    layoutType: "full",
    children: [],
    dimensions: {
      width: 160,
      height: 600
    },
    status: "active",
    maxAds: 3,
    defaultWeight: 10
  },
  {
    placementId: "V2",
    name: "Right Sidebar",
    visibility: "desktopOnly",
    layoutType: "full",
    children: [],
    dimensions: {
      width: 160,
      height: 600
    },
    status: "active",
    maxAds: 3,
    defaultWeight: 10
  }
];

// Seed function
async function seedBannerPlacements() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Check if placements already exist
    const existingCount = await BannerPlacement.countDocuments();
    if (existingCount > 0) {
      console.log(`Found ${existingCount} existing placements. Skipping seed.`);
      return;
    }

    // Insert initial placements
    const result = await BannerPlacement.insertMany(initialPlacements);
    console.log(`Successfully seeded ${result.length} banner placements:`);
    result.forEach(placement => {
      console.log(`  - ${placement.placementId}: ${placement.name}`);
    });

  } catch (error) {
    console.error('Error seeding banner placements:', error);
  } finally {
    // Close connection
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

// Run if called directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  seedBannerPlacements();
}

export default seedBannerPlacements;
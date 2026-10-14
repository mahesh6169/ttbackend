import { BannerAd, BannerPlacement, BannerMetrics } from '../../models/bannerAds/index.js';
import { AU_STATES } from '../../models/bannerAds/bannerEnum.js';

// Helper function to get user state
const getUserState = (req) => {
  // 1. Check if user is logged in and has suburb.state
  if (req.user && req.user.suburb && req.user.suburb.state) {
    return req.user.suburb.state;
  }
  
  // 2. Check cookie for non-logged users
  if (req.cookies && req.cookies.userSelectedState) {
    return req.cookies.userSelectedState;
  }
  
  // 3. Default to null (will show ALL state ads)
  return null;
};

// Get ads for a specific placement
export const serveAds = async (req, res) => {
  try {
    const { placement } = req.params;
    const userState = getUserState(req);
    const userAgent = req.headers['user-agent'] || '';
    // Better mobile detection - check for common mobile indicators
    const device = /mobile|android|iphone|ipad|phone|tablet|kindle|silk|blackberry|opera mini|opera mobi/i.test(userAgent) ? 'mobile' : 'desktop';
    
    console.log('=== SERVE ADS REQUEST ===');
    console.log('Placement:', placement);
    console.log('Device:', device);
    
    // Get placement details
    const placementDoc = await BannerPlacement.findOne({ 
      placementId: placement.toUpperCase()
    });
    
    if (!placementDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'Placement not found or inactive' 
      });
    }
    
    console.log('Current rotation index:', placementDoc.rotationIndex || 0);
    console.log('Assigned ads:', placementDoc.assignedAds?.length || 0);
    
    // Check if placement has assigned ads
    if (!placementDoc.assignedAds || placementDoc.assignedAds.length === 0) {
      console.log('No assigned ads for this placement');
      return res.json({ 
        success: true, 
        placement: placement.toUpperCase(),
        ads: [] 
      });
    }
    
    const now = new Date();
    let selectedAds = [];
    
    // Get current rotation index
    const currentIndex = placementDoc.rotationIndex || 0;
    
    // All placements use rotation - get the ad ID from assignedAds array using rotation index
    const assignedAdIndex = currentIndex % placementDoc.assignedAds.length;
    const assignedAd = placementDoc.assignedAds[assignedAdIndex];
    
    // Fetch the actual ad
    const ad = await BannerAd.findOne({ 
      adId: assignedAd.adId,
      status: 'active',
      'schedule.startAt': { $lte: now },
      'schedule.endAt': { $gte: now }
    }).populate('businessId', 'name status').lean();
    
    // Validate the ad
    if (ad && ad.businessId && ad.businessId.status === 'active') {
      // Check state targeting
      const stateValid = !ad.targetStates || ad.targetStates.length === 0 || 
                        (userState && ad.targetStates.includes(userState));
      
      // Check caps
      const capsValid = (!ad.caps?.maxImpressions || ad.counters?.impressions < ad.caps.maxImpressions) &&
                       (!ad.caps?.maxClicks || ad.counters?.clicks < ad.caps.maxClicks);
      
      if (stateValid && capsValid) {
        selectedAds = [ad];
        console.log(`Selected ad: ${ad.adId} from assignedAds[${assignedAdIndex}]`);
      } else {
        console.log(`Ad ${ad.adId} failed validation - state: ${stateValid}, caps: ${capsValid}`);
      }
    } else {
      console.log(`Ad ${assignedAd.adId} not found or inactive`);
    }
    
    // Always update rotation index for next request
    await BannerPlacement.updateOne(
      { placementId: placement.toUpperCase() },
      { 
        rotationIndex: (currentIndex + 1) % placementDoc.assignedAds.length,
        [`assignedAds.${assignedAdIndex}.lastServed`]: new Date()
      }
    );
    
    if (selectedAds.length === 0) {
      return res.json({ 
        success: true, 
        placement: placement.toUpperCase(),
        ads: [] 
      });
    }
    
    // Format response
    const formattedAds = selectedAds.map(ad => {
      const creative = ad.creative;
      const isMobile = device === 'mobile';
      
      // Get the appropriate resolution data
      let resolutionData;
      if (isMobile) {
        // On mobile, only use mobile creative if it exists
        if (creative.mobile) {
          resolutionData = creative.mobile;
        } else {
          return null; // Skip this ad on mobile if no mobile creative
        }
      } else {
        // On desktop, only use desktop creative
        if (creative.desktop) {
          resolutionData = creative.desktop;
        } else {
          return null; // Skip if no desktop creative
        }
      }
      
      // Format images with shared alt text and destination
      const formattedImages = resolutionData.images.map(img => ({
        imageUrl: img.imageUrl,
        altText: resolutionData.altText,
        destinationType: resolutionData.destination?.type || 'external',
        destinationUrl: resolutionData.destination?.url || ''
      }));
      
      return {
        adId: ad.adId,
        businessName: ad.businessId.name,
        images: formattedImages
      };
    }).filter(ad => ad !== null);
    
    // Add cache control headers to prevent caching
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });
    
    
    res.json({
      success: true,
      placement: placement.toUpperCase(),
      ads: formattedAds
    });
    
  } catch (error) {
    console.error('Error serving ads:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error serving ads',
      error: error.message 
    });
  }
};


// Track impression
export const trackImpression = async (req, res) => {
  try {
    const { adId } = req.params;
    const userState = getUserState(req) || 'UNKNOWN';
    const device = req.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'desktop';
    
    // Update ad counter
    const ad = await BannerAd.findOneAndUpdate(
      { adId: adId.toUpperCase() },
      { $inc: { 'counters.impressions': 1 } },
      { new: true }
    );
    
    if (!ad) {
      return res.status(404).json({ 
        success: false, 
        message: 'Ad not found' 
      });
    }
    
    // Update metrics (daily rollup)
    const today = new Date().toISOString().split('T')[0];
    await BannerMetrics.findOneAndUpdate(
      {
        date: today,
        adId: ad.adId,
        businessId: ad.businessId,
        placementId: ad.placements[0], // Primary placement
        state: userState,
        device: device
      },
      {
        $inc: { impressions: 1 }
      },
      {
        upsert: true,
        setDefaultsOnInsert: true
      }
    );
    
    // Check if we need to pause due to caps
    if (ad.caps?.maxImpressions && ad.counters.impressions >= ad.caps.maxImpressions) {
      await BannerAd.updateOne(
        { adId: ad.adId },
        { status: 'paused', $push: { notes: `Auto-paused: Reached impression cap on ${new Date().toISOString()}` } }
      );
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Error tracking impression:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error tracking impression' 
    });
  }
};

// Track click and redirect
export const trackClick = async (req, res) => {
  try {
    const { adId } = req.params;
    const userState = getUserState(req) || 'UNKNOWN';
    const device = req.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'desktop';
    
    // Update ad counter
    const ad = await BannerAd.findOneAndUpdate(
      { adId: adId.toUpperCase() },
      { $inc: { 'counters.clicks': 1 } },
      { new: true }
    );
    
    if (!ad) {
      return res.status(404).json({ 
        success: false, 
        message: 'Ad not found' 
      });
    }
    
    // Update metrics
    const today = new Date().toISOString().split('T')[0];
    await BannerMetrics.findOneAndUpdate(
      {
        date: today,
        adId: ad.adId,
        businessId: ad.businessId,
        placementId: ad.placements[0],
        state: userState,
        device: device
      },
      {
        $inc: { clicks: 1 }
      },
      {
        upsert: true,
        setDefaultsOnInsert: true
      }
    );
    
    // Check if we need to pause due to caps
    if (ad.caps?.maxClicks && ad.counters.clicks >= ad.caps.maxClicks) {
      await BannerAd.updateOne(
        { adId: ad.adId },
        { status: 'paused', $push: { notes: `Auto-paused: Reached click cap on ${new Date().toISOString()}` } }
      );
    }
    
    // Get destination URL from the appropriate resolution
    const creative = ad.creative;
    const isMobile = device === 'mobile';
    
    // Get the appropriate resolution data
    let resolutionData;
    if (isMobile && creative.mobile) {
      resolutionData = creative.mobile;
    } else if (creative.desktop) {
      resolutionData = creative.desktop; // Fallback to desktop
    } else {
      return res.json({ 
        success: true, 
        message: 'Click tracked successfully, but no resolution data found' 
      });
    }
    
    const destinationUrl = resolutionData.destination?.url;
    
    if (!destinationUrl) {
      // No destination URL - just return success for click tracking
      return res.json({ 
        success: true, 
        message: 'Click tracked successfully' 
      });
    }
    
    // Redirect to destination
    res.redirect(destinationUrl);
    
  } catch (error) {
    console.error('Error tracking click:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error tracking click' 
    });
  }
};

// Set user state preference (cookie)
export const setState = async (req, res) => {
  try {
    const { state } = req.body;
    
    // Validate state parameter exists
    if (!state) {
      return res.status(400).json({ 
        success: false, 
        message: 'State parameter is required',
        validStates: AU_STATES.filter(s => s !== 'ALL')
      });
    }
    
    // Validate state is valid
    if (!AU_STATES.includes(state)) {
      return res.status(400).json({ 
        success: false, 
        message: `Invalid state code: ${state}`,
        validStates: AU_STATES.filter(s => s !== 'ALL')
      });
    }
    
    // Set cookie (expires in 1 year)
    res.cookie('userSelectedState', state, {
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    
    res.json({ 
      success: true, 
      message: 'State preference saved',
      state: state 
    });
    
  } catch (error) {
    console.error('Error setting state:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error setting state preference' 
    });
  }
};

// Clear user state selection
export const clearState = async (req, res) => {
  try {
    // Clear the state cookie
    res.clearCookie('userSelectedState', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    
    res.json({ 
      success: true, 
      message: 'State preference cleared successfully' 
    });
    
  } catch (error) {
    console.error('Error clearing state:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error clearing state preference' 
    });
  }
};

// Get current user state preference
export const getState = async (req, res) => {
  try {
    // Get user state using the helper function
    const userState = getUserState(req);
    
    res.json({ 
      success: true, 
      hasState: !!userState,
      state: userState || null,
      isAuthenticated: !!req.user
    });
    
  } catch (error) {
    console.error('Error getting state:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error getting state preference' 
    });
  }
};


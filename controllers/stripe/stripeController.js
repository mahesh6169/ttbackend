// /controllers/stripeController.js

import stripe from '../../config/stripe.js';
import User from '../../models/userModel.js';
import Event from '../../models/eventModel.js';
import { computeStripeAccountStatus } from '../../utils/events/stripeAccountHelpers.js';

// Stripe Connect Onboarding: POST /api/stripe/onboard
export const startOnboarding = async (req, res) => {
 try {
   const userId = req.user._id;
   const { returnTo } = req.body; // 👈 Get returnTo from request body

   console.log('🎯 ==========================================');
   console.log(`🚀 STRIPE ONBOARDING START`);
   console.log(`👤 User ID: ${userId}`);
   console.log(`🔙 Return URL: ${returnTo || 'None'}`);
   console.log('==========================================');

   // Find user
   let user = await User.findById(userId);
   if (!user) return res.status(404).json({ error: 'User not found' });

   let accountId = user.stripeAccountId;

   // Create Stripe account if not exists
   if (!accountId) {
     console.log('📝 Creating new Stripe Connect account...');
     const account = await stripe.accounts.create({
       type: 'standard',                   
       country: 'AU',
       email: user.email,
       capabilities: { 
         transfers: { requested: true },
         card_payments: { requested: true }
       },
     });

     accountId = account.id;
     
     console.log('✨ NEW STRIPE ACCOUNT CREATED');
     console.log(`📌 Account ID: ${accountId}`);
     console.log(`📧 Email: ${user.email}`);
     console.log(`🌏 Country: AU`);
     console.log('🎯 Initial Requirements:');
     console.log(`  - Currently Due: ${account.requirements?.currently_due?.length || 0} items`);
     console.log(`  - Eventually Due: ${account.requirements?.eventually_due?.length || 0} items`);
     if (account.requirements?.currently_due?.length > 0) {
       console.log('📋 Currently Due Fields:');
       account.requirements.currently_due.forEach((req, i) => {
         console.log(`    ${i + 1}. ${req}`);
       });
     }
     
     // Update user with new account ID and compute status
     const updateData = {
       stripeAccountId: accountId,
       stripeChargesEnabled: account.charges_enabled || false,
       stripePayoutsEnabled: account.payouts_enabled || false,
       stripeDetailsSubmitted: account.details_submitted || false,
       stripeRequirementsCurrentlyDue: account.requirements?.currently_due || [],
       stripeRequirementsPastDue: account.requirements?.past_due || [],
       stripeRequirementsPendingVerification: account.requirements?.pending_verification || []
     };
     
     updateData.stripeAccountStatus = computeStripeAccountStatus({
       stripeAccountId: accountId,
       ...updateData
     });
     
     user = await User.findByIdAndUpdate(userId, updateData, { new: true });
     console.log(`✅ Created new Stripe account: ${accountId}`);
   }

   // ✅ CHECK ACCOUNT STATUS BEFORE CREATING LINKS
   let account;
   try {
     account = await stripe.accounts.retrieve(accountId);
   } catch (err) {
     // The stored account is no longer accessible (deleted, or removed/disconnected
     // so the platform key lost access). Stripe reports this as 'account_invalid' or
     // 'more_permissions_required'. Either way: drop the stale id and create a fresh account.
     if (err.code === 'account_invalid' || err.code === 'more_permissions_required') {
       console.log(`⚠️ Stored Stripe account ${accountId} is no longer accessible (${err.code}). Creating a fresh account...`);

       const freshAccount = await stripe.accounts.create({
         type: 'standard',
         country: 'AU',
         email: user.email,
         capabilities: {
           transfers: { requested: true },
           card_payments: { requested: true }
         },
       });

       accountId = freshAccount.id;

       const updateData = {
         stripeAccountId: accountId,
         stripeChargesEnabled: freshAccount.charges_enabled || false,
         stripePayoutsEnabled: freshAccount.payouts_enabled || false,
         stripeDetailsSubmitted: freshAccount.details_submitted || false,
         stripeRequirementsCurrentlyDue: freshAccount.requirements?.currently_due || [],
         stripeRequirementsPastDue: freshAccount.requirements?.past_due || [],
         stripeRequirementsPendingVerification: freshAccount.requirements?.pending_verification || []
       };
       updateData.stripeAccountStatus = computeStripeAccountStatus({
         stripeAccountId: accountId,
         ...updateData
       });

       user = await User.findByIdAndUpdate(userId, updateData, { new: true });
       account = freshAccount;
       console.log(`✅ Replaced stale account with new Stripe account: ${accountId}`);
     } else {
       throw err;
     }
   }

   // If account is already fully set up, don't create onboarding links
   if (account.details_submitted && account.charges_enabled && account.payouts_enabled) {
     console.log(`✅ Account ${accountId} is already fully set up`);
     
     // Update user with latest account data
     const updateData = {
       stripeChargesEnabled: account.charges_enabled,
       stripePayoutsEnabled: account.payouts_enabled,
       stripeDetailsSubmitted: account.details_submitted,
       stripeRequirementsCurrentlyDue: account.requirements?.currently_due || [],
       stripeRequirementsPastDue: account.requirements?.past_due || [],
       stripeRequirementsPendingVerification: account.requirements?.pending_verification || []
     };
     
     updateData.stripeAccountStatus = computeStripeAccountStatus({
       stripeAccountId: user.stripeAccountId,
       ...updateData
     });
     
     await User.findByIdAndUpdate(userId, updateData);
     
     return res.json({ 
       message: 'Account already set up',
       accountId,
       status: 'complete',
       charges_enabled: account.charges_enabled,
       payouts_enabled: account.payouts_enabled,
       details_submitted: account.details_submitted,
       returnTo // 👈 Include returnTo in response
     });
   }

   // ✅ CONSTRUCT SUCCESS URL WITH RETURN PARAMETER
   const origin = process.env.STRIPE_REDIRECT_URL || 'http://localhost:3000';
   
   // If returnTo is provided, use it directly as the success URL
   // Otherwise, default to stripeSetup page
   let successUrl;
   let refreshUrl;
   
   if (returnTo) {
     successUrl = `${origin}${returnTo}`;
     refreshUrl = `${origin}${returnTo}`;
   } else {
     const path = '/users/profile/stripeSetup';
     successUrl = `${origin}${path}?success=true`;
     refreshUrl = `${origin}${path}?refresh=true`;
   }

   // ✅ CREATE ONBOARDING LINK
   const accountLink = await stripe.accountLinks.create({
     account: accountId,
     refresh_url: refreshUrl,
     return_url: successUrl, // 👈 Now includes returnTo parameter
     type: 'account_onboarding',
   });

   console.log(`✅ Created onboarding link for account: ${accountId}`);
   console.log(`📍 Success URL: ${successUrl}`);
   
   res.json({ 
     url: accountLink.url,
     accountId,
     status: 'onboarding_required',
     returnTo, // 👈 Include returnTo in response
     success_url: successUrl // 👈 Optional: include for debugging
   });

 } catch (err) {
   console.error('❌ Stripe onboarding error:', err);
   res.status(500).json({ 
     error: 'Stripe onboarding failed.',
     details: process.env.NODE_ENV === 'development' ? err.message : undefined
   });
 }
};
// ✅ ADD ACCOUNT STATUS CHECK ENDPOINT
export const getAccountStatus = async (req, res) => {
  console.log('🔍 ==========================================');
  console.log('🔍 GET ACCOUNT STATUS');
  console.log(`👤 User: ${req.user._id}`);
  console.log('==========================================');
  
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    
    if (!user?.stripeAccountId) {
      console.log('❌ No Stripe account found for user');
      return res.json({ 
        hasAccount: false,
        message: 'No Stripe account found',
        computedStatus: 'no_account'
      });
    }
    
    console.log(`💳 Found Stripe Account: ${user.stripeAccountId}`);

    // Get fresh data from Stripe
    let account;
    try {
      account = await stripe.accounts.retrieve(user.stripeAccountId);
      //console.log("📦 Full Stripe Account Object:", JSON.stringify(account, null, 2));
    } catch (err) {
       console.log('🔍 Stripe error code:', err.code);
      // Both codes mean the stored account is no longer accessible to our platform
      // (deleted, or removed/disconnected so the platform key lost access). Treat the
      // same: clear the stale id so the user starts fresh.
      if (err.code === 'account_invalid' || err.code === 'more_permissions_required') {
        console.log('⚠️ Stripe account was deleted or access revoked. Cleaning up...');
        
        // Clean up with new schema fields
        const cleanupData = {
          stripeAccountId: null,
          stripeAccountStatus: 'no_account',
          stripeChargesEnabled: false,
          stripePayoutsEnabled: false,
          stripeDetailsSubmitted: false,
          stripeRequirementsCurrentlyDue: [],
          stripeRequirementsPastDue: [],
          stripeRequirementsPendingVerification: []
        };
        
        await User.findByIdAndUpdate(userId, cleanupData);

        return res.status(200).json({
          hasAccount: false,
          message: 'Stripe account is no longer valid.',
          computedStatus: 'no_account'
        });
      }
      console.error('Unexpected error in getAccountStatus:', err);
      return res.status(500).json({ message: 'Internal error checking Stripe status' });
    }
    
    // Prepare update data
    const updateData = {
      stripeChargesEnabled: account.charges_enabled,
      stripePayoutsEnabled: account.payouts_enabled,
      stripeDetailsSubmitted: account.details_submitted,
      stripeRequirementsCurrentlyDue: account.requirements?.currently_due || [],
      stripeRequirementsPastDue: account.requirements?.past_due || [],
      stripeRequirementsPendingVerification: account.requirements?.pending_verification || []
    };

    // Compute and add status
    updateData.stripeAccountStatus = computeStripeAccountStatus({
      stripeAccountId: user.stripeAccountId,
      ...updateData
    });

    // Update local database with fresh data
    await User.findByIdAndUpdate(userId, updateData);

    // 🔍 DETAILED LOGGING FOR AUSTRALIAN REQUIREMENTS
    console.log('🇦🇺 === AUSTRALIAN STRIPE ACCOUNT REQUIREMENTS ===');
    console.log('Account ID:', user.stripeAccountId);
    console.log('Status:', updateData.stripeAccountStatus);
    
    // Log all requirement arrays
    console.log('\n📋 Currently Due (must complete now):');
    if (account.requirements?.currently_due?.length > 0) {
      account.requirements.currently_due.forEach((req, i) => {
        console.log(`  ${i + 1}. ${req}`);
      });
    } else {
      console.log('  None');
    }
    
    console.log('\n⏳ Pending Verification (submitted, under review):');
    if (account.requirements?.pending_verification?.length > 0) {
      account.requirements.pending_verification.forEach((req, i) => {
        console.log(`  ${i + 1}. ${req}`);
        
        // Check for Australian-specific fields
        if (req.includes('company.tax_id')) {
          console.log('     → ABN (Australian Business Number) verification pending');
        }
        if (req.includes('external_account') || req.includes('bank_account')) {
          console.log('     → Bank account (BSB/Account) verification pending');
        }
        if (req.includes('individual.id_number') || 
            req.includes('individual.verification.document') ||
            (req.includes('person_') && req.includes('.verification.document'))) {
          console.log('     → Identity document (Driver License/Passport) verification pending');
          // Extract person ID for additional context
          const personMatch = req.match(/person_([a-zA-Z0-9]+)\./);
          if (personMatch) {
            console.log(`     → For person ID: ${personMatch[1]}`);
          }
        }
      });
    } else {
      console.log('  None');
    }
    
    console.log('\n🚨 Past Due (overdue requirements):');
    if (account.requirements?.past_due?.length > 0) {
      account.requirements.past_due.forEach((req, i) => {
        console.log(`  ${i + 1}. ${req}`);
      });
    } else {
      console.log('  None');
    }
    
    console.log('\n📊 Requirement Summary:');
    console.log(`  - Currently Due: ${account.requirements?.currently_due?.length || 0} items`);
    console.log(`  - Pending Verification: ${account.requirements?.pending_verification?.length || 0} items`);
    console.log(`  - Past Due: ${account.requirements?.past_due?.length || 0} items`);
    console.log('=====================================\n');

    // 🇦🇺 Check for Australian-specific requirements
    const checkAustralianRequirements = (requirementsList = []) => {
      const results = {
        hasABNPending: false,
        hasBankAccountPending: false,
        hasIdentityDocPending: false,
        hasBusinessInfo: false,
        hasPersonalInfo: false,
        hasTOSAcceptance: false,
        otherRequirements: []
      };
      
      console.log('\n🔍 CATEGORIZING REQUIREMENTS:');
      
      requirementsList.forEach(req => {
        // ABN (Australian Business Number) checks
        if (req.includes('company.tax_id') || req.includes('business_tax_id')) {
          results.hasABNPending = true;
          console.log(`  📊 ABN: ${req}`);
        }
        // Bank account checks
        else if (req.includes('external_account') || req.includes('bank_account')) {
          results.hasBankAccountPending = true;
          console.log(`  🏦 BANK: ${req}`);
        }
        // Identity document checks
        else if (req.includes('individual.id_number') || 
                 req.includes('individual.verification.document') ||
                 req.includes('verification.document') ||
                 req.includes('person_') && req.includes('.verification.document') ||
                 req.includes('representative.verification.document')) {
          results.hasIdentityDocPending = true;
          console.log(`  🆔 ID DOC: ${req}`);
        }
        // Business profile information
        else if (req.includes('business_profile.') || req.includes('business_type')) {
          results.hasBusinessInfo = true;
          console.log(`  🏢 BUSINESS INFO: ${req}`);
        }
        // Personal/Representative information
        else if (req.includes('representative.')) {
          results.hasPersonalInfo = true;
          console.log(`  👤 PERSONAL INFO: ${req}`);
        }
        // Terms of Service
        else if (req.includes('tos_acceptance.')) {
          results.hasTOSAcceptance = true;
          console.log(`  📜 TOS: ${req}`);
        }
        // Collect other requirements
        else {
          results.otherRequirements.push(req);
          console.log(`  ❓ OTHER: ${req}`);
        }
      });
      
      return results;
    };
    
    // Analyze all requirement types
    const pendingAnalysis = checkAustralianRequirements(account.requirements?.pending_verification);
    const currentlyDueAnalysis = checkAustralianRequirements(account.requirements?.currently_due);
    
    const response = {
      hasAccount: true,
      accountId: user.stripeAccountId,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      requirements: {
        ...account.requirements,
        // Add Australian-specific analysis
        australian_requirements: {
          pending: {
            abn: pendingAnalysis.hasABNPending,
            bank_account: pendingAnalysis.hasBankAccountPending,
            identity_document: pendingAnalysis.hasIdentityDocPending,
            other: pendingAnalysis.otherRequirements
          },
          currently_due: {
            abn: currentlyDueAnalysis.hasABNPending,
            bank_account: currentlyDueAnalysis.hasBankAccountPending,
            identity_document: currentlyDueAnalysis.hasIdentityDocPending,
            other: currentlyDueAnalysis.otherRequirements
          }
        }
      },
      computedStatus: updateData.stripeAccountStatus,
      dashboardAccess: account.charges_enabled && account.payouts_enabled 
        ? 'full_stripe_dashboard' 
        : 'setup_required',
      dashboardUrl: account.charges_enabled && account.payouts_enabled 
        ? 'https://dashboard.stripe.com' 
        : null
    };

    console.log('📊 Account status:', {
      accountId: user.stripeAccountId,
      computedStatus: updateData.stripeAccountStatus
    });

    res.json(response);

  } catch (err) {
    console.error('Error checking account status:', err);
    res.status(500).json({ error: 'Failed to check account status' });
  }
};


// Stripe Webhook Handler: POST /api/stripe/webhook
// Handles the following webhook events:
// - account.updated: When account status/capabilities change
// - account.application.deauthorized: When account is deleted/disconnected
export const stripeWebhook = async (req, res) => {
 const sig = req.headers['stripe-signature'];
 let event;

 try {
   event = stripe.webhooks.constructEvent(
     req.body,
     sig,
     process.env.STRIPE_WEBHOOK_SECRET
   );
 } catch (err) {
   console.error('Webhook signature verification failed:', err.message);
   return res.status(400).send(`Webhook Error: ${err.message}`);
 }

 console.log('🔔 ==========================================');
 console.log(`📡 STRIPE WEBHOOK: ${event.type}`);
 console.log(`🆔 Event ID: ${event.id}`);
 console.log(`⏰ Time: ${new Date(event.created * 1000).toISOString()}`);
 console.log(`💳 Account: ${event.data.object.id || 'N/A'}`);
 console.log('==========================================');

 if (event.type === 'account.updated') {
   const account = event.data.object;
   const previousAttributes = event.data.previous_attributes || {};
   
   console.log('📊 ACCOUNT UPDATE DETAILS:');
   console.log('Current State:', {
     charges_enabled: account.charges_enabled,
     payouts_enabled: account.payouts_enabled,
     details_submitted: account.details_submitted,
   });
   
   // Log what changed
   if (Object.keys(previousAttributes).length > 0) {
     console.log('🔄 Changes Detected:');
     Object.entries(previousAttributes).forEach(([key, prevValue]) => {
       console.log(`  - ${key}: ${JSON.stringify(prevValue)} → ${JSON.stringify(account[key])}`);
     });
   }
   
   // Log requirements in detail
   console.log('\n📋 REQUIREMENTS ANALYSIS:');
   console.log('Currently Due:', account.requirements?.currently_due?.length || 0);
   if (account.requirements?.currently_due?.length > 0) {
     account.requirements.currently_due.forEach((req, i) => {
       console.log(`  ${i + 1}. ${req}`);
       // Categorize the requirement
       if (req.includes('tos_acceptance')) {
         console.log('     → Terms of Service acceptance needed');
       } else if (req.includes('business_type')) {
         console.log('     → Business type selection needed');
       } else if (req.includes('business_profile.')) {
         console.log('     → Business profile information needed');
       } else if (req.includes('external_account')) {
         console.log('     → Bank account details needed (BSB & Account)');
       } else if (req.includes('representative.')) {
         console.log('     → Representative/Personal information needed');
       } else if (req.includes('company.name')) {
         console.log('     → Company name needed');
       } else if (req.includes('company.tax_id')) {
         console.log('     → ABN (Australian Business Number) needed');
       } else if (req.includes('individual.first_name') || req.includes('individual.last_name')) {
         console.log('     → Personal name needed');
       } else if (req.includes('individual.dob')) {
         console.log('     → Date of birth needed');
       } else if (req.includes('individual.address')) {
         console.log('     → Personal address needed');
       } else if (req.includes('company.address')) {
         console.log('     → Business address needed');
       } else if (req.includes('individual.verification.document') || req.includes('representative.verification.document')) {
         console.log('     → Identity verification document needed');
       }
     });
   }
   
   console.log('\nPending Verification:', account.requirements?.pending_verification?.length || 0);
   if (account.requirements?.pending_verification?.length > 0) {
     account.requirements.pending_verification.forEach((req, i) => {
       console.log(`  ${i + 1}. ${req}`);
     });
   }
   
   console.log('\nPast Due:', account.requirements?.past_due?.length || 0);
   if (account.requirements?.past_due?.length > 0) {
     account.requirements.past_due.forEach((req, i) => {
       console.log(`  ${i + 1}. ${req}`);
     });
   }
   
   try {
     // Prepare update data
     const updateData = {
       stripeChargesEnabled: account.charges_enabled,
       stripePayoutsEnabled: account.payouts_enabled,
       stripeDetailsSubmitted: account.details_submitted,
       stripeRequirementsCurrentlyDue: account.requirements?.currently_due || [],
       stripeRequirementsPastDue: account.requirements?.past_due || [],
       stripeRequirementsPendingVerification: account.requirements?.pending_verification || []
     };

     // Compute status
     updateData.stripeAccountStatus = computeStripeAccountStatus({
       stripeAccountId: account.id,
       ...updateData
     });

     const updatedUser = await User.findOneAndUpdate(
       { stripeAccountId: account.id },
       updateData,
       { new: true }
     );
     
     if (updatedUser) {
       console.log(`✅ User database updated for account: ${account.id}`);
       
       if (account.charges_enabled && account.payouts_enabled) {
         console.log(`✅ Account is healthy - user can accept payments`);
       } else {
         console.log(`⚠️ Account capabilities insufficient - user cannot accept payments yet`);
       }
     } else {
       console.log(`⚠️ No user found with Stripe account: ${account.id}`);
     }
   } catch (err) {
     console.error('Failed to update user after account.updated', err);
   }
 }

 if (event.type === 'account.application.deauthorized') {
   const account = event.data.object; // The deleted Stripe account object
   const accountId = event.account;   // e.g., acct_1RkjsTP1lnQux3hP

   console.log('🚨 Stripe account deauthorized:', accountId);

   try {
     const updatedUser = await User.findOneAndUpdate(
       { stripeAccountId: accountId },
       {
         stripeAccountId: null,
         stripeAccountStatus: 'no_account',
         stripeChargesEnabled: false,
         stripePayoutsEnabled: false,
         stripeDetailsSubmitted: false,
         stripeRequirementsCurrentlyDue: [],
         stripeRequirementsPastDue: [],
         stripeRequirementsPendingVerification: []
       },
       { new: true }
     );

     if (updatedUser) {
       console.log(`✅ Marked Stripe account as deleted for user: ${updatedUser._id}`);

       // Auto-hide the organizer's live PAID events: with no connected account they can no
       // longer be paid for, so take them off the public listing (goLive → false). Only paid
       // events are affected (free/RSVP/promo don't use Stripe), and only currently-live ones
       // (so we don't touch events the organizer had already taken offline themselves).
       // Hide-only: on re-onboarding the organizer re-lists them via the existing goLive toggle.
       const hidden = await Event.updateMany(
         { postedBy: updatedUser._id, isPaid: true, goLive: true },
         { goLive: false }
       );
       console.log(`🙈 Hid ${hidden.modifiedCount} live paid event(s) for user ${updatedUser._id}`);
     } else {
       console.log(`⚠️ No user found with Stripe account ID: ${accountId}`);
     }
   } catch (err) {
     console.error('❌ Failed to handle Stripe account deauthorization:', err);
   }
 }

 // Handle payment events
 if (event.type === 'payment_intent.succeeded') {
   const paymentIntent = event.data.object;
   console.log('💰 Payment successful!', {
     id: paymentIntent.id,
     amount: paymentIntent.amount / 100, // Convert cents to dollars
     currency: paymentIntent.currency,
     metadata: paymentIntent.metadata
   });
   
   // Log ticket purchase details if available
   if (paymentIntent.metadata.eventId) {
     console.log('🎫 Ticket purchase details:', {
       eventId: paymentIntent.metadata.eventId,
       eventTitle: paymentIntent.metadata.eventTitle,
       ticketCount: paymentIntent.metadata.ticketCount,
       buyerEmail: paymentIntent.metadata.buyerEmail,
       organizerAmount: paymentIntent.metadata.organizerAmount,
       platformFee: paymentIntent.metadata.totalPlatformFee
     });
   }
 }

 if (event.type === 'charge.succeeded') {
   const charge = event.data.object;
   console.log('💳 Charge successful!', {
     id: charge.id,
     amount: charge.amount / 100,
     application_fee: charge.application_fee_amount ? charge.application_fee_amount / 100 : 0
   });
 }

 if (event.type === 'payment_intent.created') {
   const paymentIntent = event.data.object;
   console.log('🎯 Payment intent created:', {
     id: paymentIntent.id,
     amount: paymentIntent.amount / 100
   });
 }

 res.json({ received: true });
};

// @desc    Test webhook connectivity
// @route   GET /api/stripe/webhook-test
// @access  Public (for Stripe testing)
export const testWebhook = async (req, res) => {
  console.log('🧪 Webhook test endpoint called');
  res.status(200).json({ 
    success: true, 
    message: 'Webhook endpoint is accessible',
    timestamp: new Date().toISOString()
  });
};

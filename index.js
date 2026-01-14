// server/index.js - Zoom Meeting API Server + Stripe Checkout
const express = require('express');
const cors = require('cors');
const axios = require('axios');

// Initialize Stripe - handle missing key gracefully
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('✅ Stripe initialized');
} else {
  console.warn('⚠️ STRIPE_SECRET_KEY not set - payments will not work');
}

const app = express();
app.use(cors());
app.use(express.json());

// Zoom Server-to-Server OAuth credentials from environment variables
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

// Cache for access token
let accessToken = null;
let tokenExpiry = null;

// Health check endpoint - shows when you visit the URL
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'MeetSync Zoom + Stripe Server',
    endpoints: {
      'POST /api/create-meeting': 'Create a new Zoom meeting',
      'POST /api/create-checkout-session': 'Create Stripe checkout session'
    },
    env: {
      hasAccountId: !!ZOOM_ACCOUNT_ID,
      hasClientId: !!ZOOM_CLIENT_ID,
      hasClientSecret: !!ZOOM_CLIENT_SECRET,
      hasStripeKey: !!process.env.STRIPE_SECRET_KEY
    }
  });
});

// ================== STRIPE ENDPOINTS ==================

// Create Stripe Checkout Session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { productId, planName, currency, amount, successUrl, cancelUrl } = req.body;
    
    console.log('💳 Creating Stripe checkout session');
    console.log('   Plan:', planName);
    console.log('   Product ID:', productId);
    console.log('   Currency:', currency);
    console.log('   Amount:', amount);
    console.log('   Success URL:', successUrl);
    
    if (!stripe) {
      console.error('❌ Stripe not initialized - missing STRIPE_SECRET_KEY');
      return res.status(500).json({
        success: false,
        error: 'Payment system not configured. Please contact support.'
      });
    }
    
    if (!productId) {
      console.error('❌ Missing product ID');
      return res.status(400).json({
        success: false,
        error: 'Missing product ID'
      });
    }
    
    // For multi-currency support, we create a dynamic price
    const sessionConfig = {
      payment_method_types: ['card'],
      mode: 'subscription',
      success_url: successUrl + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl,
      line_items: [
        {
          price_data: {
            currency: currency || 'usd',
            product: productId,
            unit_amount: Math.round((amount || 149) * 100), // Stripe uses cents, ensure integer
            recurring: {
              interval: 'month',
            },
          },
          quantity: 1,
        }
      ],
      metadata: {
        planName: planName,
        productId: productId,
        currency: currency,
        amount: String(amount)
      }
    };
    
    console.log('📦 Session config:', JSON.stringify(sessionConfig, null, 2));
    
    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    console.log('✅ Checkout session created:', session.id);
    console.log('   URL:', session.url);
    
    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });
  } catch (error) {
    console.error('❌ Failed to create checkout session');
    console.error('   Error type:', error.type);
    console.error('   Error message:', error.message);
    console.error('   Error code:', error.code);
    console.error('   Full error:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create checkout session'
    });
  }
});

// Stripe webhook to handle successful payments
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('✅ Payment successful for session:', session.id);
      console.log('   Customer email:', session.customer_details?.email);
      console.log('   Plan:', session.metadata?.planName);
      // Here you could update your database, send confirmation email, etc.
      break;
    case 'customer.subscription.created':
      console.log('✅ Subscription created:', event.data.object.id);
      break;
    case 'customer.subscription.deleted':
      console.log('⚠️ Subscription cancelled:', event.data.object.id);
      break;
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }
  
  res.json({ received: true });
});

// Create Stripe Customer Portal Session (for billing management)
app.post('/api/create-portal-session', async (req, res) => {
  try {
    const { email, returnUrl } = req.body;
    
    console.log('🔧 Creating billing portal session for email:', email);
    
    if (!stripe) {
      return res.status(500).json({
        success: false,
        error: 'Payment system not configured.'
      });
    }
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email not provided.'
      });
    }
    
    // Find customer by email
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });
    
    if (customers.data.length === 0) {
      console.log('❌ No customer found for email:', email);
      return res.status(404).json({
        success: false,
        error: 'No billing account found. If you recently subscribed, please try again in a few minutes.'
      });
    }
    
    const customerId = customers.data[0].id;
    console.log('✅ Found customer:', customerId);
    
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || 'https://meetsync.app',
    });
    
    console.log('✅ Portal session created:', portalSession.id);
    
    res.json({
      success: true,
      url: portalSession.url
    });
  } catch (error) {
    console.error('❌ Failed to create portal session:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Send welcome email (placeholder - integrate with your email service)
app.post('/api/send-welcome-email', async (req, res) => {
  try {
    const { sessionId, plan } = req.body;
    
    console.log('📧 Sending welcome email for session:', sessionId, 'plan:', plan);
    
    // If you have Stripe session ID, you can retrieve customer details
    if (sessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const customerEmail = session.customer_details?.email;
        
        console.log('   Customer email:', customerEmail);
        
        // TODO: Integrate with email service (SendGrid, Resend, etc.)
        // Example with SendGrid:
        // await sgMail.send({
        //   to: customerEmail,
        //   from: 'welcome@meetsync.app',
        //   subject: 'Welcome to MeetSync! 🎉',
        //   templateId: 'd-xxxxx',
        //   dynamicTemplateData: { plan, ... }
        // });
        
        console.log('✅ Welcome email queued for:', customerEmail);
      } catch (e) {
        console.log('Could not retrieve session:', e.message);
      }
    }
    
    res.json({ success: true, message: 'Welcome email queued' });
  } catch (error) {
    console.error('❌ Failed to send welcome email:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================== ZOOM ENDPOINTS ==================

// Get Zoom access token
async function getZoomAccessToken() {
  // Return cached token if still valid
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log('📦 Using cached token');
    return accessToken;
  }

  try {
    console.log('🔄 Requesting new Zoom access token...');
    console.log('   Account ID:', ZOOM_ACCOUNT_ID ? '✓ Set' : '✗ Missing');
    console.log('   Client ID:', ZOOM_CLIENT_ID ? '✓ Set' : '✗ Missing');
    
    if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
      throw new Error('Missing Zoom credentials. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, and ZOOM_CLIENT_SECRET environment variables.');
    }
    
    const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post(
      'https://zoom.us/oauth/token',
      `grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    accessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;
    
    console.log('✅ Zoom access token obtained successfully');
    console.log('   Token starts with:', accessToken.substring(0, 20) + '...');
    console.log('   Expires in:', response.data.expires_in, 'seconds');
    
    return accessToken;
  } catch (error) {
    console.error('❌ Failed to get Zoom access token:');
    console.error('   Status:', error.response?.status);
    console.error('   Error:', JSON.stringify(error.response?.data, null, 2));
    throw new Error('Failed to authenticate with Zoom');
  }
}

// Test endpoint to check token
app.get('/api/test-token', async (req, res) => {
  try {
    const token = await getZoomAccessToken();
    res.json({ 
      success: true, 
      message: 'Token obtained successfully',
      tokenPreview: token.substring(0, 20) + '...'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Create a Zoom meeting
app.post('/api/create-meeting', async (req, res) => {
  try {
    const { topic, startTime, duration } = req.body;

    console.log('📅 Creating meeting:', topic);
    
    const token = await getZoomAccessToken();

    const meetingData = {
      topic: topic || 'MeetSync Call',
      type: 1, // Instant meeting (changed from 2)
      duration: duration || 60,
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: true,
        waiting_room: false,
        mute_upon_entry: false
      }
    };

    console.log('📤 Sending request to Zoom API...');
    
    const response = await axios.post(
      'https://api.zoom.us/v2/users/me/meetings',
      meetingData,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Zoom meeting created:', response.data.id);
    console.log('   Join URL:', response.data.join_url);

    res.json({
      success: true,
      meeting: {
        id: response.data.id,
        joinUrl: response.data.join_url,
        startUrl: response.data.start_url,
        password: response.data.password,
        topic: response.data.topic
      }
    });
  } catch (error) {
    console.error('❌ Failed to create meeting:');
    console.error('   Status:', error.response?.status);
    console.error('   Error:', JSON.stringify(error.response?.data, null, 2));
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || 'Failed to create Zoom meeting'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'MeetSync Zoom Server' });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Zoom server running on port ${PORT}`);
  console.log(`📍 Test token: GET http://localhost:${PORT}/api/test-token`);
  console.log(`📍 Create meeting: POST http://localhost:${PORT}/api/create-meeting`);
});

// server/index.js - Zoom Meeting API Server + Stripe Checkout
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// Zoom Server-to-Server OAuth credentials from environment variables
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

// Stripe Product to Price mapping (you'll need to set these in environment)
const STRIPE_PRICE_IDS = {
  'prod_Tme6IhePuUyZuY': process.env.STRIPE_STARTER_PRICE_ID, // Starter plan
  'prod_Tme7M5TaXqaRnt': process.env.STRIPE_PRO_PRICE_ID,     // Pro plan
};

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
    const { productId, planName, successUrl, cancelUrl } = req.body;
    
    console.log('💳 Creating Stripe checkout session for:', planName);
    
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('Stripe secret key not configured');
    }
    
    // Get the price ID for this product
    const priceId = STRIPE_PRICE_IDS[productId];
    
    if (!priceId) {
      // If no price ID mapping, create a checkout with the product directly
      // This requires the product to have a default price set in Stripe
      console.log('   Using product ID directly:', productId);
    }
    
    const sessionConfig = {
      payment_method_types: ['card'],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: priceId ? [
        {
          price: priceId,
          quantity: 1,
        }
      ] : undefined,
      metadata: {
        planName: planName,
        productId: productId
      }
    };
    
    // If we don't have a price ID, we need to use price_data
    if (!priceId) {
      // Fallback: lookup the product's default price
      const product = await stripe.products.retrieve(productId);
      if (product.default_price) {
        sessionConfig.line_items = [{
          price: product.default_price,
          quantity: 1,
        }];
      } else {
        throw new Error('Product has no default price configured');
      }
    }
    
    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    console.log('✅ Checkout session created:', session.id);
    
    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });
  } catch (error) {
    console.error('❌ Failed to create checkout session:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
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

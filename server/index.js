// server/index.js - Zoom Meeting API Server
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Zoom Server-to-Server OAuth credentials
const ZOOM_ACCOUNT_ID = 'SgacDn8QR_eTX3D3tiULlg';
const ZOOM_CLIENT_ID = 'IFRbuf8KQ9eqw3wkOUOlIg';
const ZOOM_CLIENT_SECRET = 'POItSX0Ca4MIMMEHMAMpfF2lPlHnoc4x';
const ZOOM_SECRET_TOKEN = 'QYAokF8bRJijsqDAvLJBwQ';

// Cache for access token
let accessToken = null;
let tokenExpiry = null;

// Get Zoom access token
async function getZoomAccessToken() {
  // Return cached token if still valid
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log('📦 Using cached token');
    return accessToken;
  }

  try {
    console.log('🔄 Requesting new Zoom access token...');
    console.log('   Account ID:', ZOOM_ACCOUNT_ID);
    console.log('   Client ID:', ZOOM_CLIENT_ID);
    
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

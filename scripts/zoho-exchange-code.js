#!/usr/bin/env node

/**
 * Zoho Authorization Code Exchange Script
 * Exchanges authorization code for access and refresh tokens
 */

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const querystring = require('querystring');

const CONFIG = {
  CLIENT_ID: "1000.HRFLWOF4DAFL4SK4IZ3UKXCI6CRQJV",
  CLIENT_SECRET: "55898a4588dd60641f5bf5a00575cca7f82e580989",
  AUTHORIZATION_CODE: "1000.3cd6d71078008e6f4b3563bd0d8f6c01.88ed56be3ddb1ff1fc76449a68f4af5f",
  REDIRECT_URI: "https://xyne.juspay.net/callback", // Must match what was used in auth URL
  ACCOUNTS_URL: "https://accounts.zoho.com" // Try .com first, then .eu if needed
};

async function exchangeCodeForTokens() {
  console.log('🔄 Exchanging authorization code for tokens...');
  console.log('=====================================');
  console.log('Client ID:', CONFIG.CLIENT_ID);
  console.log('Code:', CONFIG.AUTHORIZATION_CODE.substring(0, 20) + '...');
  console.log('Redirect URI:', CONFIG.REDIRECT_URI);
  console.log('=====================================\n');
  
  const tokenData = {
    grant_type: 'authorization_code',
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET,
    redirect_uri: CONFIG.REDIRECT_URI,
    code: CONFIG.AUTHORIZATION_CODE
  };

  try {
    const response = await fetch(`${CONFIG.ACCOUNTS_URL}/oauth/v2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: querystring.stringify(tokenData)
    });

    const responseText = await response.text();
    console.log('📥 Raw Response:');
    console.log('Status:', response.status, response.statusText);
    console.log('Body:', responseText);
    console.log();

    try {
      const data = JSON.parse(responseText);
      
      if (!response.ok || data.error) {
        console.error('❌ Token exchange failed:');
        console.error('Error:', data.error);
        console.error('Description:', data.error_description);
        
        // Provide specific troubleshooting
        if (data.error === 'invalid_code') {
          console.log('\n🔧 Troubleshooting:');
          console.log('- Authorization code may have expired (codes expire in ~10 minutes)');
          console.log('- Code may have already been used (codes are single-use)');
          console.log('- Generate a new authorization code from the OAuth URL');
        } else if (data.error === 'invalid_client') {
          console.log('\n🔧 Troubleshooting:');
          console.log('- Check CLIENT_ID and CLIENT_SECRET are correct');
          console.log('- Verify redirect URI matches exactly');
        } else if (data.error === 'invalid_request') {
          console.log('\n🔧 Troubleshooting:');
          console.log('- Check redirect URI matches the one used in authorization');
          console.log('- Verify all required parameters are present');
        }
        
        return null;
      }

      console.log('✅ Token exchange successful!');
      console.log('\n🎉 Your Tokens:');
      console.log('=====================================');
      console.log('ACCESS TOKEN:');
      console.log(data.access_token);
      console.log('\nREFRESH TOKEN:');
      console.log(data.refresh_token || 'Not provided');
      console.log('\nTOKEN TYPE:', data.token_type || 'Bearer');
      console.log('EXPIRES IN:', data.expires_in || 3600, 'seconds');
      console.log('SCOPE:', data.scope || 'Not specified');
      console.log('=====================================\n');

      // Save tokens to file
      const fs = require('fs');
      const path = require('path');
      
      const tokenFile = path.join(__dirname, 'zoho-tokens.json');
      const tokenData = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_type: data.token_type || 'Bearer',
        expires_in: data.expires_in || 3600,
        scope: data.scope,
        generated_at: new Date().toISOString(),
        data_center: 'com'
      };
      
      try {
        fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));
        console.log(`✅ Tokens saved to: ${tokenFile}`);
      } catch (saveError) {
        console.log('⚠️ Could not save tokens to file:', saveError.message);
      }

      // Test the access token
      if (data.access_token) {
        await testAccessToken(data.access_token);
      }
      
      return data;
      
    } catch (parseError) {
      console.error('❌ Failed to parse response as JSON');
      console.error('Parse error:', parseError.message);
      console.error('Raw response:', responseText);
      return null;
    }
    
  } catch (error) {
    console.error('❌ Network error:', error.message);
    return null;
  }
}

async function testAccessToken(accessToken) {
  console.log('\n🧪 Testing access token...');
  
  try {
    // Test with Zoho Desk API
    const response = await fetch('https://www.zohoapis.com/desk/v1/organizations', {
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    
    if (response.ok) {
      console.log('✅ Access token is valid!');
      console.log('📊 API Test Result:');
      if (data.data && data.data.length > 0) {
        console.log(`Organizations found: ${data.data.length}`);
        data.data.forEach((org, index) => {
          console.log(`${index + 1}. ${org.companyName} (ID: ${org.id})`);
        });
      } else {
        console.log('No organizations found or different response structure');
      }
    } else {
      console.log('⚠️ Access token validation failed:');
      console.log('Status:', response.status);
      console.log('Error:', data.message || data.errorCode || 'Unknown error');
      console.log('Response:', JSON.stringify(data, null, 2));
    }
    
  } catch (error) {
    console.log('⚠️ Error testing access token:', error.message);
  }
}

// Run the exchange
exchangeCodeForTokens()
  .then(tokens => {
    if (tokens) {
      console.log('\n🎉 Success! You now have valid Zoho tokens.');
      console.log('\n📝 Next Steps:');
      console.log('1. Use the ACCESS TOKEN for immediate API calls');
      console.log('2. Store the REFRESH TOKEN securely for token renewal');
      console.log('3. Implement token refresh logic in your application');
      
      if (tokens.refresh_token) {
        console.log('\n🔄 To refresh tokens later, use:');
        console.log(`node scripts/zoho-refresh-token.js`);
      }
    } else {
      console.log('\n❌ Token exchange failed. Please check the errors above.');
      console.log('\n💡 You may need to:');
      console.log('1. Generate a new authorization code (they expire quickly)');
      console.log('2. Verify your client credentials');
      console.log('3. Check the redirect URI matches exactly');
    }
  })
  .catch(error => {
    console.error('💥 Unexpected error:', error.message);
    process.exit(1);
  });
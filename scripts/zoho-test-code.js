#!/usr/bin/env node

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const querystring = require('querystring');

const CONFIG = {
  CLIENT_ID: "1000.HRFLWOF4DAFL4SK4IZ3UKXCI6CRQJV",
  CLIENT_SECRET: "55898a4588dd60641f5bf5a00575cca7f82e580989",
  AUTHORIZATION_CODE: "1000.9bf64aa8dab169fea916983e74173ecb.93e61c4184c42d55ae841bb4190934c9",
  ACCOUNTS_URL: "https://accounts.zoho.com"
};

// Try different redirect URIs that might have been used
const REDIRECT_URIS = [
  "https://xyne.juspay.net/callback",
  "http://localhost:3000/callback",
  "https://www.zoho.com/crm/help/api/self-client.html",
  "https://oauth.pstmn.io/v1/callback"
];

async function testCodeWithDifferentRedirectURIs() {
  console.log('🔄 Testing authorization code with different redirect URIs...\n');
  
  for (const redirectUri of REDIRECT_URIS) {
    console.log(`📡 Trying redirect URI: ${redirectUri}`);
    
    const tokenData = {
      grant_type: 'authorization_code',
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      redirect_uri: redirectUri,
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
      
      try {
        const data = JSON.parse(responseText);
        
        if (data.error) {
          console.log(`❌ ${data.error}: ${data.error_description || 'No description'}`);
        } else {
          console.log('✅ SUCCESS! Tokens generated:');
          console.log('=====================================');
          console.log('ACCESS TOKEN:', data.access_token);
          console.log('REFRESH TOKEN:', data.refresh_token || 'Not provided');
          console.log('TOKEN TYPE:', data.token_type || 'Bearer');
          console.log('EXPIRES IN:', data.expires_in || 3600, 'seconds');
          console.log('SCOPE:', data.scope || 'Not specified');
          console.log('=====================================');
          
          // Save tokens
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
            redirect_uri: redirectUri
          };
          
          fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));
          console.log(`💾 Tokens saved to: ${tokenFile}\n`);
          return data;
        }
        
      } catch (parseError) {
        console.log(`❌ Invalid JSON response: ${responseText.substring(0, 100)}`);
      }
      
    } catch (error) {
      console.log(`❌ Network error: ${error.message}`);
    }
    
    console.log(); // Empty line between attempts
  }
  
  return null;
}

testCodeWithDifferentRedirectURIs()
  .then(result => {
    if (!result) {
      console.log('❌ All redirect URIs failed. The authorization code is likely expired or already used.');
      console.log('\n💡 To get a fresh authorization code, visit:');
      console.log(`https://accounts.zoho.com/oauth/v2/auth?scope=Desk.tickets.READ&client_id=${CONFIG.CLIENT_ID}&response_type=code&redirect_uri=https://xyne.juspay.net/callback&access_type=offline`);
    }
  })
  .catch(console.error);
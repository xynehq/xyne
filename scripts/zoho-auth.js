#!/usr/bin/env node

/**
 * Zoho OAuth 2.0 Authentication Script
 * 
 * This script helps generate OAuth tokens for Zoho Books API access.
 * It implements the OAuth 2.0 authorization code flow for Zoho.
 */

const express = require('express');
const querystring = require('querystring');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  // These will be provided via environment variables or command line
  CLIENT_ID: process.env.ZOHO_CLIENT_ID || "1000.HRFLWOF4DAFL4SK4IZ3UKXCI6CRQJV",
  CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET || "55898a4588dd60641f5bf5a00575cca7f82e580989",
  REDIRECT_URI: process.env.ZOHO_REDIRECT_URI || 'http://localhost:3000/callback',
  SCOPE: 'Desk.tickets.READ',
  // Zoho data center - can be .com, .eu, .in, .com.au, .jp
  DATA_CENTER: process.env.ZOHO_DATA_CENTER || 'com',
  PORT: process.env.PORT || 3000
};

// Zoho OAuth endpoints based on data center
const ZOHO_ENDPOINTS = {
  authorize: `https://accounts.zoho.${CONFIG.DATA_CENTER}/oauth/v2/auth`,
  token: `https://accounts.zoho.${CONFIG.DATA_CENTER}/oauth/v2/token`,
  refresh: `https://accounts.zoho.${CONFIG.DATA_CENTER}/oauth/v2/token`
};

class ZohoAuthenticator {
  constructor() {
    this.app = express();
    this.authCode = null;
    this.tokens = null;
  }

  validateConfig() {
    const required = ['CLIENT_ID', 'CLIENT_SECRET'];
    const missing = required.filter(key => !CONFIG[key]);
    
    if (missing.length > 0) {
      console.error('❌ Missing required configuration:');
      missing.forEach(key => console.error(`  - ${key}`));
      console.error('\nPlease set the environment variables or use command line arguments.');
      return false;
    }
    return true;
  }

  generateAuthUrl() {
    const params = {
      response_type: 'code',
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPE,
      redirect_uri: CONFIG.REDIRECT_URI,
      access_type: 'offline',
      prompt: 'consent'
    };

    return `${ZOHO_ENDPOINTS.authorize}?${querystring.stringify(params)}`;
  }

  async exchangeCodeForTokens(code) {
    const tokenData = {
      grant_type: 'authorization_code',
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      redirect_uri: CONFIG.REDIRECT_URI,
      code: code
    };

    try {
      const response = await fetch(ZOHO_ENDPOINTS.token, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: querystring.stringify(tokenData)
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(`Token exchange failed: ${data.error_description || data.error}`);
      }

      return data;
    } catch (error) {
      console.error('❌ Error exchanging code for tokens:', error.message);
      throw error;
    }
  }

  async refreshAccessToken(refreshToken) {
    const tokenData = {
      grant_type: 'refresh_token',
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      refresh_token: refreshToken
    };

    try {
      const response = await fetch(ZOHO_ENDPOINTS.refresh, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: querystring.stringify(tokenData)
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
      }

      return data;
    } catch (error) {
      console.error('❌ Error refreshing token:', error.message);
      throw error;
    }
  }

  saveTokens(tokens) {
    const tokenFile = path.join(__dirname, 'zoho-tokens.json');
    const tokenData = {
      ...tokens,
      generated_at: new Date().toISOString(),
      data_center: CONFIG.DATA_CENTER
    };

    try {
      fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));
      console.log(`✅ Tokens saved to: ${tokenFile}`);
      return tokenFile;
    } catch (error) {
      console.error('❌ Error saving tokens:', error.message);
      throw error;
    }
  }

  loadTokens() {
    const tokenFile = path.join(__dirname, 'zoho-tokens.json');
    try {
      if (fs.existsSync(tokenFile)) {
        const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
        return data;
      }
    } catch (error) {
      console.error('❌ Error loading tokens:', error.message);
    }
    return null;
  }

  async testTokens(accessToken) {
    const testUrl = `https://www.zohoapis.${CONFIG.DATA_CENTER}/books/v3/organizations`;
    
    try {
      const response = await fetch(testUrl, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      
      if (response.ok) {
        console.log('✅ Token validation successful!');
        console.log(`📊 Organizations found: ${data.organizations?.length || 0}`);
        return true;
      } else {
        console.error('❌ Token validation failed:', data.message || 'Unknown error');
        return false;
      }
    } catch (error) {
      console.error('❌ Error testing tokens:', error.message);
      return false;
    }
  }

  setupRoutes() {
    this.app.get('/', (req, res) => {
      const authUrl = this.generateAuthUrl();
      res.send(`
        <html>
          <head><title>Zoho OAuth Authorization</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h1>🔐 Zoho Books OAuth Authorization</h1>
            <p>Click the button below to authorize this application to access your Zoho Books data:</p>
            <div style="margin: 20px 0;">
              <a href="${authUrl}" style="display: inline-block; background: #1877f2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                🚀 Authorize with Zoho
              </a>
            </div>
            <hr>
            <h3>📋 Configuration Details:</h3>
            <ul>
              <li><strong>Client ID:</strong> ${CONFIG.CLIENT_ID}</li>
              <li><strong>Redirect URI:</strong> ${CONFIG.REDIRECT_URI}</li>
              <li><strong>Scope:</strong> ${CONFIG.SCOPE}</li>
              <li><strong>Data Center:</strong> .${CONFIG.DATA_CENTER}</li>
            </ul>
          </body>
        </html>
      `);
    });

    this.app.get('/callback', async (req, res) => {
      const { code, error } = req.query;

      if (error) {
        res.send(`
          <html>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h1>❌ Authorization Failed</h1>
              <p><strong>Error:</strong> ${error}</p>
              <p><strong>Description:</strong> ${req.query.error_description || 'No description provided'}</p>
            </body>
          </html>
        `);
        return;
      }

      if (!code) {
        res.send(`
          <html>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h1>❌ No Authorization Code</h1>
              <p>No authorization code was received. Please try again.</p>
            </body>
          </html>
        `);
        return;
      }

      try {
        console.log('🔄 Exchanging authorization code for tokens...');
        const tokens = await this.exchangeCodeForTokens(code);
        
        console.log('✅ Tokens received successfully!');
        this.tokens = tokens;
        
        // Save tokens to file
        const tokenFile = this.saveTokens(tokens);
        
        // Test the tokens
        const isValid = await this.testTokens(tokens.access_token);
        
        res.send(`
          <html>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h1>✅ Authorization Successful!</h1>
              <p>Your Zoho Books access tokens have been generated and saved.</p>
              
              <h3>📄 Token Details:</h3>
              <ul>
                <li><strong>Access Token:</strong> ${tokens.access_token.substring(0, 20)}...</li>
                <li><strong>Refresh Token:</strong> ${tokens.refresh_token ? tokens.refresh_token.substring(0, 20) + '...' : 'Not provided'}</li>
                <li><strong>Expires In:</strong> ${tokens.expires_in} seconds</li>
                <li><strong>Token Type:</strong> ${tokens.token_type}</li>
                <li><strong>Scope:</strong> ${tokens.scope}</li>
              </ul>
              
              <h3>💾 Saved to:</h3>
              <p><code>${tokenFile}</code></p>
              
              <h3>🧪 Token Validation:</h3>
              <p>${isValid ? '✅ Tokens are valid and working!' : '❌ Token validation failed. Please check your configuration.'}</p>
              
              <hr>
              <p><strong>Next Steps:</strong></p>
              <ol>
                <li>Copy the tokens from the saved file to your environment variables</li>
                <li>Use the access token in your Zoho Books API requests</li>
                <li>Implement token refresh logic using the refresh token</li>
              </ol>
              
              <p style="margin-top: 30px;">
                <button onclick="window.close()" style="background: #28a745; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer;">
                  Close Window
                </button>
              </p>
            </body>
          </html>
        `);
        
        // Close the server after a delay
        setTimeout(() => {
          console.log('🎉 Authentication completed successfully!');
          console.log(`📁 Tokens saved to: ${tokenFile}`);
          process.exit(0);
        }, 5000);
        
      } catch (error) {
        console.error('❌ Token exchange failed:', error.message);
        res.send(`
          <html>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h1>❌ Token Exchange Failed</h1>
              <p><strong>Error:</strong> ${error.message}</p>
              <p>Please check your configuration and try again.</p>
            </body>
          </html>
        `);
      }
    });
  }

  async start() {
    if (!this.validateConfig()) {
      process.exit(1);
    }

    this.setupRoutes();

    const server = this.app.listen(CONFIG.PORT, () => {
      console.log('\n🚀 Zoho OAuth Authentication Server Started');
      console.log('=' .repeat(50));
      console.log(`📡 Server running on: http://localhost:${CONFIG.PORT}`);
      console.log(`🔐 Data Center: .${CONFIG.DATA_CENTER}`);
      console.log(`🎯 Scope: ${CONFIG.SCOPE}`);
      console.log('=' .repeat(50));
      console.log('\n📖 Instructions:');
      console.log('1. Open your browser and go to the server URL above');
      console.log('2. Click "Authorize with Zoho" to start the OAuth flow');
      console.log('3. Login to your Zoho account and grant permissions');
      console.log('4. The tokens will be saved automatically');
      console.log('\n⏰ Waiting for authorization...\n');
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n\n🛑 Shutting down server...');
      server.close(() => {
        console.log('✅ Server closed.');
        process.exit(0);
      });
    });
  }

  // Command to refresh existing tokens
  async refreshTokens() {
    const existingTokens = this.loadTokens();
    
    if (!existingTokens || !existingTokens.refresh_token) {
      console.error('❌ No refresh token found. Please run the full OAuth flow first.');
      process.exit(1);
    }

    try {
      console.log('🔄 Refreshing access token...');
      const newTokens = await this.refreshAccessToken(existingTokens.refresh_token);
      
      // Merge with existing data
      const updatedTokens = {
        ...existingTokens,
        ...newTokens,
        refreshed_at: new Date().toISOString()
      };
      
      this.saveTokens(updatedTokens);
      
      // Test the new tokens
      const isValid = await this.testTokens(newTokens.access_token);
      
      if (isValid) {
        console.log('✅ Tokens refreshed successfully!');
      } else {
        console.log('⚠️ Tokens refreshed but validation failed.');
      }
      
    } catch (error) {
      console.error('❌ Failed to refresh tokens:', error.message);
      process.exit(1);
    }
  }
}

// CLI handling
const command = process.argv[2];
const authenticator = new ZohoAuthenticator();

if (command === 'refresh') {
  authenticator.refreshTokens();
} else if (command === 'test') {
  const tokens = authenticator.loadTokens();
  if (tokens && tokens.access_token) {
    authenticator.testTokens(tokens.access_token);
  } else {
    console.error('❌ No tokens found. Please run the OAuth flow first.');
  }
} else {
  // Default: start OAuth server
  authenticator.start();
}
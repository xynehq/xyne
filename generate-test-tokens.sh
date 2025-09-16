#!/bin/bash

# Quick test script to generate call links for testing

echo "🎥 LiveKit Call Test Link Generator"
echo "=================================="

# Generate a test room name
ROOM_NAME="test_call_$(date +%s)"
CALLER_ID="test_caller"
TARGET_ID="test_target"

echo "Room Name: $ROOM_NAME"
echo ""

# Use Node.js to generate tokens (you can also do this manually with the LiveKit CLI)
cd server && node -e "
const { AccessToken } = require('livekit-server-sdk');

const apiKey = 'devkey';
const apiSecret = 'devsecret';
const roomName = '$ROOM_NAME';

async function generateTokens() {
  // Generate caller token
  const callerToken = new AccessToken(apiKey, apiSecret, {
    identity: '$CALLER_ID',
    ttl: '10m'
  });
  callerToken.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  });

  // Generate target token  
  const targetToken = new AccessToken(apiKey, apiSecret, {
    identity: '$TARGET_ID',
    ttl: '10m'
  });
  targetToken.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  });

  const callerJwt = await callerToken.toJwt();
  const targetJwt = await targetToken.toJwt();

  console.log('🔗 Caller Link:');
  console.log('http://localhost:5173/call?room=' + roomName + '&token=' + callerJwt + '&type=video');
  console.log('');
  console.log('🔗 Target Link (share this):');
  console.log('http://localhost:5173/call?room=' + roomName + '&token=' + targetJwt + '&type=video');
  console.log('');
  console.log('📋 To test:');
  console.log('1. Open the first link in one browser/tab');
  console.log('2. Open the second link in another browser/tab or incognito window');  
  console.log('3. Both should connect to the same call room');
}

generateTokens().catch(console.error);
"

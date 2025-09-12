#!/bin/bash

# Keycloak Setup Script for XYNE Development
# This script creates the necessary realm, client, and test user for XYNE

set -e

KEYCLOAK_URL="http://localhost:8081"
ADMIN_USER="admin"
ADMIN_PASS="admin"
REALM_NAME="xyne-shared"
CLIENT_ID="oa-backend"

echo "🔧 Setting up Keycloak for XYNE development..."

# Get admin access token
echo "📝 Getting admin access token..."
ADMIN_TOKEN=$(curl -s -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${ADMIN_USER}&password=${ADMIN_PASS}&grant_type=password&client_id=admin-cli" | \
  jq -r '.access_token')

if [ "$ADMIN_TOKEN" == "null" ] || [ -z "$ADMIN_TOKEN" ]; then
  echo "❌ Failed to get admin token"
  exit 1
fi

echo "✅ Admin token obtained"

# Create realm
echo "🌍 Creating realm: ${REALM_NAME}..."
curl -s -X POST "${KEYCLOAK_URL}/admin/realms" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "realm": "'${REALM_NAME}'",
    "enabled": true,
    "displayName": "XYNE Shared Realm",
    "registrationAllowed": true,
    "loginWithEmailAllowed": true,
    "duplicateEmailsAllowed": false,
    "resetPasswordAllowed": true,
    "editUsernameAllowed": true,
    "bruteForceProtected": false
  }' || echo "Realm might already exist"

echo "✅ Realm created/verified"

# Create client
echo "🔐 Creating client: ${CLIENT_ID}..."
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/clients" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "'${CLIENT_ID}'",
    "enabled": true,
    "protocol": "openid-connect",
    "publicClient": false,
    "directAccessGrantsEnabled": true,
    "serviceAccountsEnabled": false,
    "standardFlowEnabled": true,
    "implicitFlowEnabled": false,
    "redirectUris": [
      "http://localhost:3000/*",
      "http://localhost:5173/*"
    ],
    "webOrigins": [
      "http://localhost:3000",
      "http://localhost:5173"
    ],
    "attributes": {
      "access.token.lifespan": "300",
      "client.secret.creation.time": "'$(date +%s)'"
    }
  }' || echo "Client might already exist"

echo "✅ Client created/verified"

# Get client UUID for further configuration
CLIENT_UUID=$(curl -s -X GET "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/clients?clientId=${CLIENT_ID}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" | \
  jq -r '.[0].id')

echo "📋 Client UUID: ${CLIENT_UUID}"

# Create test user
echo "👤 Creating test user: debojyoti.mandal@juspay.in..."
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/users" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "debojyoti.mandal@juspay.in",
    "email": "debojyoti.mandal@juspay.in",
    "firstName": "Debojyoti",
    "lastName": "Mandal",
    "enabled": true,
    "emailVerified": false,
    "credentials": [{
      "type": "password",
      "value": "1",
      "temporary": false
    }]
  }' || echo "User might already exist"

echo "✅ Test user created/verified"

# Test the setup
echo "🧪 Testing configuration..."

# Test password grant
TEST_TOKEN=$(curl -s -X POST "${KEYCLOAK_URL}/realms/${REALM_NAME}/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=${CLIENT_ID}&username=debojyoti.mandal@juspay.in&password=1&scope=openid email profile" | \
  jq -r '.access_token' 2>/dev/null)

if [ "$TEST_TOKEN" == "null" ] || [ -z "$TEST_TOKEN" ]; then
  echo "⚠️  Password grant test failed - this might be expected if client secret is required"
else
  echo "✅ Password grant test successful"
fi

echo ""
echo "🎉 Keycloak setup completed!"
echo ""
echo "📋 Configuration Summary:"
echo "   Realm: ${REALM_NAME}"
echo "   Client ID: ${CLIENT_ID}"
echo "   Base URL: ${KEYCLOAK_URL}"
echo "   Test User: debojyoti.mandal@juspay.in / password: 1"
echo ""
echo "🌐 Admin Console: ${KEYCLOAK_URL}/admin/"
echo "   Username: ${ADMIN_USER}"
echo "   Password: ${ADMIN_PASS}"
echo ""
echo "🔧 Next steps:"
echo "   1. Test XYNE authentication"
echo "   2. Configure client secret if needed"
echo "   3. Set up additional users/roles as required"
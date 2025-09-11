# Microsoft Graph SDK Integration

This document explains the Microsoft Graph SDK integration that replaces the previous manual fetch-based implementation.

## Overview

The Microsoft integration now uses the official Microsoft Graph SDK (`@microsoft/microsoft-graph-client`) following the same pattern as the Google integration, providing better reliability, error handling, and type safety.

## Key Components

### 1. Client Module (`client.ts`)

- **`createMicrosoftGraphClient`**: Creates a Microsoft Graph client similar to Google's pattern
- **`makeGraphApiCall`**: Helper function for making API calls with retry logic
- **`makePagedGraphApiCall`**: Helper for paginated requests
- **`CustomAuthProvider`**: Custom authentication provider implementing the Microsoft Graph SDK interface

### 2. Main Integration (`index.ts`)

The main integration handles:
- **OneDrive Files**: File metadata and content indexing
- **Outlook Emails**: Email content and metadata processing
- **Calendar Events**: Meeting details, attendees, and attachments
- **Contacts**: Contact information and organization details

## Key Improvements

### Before (Manual Fetch)
```typescript
const response = await fetch(url, {
  method,
  headers: {
    Authorization: `Bearer ${client.accessToken}`,
    "Content-Type": "application/json",
  },
  body: body ? JSON.stringify(body) : undefined,
})
```

### After (Microsoft Graph SDK)
```typescript
const response = await makeGraphApiCall(client, endpoint)
```

## Benefits

1. **Better Error Handling**: Built-in retry logic and proper error handling
2. **Type Safety**: Full TypeScript support with proper schema types
3. **Automatic Pagination**: Built-in support for paginated responses
4. **Consistent Patterns**: Follows the same pattern as Google integration
5. **Token Management**: Automatic token refresh handling (can be enhanced)
6. **Reliability**: Official SDK with better stability and maintenance

## Usage Example

```typescript
// Create client
const graphClient = createMicrosoftGraphClient(
  accessToken,
  refreshToken,
  clientId,
  clientSecret
)

// Make API call
const events = await makeGraphApiCall(graphClient, '/me/events')

// Handle paginated data
const allContacts = await makePagedGraphApiCall(graphClient, '/me/contacts')
```

## API Endpoints Used

- **Calendar**: `/me/events` - Fetch calendar events
- **Contacts**: `/me/contacts` - Fetch user contacts
- **OneDrive**: `/me/drive/root/children` - Fetch OneDrive files
- **Outlook**: `/me/messages` - Fetch email messages
- **Delta Sync**: `/me/drive/root/delta` - Get change tokens for incremental sync

## Configuration

The integration requires the following environment variables:
- `MICROSOFT_CLIENT_ID`: Azure app client ID
- `MICROSOFT_CLIENT_SECRET`: Azure app client secret
- `MICROSOFT_REDIRECT_URI`: OAuth redirect URI

## Scopes Required

The integration requires these Microsoft Graph scopes:
- `Files.Read.All`: OneDrive file access
- `Mail.Read`: Outlook email access
- `Calendars.Read`: Calendar events access
- `Contacts.Read`: Contacts access
- `User.Read`: Basic user profile
- `offline_access`: Refresh token access

## Future Enhancements

1. **Token Refresh**: Implement automatic token refresh in `CustomAuthProvider`
2. **File Content**: Add support for downloading and processing file content
3. **Attachments**: Enhanced attachment processing for emails and events
4. **Permissions**: More sophisticated permission handling for shared files
5. **Error Recovery**: Enhanced error recovery and retry mechanisms

## Migration Notes

The refactoring maintains the same external API and functionality while improving the underlying implementation. No changes are required to the frontend or database schema.

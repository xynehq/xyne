# Microsoft Graph API Response Logging

This document describes the response logging functionality that has been implemented for the Microsoft Graph integration to capture actual API responses for analysis.

## Overview

Response logging has been added to all Microsoft Graph API calls to save the actual API responses to JSON files. This allows developers to analyze the real data structure returned by Microsoft Graph APIs and understand what fields are available for further development.

## Implementation Details

### Response Directory Structure

All API responses are saved to: `server/integrations/microsoft/responses/`

The directory is automatically created if it doesn't exist.

### File Naming Convention

Response files are named with timestamps to avoid conflicts:
- `calendar-events-{timestamp}.json` - Calendar events responses
- `contacts-{timestamp}.json` - Contacts responses  
- `onedrive-files-{timestamp}.json` - OneDrive files responses
- `outlook-messages-{timestamp}.json` - Outlook messages responses

Where `{timestamp}` is in the format: `YYYY-MM-DDTHH-MM-SS-sssZ` (ISO string with special characters replaced by hyphens)

### Logged API Endpoints

#### 1. Calendar Events (`insertCalendarEvents`)
- **Endpoint**: `/me/events`
- **File**: `calendar-events-{timestamp}.json`
- **Data**: Complete calendar event objects including attendees, attachments, recurrence, etc.

#### 2. Contacts (`listAllContacts`)
- **Endpoint**: `/me/contacts`
- **File**: `contacts-{timestamp}.json`
- **Data**: Contact information including email addresses, phone numbers, job details, etc.

#### 3. OneDrive Files (`insertFilesForUser`)
- **Endpoint**: `/me/drive/root/children`
- **File**: `onedrive-files-{timestamp}.json`
- **Data**: File metadata including size, download URLs, creation dates, etc.

#### 4. Outlook Messages (`handleOutlookIngestion`)
- **Endpoint**: `/me/messages`
- **File**: `outlook-messages-{timestamp}.json`
- **Data**: Email message data including subject, body, recipients, attachments, etc.

## Error Handling

If response logging fails for any reason:
- The error is logged as a warning
- The main API processing continues uninterrupted
- No impact on the actual data ingestion process

## Usage for Development

### Analyzing Response Structure

1. Run a Microsoft OAuth ingestion
2. Check the `server/integrations/microsoft/responses/` directory
3. Open the JSON files to see the actual API response structure
4. Use this data to:
   - Understand available fields
   - Plan new features
   - Debug data mapping issues
   - Optimize field selection in API calls

### Example Response Analysis

```bash
# Navigate to responses directory
cd server/integrations/microsoft/responses/

# View calendar events structure
cat calendar-events-2024-01-15T10-30-45-123Z.json | jq '.value[0]'

# Count available fields in contacts
cat contacts-2024-01-15T10-30-45-123Z.json | jq '.value[0] | keys'

# Check OneDrive file metadata
cat onedrive-files-2024-01-15T10-30-45-123Z.json | jq '.value[0]'
```

## Benefits

1. **Real Data Analysis**: See actual Microsoft Graph API responses instead of relying on documentation
2. **Field Discovery**: Identify additional fields that could be useful for the application
3. **Debugging**: Compare expected vs actual API responses when troubleshooting
4. **Development Planning**: Plan new features based on available data
5. **API Evolution**: Track changes in Microsoft Graph API responses over time

## Security Considerations

- Response files contain actual user data
- Ensure the `responses/` directory is included in `.gitignore`
- Consider implementing automatic cleanup of old response files
- Be mindful of data privacy when sharing or analyzing these files

## Future Enhancements

1. **Selective Logging**: Add configuration to enable/disable response logging
2. **Data Sanitization**: Option to sanitize sensitive data before logging
3. **Automatic Cleanup**: Implement automatic deletion of old response files
4. **Response Analysis Tools**: Create scripts to analyze and summarize response data
5. **Schema Generation**: Automatically generate TypeScript interfaces from responses

## Related Files

- `server/integrations/microsoft/index.ts` - Main integration file with logging implementation
- `server/integrations/microsoft/client.ts` - Microsoft Graph client wrapper
- `server/integrations/microsoft/README.md` - General Microsoft integration documentation

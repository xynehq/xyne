#!/bin/bash

set -euo pipefail

# --- Configuration ---
PROMETHEUS_URL="http://localhost:9090" # IMPORTANT: Change this to your Prometheus server URL
SERVICE_SELECTOR='{service="xyne-metrics"}'
# --- End Configuration ---

# Function to check if Prometheus Admin API is enabled (basic check)
check_admin_api() {
    echo "INFO: Checking Prometheus Admin API status at ${PROMETHEUS_URL}..."
    # Attempt a POST to the delete_series endpoint without matchers.
    # Expect HTTP 400 (Bad Request) if Admin API is enabled.
    # Expect HTTP 404 (Not Found) if Admin API is disabled or endpoint is incorrect.
    local api_check_status_code
    api_check_status_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${PROMETHEUS_URL}/api/v1/admin/tsdb/delete_series")

    if [ "$api_check_status_code" == "400" ]; then
        echo "INFO: Admin API endpoint is responsive (HTTP 400 on POST without matchers, as expected)."
    elif [ "$api_check_status_code" == "404" ]; then
        echo "WARNING: Prometheus Admin API endpoint not found (HTTP 404 on POST)."
        echo "Please ensure Prometheus is started with '--web.enable-admin-api' and the URL is correct."
        # Consider exiting or prompting user, as subsequent operations will likely fail.
    elif [ "$api_check_status_code" == "000" ]; then # curl connection error
        echo "ERROR: Could not reach Prometheus at ${PROMETHEUS_URL}. (curl failed to connect)"
        echo "Please check the URL and ensure Prometheus is running."
        exit 1
    else
        echo "WARNING: Unexpected HTTP status ${api_check_status_code} when checking Admin API via POST."
        echo "The Admin API might not be enabled or functioning correctly."
        echo "Please ensure Prometheus is started with '--web.enable-admin-api'."
    fi
}


echo "--------------------------------------------------------------------"
echo "Prometheus Data Deletion Script"
echo "--------------------------------------------------------------------"
echo "Prometheus URL: ${PROMETHEUS_URL}"
echo "Service Selector: ${SERVICE_SELECTOR}"
echo ""
echo "WARNING: This script will attempt to delete all time series data matching"
echo "the selector '${SERVICE_SELECTOR}' from Prometheus."
echo "This operation is IRREVERSIBLE."
echo ""
echo "Please ensure:"
echo "1. Prometheus is running."
echo "2. The Admin API is enabled on Prometheus (started with --web.enable-admin-api)."
echo "3. The PROMETHEUS_URL above is correct."
echo "--------------------------------------------------------------------"

# Perform a basic check
check_admin_api

read -p "Are you sure you want to proceed with deleting the data? (yes/NO): " CONFIRMATION

if [[ "${CONFIRMATION}" != "yes" ]]; then
    echo "Deletion cancelled by user."
    exit 0
fi

echo ""
echo "Attempting to delete series matching '${SERVICE_SELECTOR}'..."

# API URL encode the selector
# curl already does this for POST data, but if using GET for match[], it would be needed.
# For POST, it's fine as is.

DELETE_RESPONSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
     -X POST \
     -g "${PROMETHEUS_URL}/api/v1/admin/tsdb/delete_series?match[]=${SERVICE_SELECTOR}")

if [ "$DELETE_RESPONSE_CODE" == "204" ]; then
    echo "SUCCESS: Delete request for '${SERVICE_SELECTOR}' sent successfully (HTTP 204 No Content)."
    echo "Data is now marked for deletion (tombstoned)."
else
    echo "ERROR: Delete request failed with HTTP status code ${DELETE_RESPONSE_CODE}."
    echo "Response body (if any):"
    curl -X POST -g "${PROMETHEUS_URL}/api/v1/admin/tsdb/delete_series?match[]=${SERVICE_SELECTOR}"
    echo ""
    echo "Please check Prometheus logs for more details."
    echo "Ensure the Admin API is enabled (--web.enable-admin-api) and the selector is correct."
    # Do not proceed to clean tombstones if deletion failed
    exit 1
fi

echo ""
read -p "Do you want to attempt to clean tombstones now? (This permanently removes the marked data from disk and can take time) (yes/NO): " CLEAN_CONFIRMATION

if [[ "${CLEAN_CONFIRMATION}" != "yes" ]]; then
    echo "Tombstone cleaning skipped. Deleted data will be removed during the next scheduled compaction or manual cleaning."
    exit 0
fi

echo ""
echo "Attempting to clean tombstones..."

CLEAN_RESPONSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    "${PROMETHEUS_URL}/api/v1/admin/tsdb/clean_tombstones")

if [ "$CLEAN_RESPONSE_CODE" == "204" ]; then
    echo "SUCCESS: Clean tombstones request sent successfully (HTTP 204 No Content)."
    echo "Tombstoned data should now be removed from disk. This process might take some time on the server."
elif [ "$CLEAN_RESPONSE_CODE" == "503" ]; then # Service Unavailable
    echo "INFO: Clean tombstones returned HTTP 503. This can happen if a cleanup is already in progress. Check Prometheus logs."
else
    echo "ERROR: Clean tombstones request failed with HTTP status code ${CLEAN_RESPONSE_CODE}."
    echo "Response body (if any):"
    curl -X POST "${PROMETHEUS_URL}/api/v1/admin/tsdb/clean_tombstones"
    echo ""
    echo "Please check Prometheus logs for more details."
fi

echo ""
echo "Deletion process finished."

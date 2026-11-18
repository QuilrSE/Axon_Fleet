// Wire-protocol identifiers of the Whitematter A2A Gateway.
// These are the exact header and field names the live gateway sends and expects. They are protocol
// identifiers, not product naming, so they are kept verbatim here and referenced everywhere else through
// these constants. If the gateway renames them, change them in this file only.
export const WM_KEY_HEADER = 'X-Quilr-A2A-Key';            // caller key (alternative to Authorization: Bearer)
export const WM_REQUEST_ID_HEADER = 'x-quilr-request-id';  // on every gateway response
export const WM_CHAIN_HEADER = 'x-quilr-a2a-chain';        // signed delegation chain added to agent calls
export const WM_ERROR_CODE_FIELD = 'quilr_error_code';     // in error data / google.rpc ErrorInfo metadata

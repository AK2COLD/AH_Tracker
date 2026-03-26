/**
 * auth.js — Blizzard OAuth2 token manager
 *
 * Blizzard uses the "client credentials" OAuth2 flow: we send our
 * client ID and secret, and get back a short-lived access token.
 * We cache that token in memory and only refresh it when it's about
 * to expire, saving us ~1,440 unnecessary HTTP requests per day.
 */

import 'dotenv/config';

// Token cache — lives in memory for the lifetime of the process
let cachedToken = null;
let tokenExpiresAt = 0;  // Unix timestamp in milliseconds

// Refresh 5 minutes before actual expiry to avoid edge-case failures
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Returns a valid Blizzard access token, fetching a new one if needed.
 * This is the only function other modules need to call.
 */
export async function getAccessToken() {
    const now = Date.now();

    // Return the cached token if it's still fresh
    if (cachedToken && now < tokenExpiresAt - REFRESH_BUFFER_MS) {
        return cachedToken;
    }

    console.log('[auth] Fetching new Blizzard access token...');
    await refreshToken();
    return cachedToken;
}

/**
 * Performs the OAuth2 client credentials request and updates the cache.
 * Blizzard expects Basic Auth with client_id:client_secret, base64-encoded.
 */
async function refreshToken() {
    const { BNET_CLIENT_ID, BNET_CLIENT_SECRET, BNET_REGION } = process.env;

    // Build the Basic Auth header — this is the standard OAuth2 client credentials format
    const credentials = Buffer.from(`${BNET_CLIENT_ID}:${BNET_CLIENT_SECRET}`).toString('base64');

    const response = await fetch(
        `https://${BNET_REGION}.battle.net/oauth/token`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            // grant_type=client_credentials means "I am the client, give me a token"
            body: 'grant_type=client_credentials',
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OAuth token request failed: ${response.status} ${text}`);
    }

    const data = await response.json();

    // data.expires_in is in seconds — convert to ms and record the absolute expiry time
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;

    console.log(`[auth] Token acquired, expires in ${Math.round(data.expires_in / 3600)}h`);
}

/**
 * Token Revocation Service
 * 
 * Manages revoked tokens to prevent their use even if they haven't expired.
 * Uses database for persistent storage (survives server restarts).
 * Falls back to in-memory cache if database is unavailable.
 */

const { globalCache } = require('./cache');
const { supabaseAdmin } = require('../config/supabase');
const crypto = require('crypto');

class TokenRevocationService {
  constructor() {
    this.revokedTokens = new Map(); // In-memory map for fast lookups (Map<tokenHash, revokedAt>)
    this.useDatabase = true; // Use database for persistence
    this.useCache = true; // Use cache as fallback/secondary storage
  }

  /**
   * Hash token for storage (don't store full token for security)
   * @param {string} token - JWT token
   * @returns {string} - SHA-256 hash of token
   */
  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Revoke a token (add to blacklist)
   * @param {string} token - JWT token to revoke
   * @param {number} ttl - Time to live in milliseconds (default: token expiry time)
   * @param {string} userId - Optional user ID for tracking
   * @param {string} reason - Optional reason for revocation
   */
  async revokeToken(token, ttl = 30 * 24 * 60 * 60 * 1000, userId = null, reason = 'logout') {
    try {
      if (!token || typeof token !== 'string' || token.length === 0) {
        return { success: false, error: 'Invalid token' };
      }

      const tokenHash = this.hashToken(token);
      const expiresAt = new Date(Date.now() + ttl).toISOString();

      // Add to in-memory map for fast lookups (store hash, not raw token)
      this.revokedTokens.set(tokenHash, Date.now());

      // Store in cache as backup
      if (this.useCache) {
        const cacheKey = `revoked_token:${tokenHash}`;
        globalCache.set(cacheKey, true, ttl);
      }

      // Store in database for persistence (survives restarts)
      if (this.useDatabase) {
        try {
          const { error: dbError } = await supabaseAdmin
            .from('revoked_tokens')
            .insert({
              token_hash: tokenHash,
              user_id: userId,
              expires_at: expiresAt,
              reason: reason
            });

          if (dbError) {
            // If table doesn't exist, log warning but continue
            if (dbError.code === '42P01') { // Table doesn't exist
              console.warn('⚠️ revoked_tokens table not found. Run migration: create_revoked_tokens_table.sql');
            } else {
              console.error('❌ Error storing revoked token in database:', dbError);
            }
          }
        } catch (dbError) {
          console.error('❌ Database error revoking token:', dbError);
          // Continue with in-memory/cache revocation
        }
      }

      // Log token hash instead of substring to avoid leaking JWT header/payload
      console.log('🔒 Token revoked:', tokenHash.substring(0, 12) + '...');
      return { success: true };
    } catch (error) {
      console.error('❌ Error revoking token:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if a token is revoked
   * @param {string} token - JWT token to check
   * @returns {Promise<boolean>} - True if token is revoked
   */
  async isTokenRevoked(token) {
    try {
      if (!token || typeof token !== 'string' || token.length === 0) {
        return false;
      }

      const tokenHash = this.hashToken(token);

      // Check in-memory map first (fastest) - using hash
      if (this.revokedTokens.has(tokenHash)) {
        return true;
      }

      // Check cache
      if (this.useCache) {
        const cacheKey = `revoked_token:${tokenHash}`;
        const isRevoked = globalCache.get(cacheKey);
        if (isRevoked) {
          // Add back to in-memory map for faster future lookups (using hash)
          this.revokedTokens.set(tokenHash, Date.now());
          return true;
        }
      }

      // Check database (persistent storage)
      if (this.useDatabase) {
        try {
          const { data, error } = await supabaseAdmin
            .from('revoked_tokens')
            .select('id, expires_at')
            .eq('token_hash', tokenHash)
            .gt('expires_at', new Date().toISOString()) // Only non-expired
            .limit(1)
            .maybeSingle();

          if (error) {
            // If table doesn't exist, fall back to cache/memory
            if (error.code === '42P01') { // Table doesn't exist
              console.warn('⚠️ revoked_tokens table not found. Using cache/memory only.');
              return false;
            }
            
            // Check if it's a timeout/connection/network error (Cloudflare 522, fetch failed, etc.)
            const errorMessage = error.message || '';
            const isTimeoutError = errorMessage.includes('522') ||
                                  errorMessage.includes('fetch failed') ||
                                  errorMessage.includes('TypeError: fetch failed') ||
                                  errorMessage.includes('Connection timed out') ||
                                  errorMessage.includes('timeout') ||
                                  errorMessage.includes('ETIMEDOUT') ||
                                  errorMessage.includes('ECONNREFUSED') ||
                                  errorMessage.includes('ENOTFOUND') ||
                                  errorMessage.includes('<!DOCTYPE html>'); // HTML error page (Cloudflare)
            
            if (isTimeoutError) {
              // Network/unreachable - fail-open (allow token). One-line warning to avoid log spam.
              console.warn('⚠️ Supabase unreachable when checking token revocation (allowing token). Check SUPABASE_URL and network.');
              return false; // Fail-open: Allow token if database check fails due to network
            }
            
            // For other database errors, log cleanly and fail-open (consistent with try-path)
            console.error('❌ Database error checking token revocation (allowing token):', {
              message: error.message?.substring(0, 200) || 'Unknown error',
              code: error.code,
              details: error.details,
              hint: error.hint
            });
            // Fail-open: Allow token if database check fails (cache/memory still provides protection)
            return false;
          }

          if (data) {
            // Token is revoked, add to in-memory map and cache (using hash)
            this.revokedTokens.set(tokenHash, Date.now());
            if (this.useCache) {
              const expiresAt = new Date(data.expires_at).getTime();
              const ttl = expiresAt - Date.now();
              if (ttl > 0) {
                globalCache.set(`revoked_token:${tokenHash}`, true, ttl);
              }
            }
            return true;
          }
        } catch (dbError) {
          // Check if it's a timeout/connection/network error (including fetch failed = Supabase unreachable)
          const errorMessage = dbError.message || String(dbError);
          const isNetworkError = errorMessage.includes('522') ||
                                errorMessage.includes('fetch failed') ||
                                errorMessage.includes('TypeError: fetch failed') ||
                                errorMessage.includes('Connection timed out') ||
                                errorMessage.includes('timeout') ||
                                errorMessage.includes('ETIMEDOUT') ||
                                errorMessage.includes('ECONNREFUSED') ||
                                errorMessage.includes('ENOTFOUND') ||
                                errorMessage.includes('<!DOCTYPE html>');

          if (isNetworkError) {
            // Network error - fail-open (allow token). Log once at debug level to avoid spam.
            console.warn('⚠️ Supabase unreachable when checking token revocation (allowing token). Check SUPABASE_URL and network.');
            return false;
          } else {
            console.error('❌ Database error checking token revocation (allowing token):', 
              errorMessage.substring(0, 200) + (errorMessage.length > 200 ? '...' : ''));
            return false;
          }
        }
      }

      return false;
    } catch (error) {
      console.error('❌ Error checking token revocation:', error);
      return false; // Fail-open: allow token if check fails
    }
  }

  /**
   * Revoke all tokens for a user (on password change, account deactivation, etc.)
   * @param {string} userId - User ID whose tokens should be revoked
   * @param {string} reason - Reason for revocation
   * @param {number} ttl - Time to live in milliseconds (default: 30 days)
   */
  async revokeUserTokens(userId, reason = 'deactivation', ttl = 30 * 24 * 60 * 60 * 1000) {
    try {
      if (!userId) {
        return { success: false, error: 'User ID required' };
      }

      const expiresAt = new Date(Date.now() + ttl).toISOString();

      // Store in cache
      if (this.useCache) {
        const cacheKey = `revoked_user:${userId}`;
        globalCache.set(cacheKey, true, ttl);
      }

      // Store in database for persistence
      if (this.useDatabase) {
        try {
          // Upsert (update if exists, insert if not)
          const { error: dbError } = await supabaseAdmin
            .from('revoked_users')
            .upsert({
              user_id: userId,
              expires_at: expiresAt,
              reason: reason
            }, {
              onConflict: 'user_id'
            });

          if (dbError) {
            if (dbError.code === '42P01') { // Table doesn't exist
              console.warn('⚠️ revoked_users table not found. Run migration: create_revoked_tokens_table.sql');
            } else {
              console.error('❌ Error storing revoked user in database:', dbError);
            }
          }
        } catch (dbError) {
          console.error('❌ Database error revoking user tokens:', dbError);
          // Continue with cache revocation
        }
      }

      console.log(`🔒 All tokens revoked for user: ${userId}`);
      return { success: true };
    } catch (error) {
      console.error('❌ Error revoking user tokens:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if user's tokens are revoked
   * @param {string} userId - User ID to check
   * @returns {Promise<boolean>} - True if user tokens are revoked
   */
  async isUserRevoked(userId) {
    try {
      if (!userId) {
        return false;
      }

      // Check cache first
      if (this.useCache) {
        const cacheKey = `revoked_user:${userId}`;
        const isRevoked = globalCache.get(cacheKey);
        if (isRevoked === true) {
          return true;
        }
      }

      // Check database (persistent storage)
      if (this.useDatabase) {
        try {
          const { data, error } = await supabaseAdmin
            .from('revoked_users')
            .select('id, expires_at')
            .eq('user_id', userId)
            .gt('expires_at', new Date().toISOString()) // Only non-expired
            .limit(1)
            .maybeSingle();

          if (error) {
            if (error.code === '42P01') { // Table doesn't exist
              console.warn('⚠️ revoked_users table not found. User revocation check skipped.');
              return false; // Table doesn't exist, assume not revoked
            }
            // Treat fetch failed / network errors as single warning (Supabase unreachable)
            const errMsg = error.message || '';
            const isNetworkError = errMsg.includes('fetch failed') || errMsg.includes('TypeError: fetch failed');
            if (isNetworkError) {
              console.warn('⚠️ Supabase unreachable when checking user revocation (allowing request). Check SUPABASE_URL and network.');
            } else {
              console.error('❌ Database error checking user revocation:', { message: error.message, code: error.code, hint: error.hint });
            }
            return false;
          }

          if (data) {
            // User is revoked, update cache
            if (this.useCache) {
              const expiresAt = new Date(data.expires_at).getTime();
              const ttl = expiresAt - Date.now();
              if (ttl > 0) {
                globalCache.set(`revoked_user:${userId}`, true, ttl);
              }
            }
            return true;
          }
        } catch (dbError) {
          const errMsg = dbError.message || String(dbError);
          const isNetworkError = errMsg.includes('fetch failed') ||
                                errMsg.includes('TypeError: fetch failed') ||
                                errMsg.includes('timeout') ||
                                errMsg.includes('ECONNREFUSED') ||
                                errMsg.includes('ENOTFOUND') ||
                                dbError.code === 'ETIMEDOUT' ||
                                dbError.code === 'ECONNREFUSED';
          if (isNetworkError) {
            console.warn('⚠️ Supabase unreachable when checking user revocation (allowing request). Check SUPABASE_URL and network.');
          } else {
            console.error('❌ Error checking user revocation in database (allowing request):', errMsg.substring(0, 200));
          }
          return false;
        }
      }

      return false;
    } catch (error) {
      // Outer catch for unexpected errors - fail-open for availability
      // Cache check provides protection if available
      console.error('❌ Unexpected error checking user revocation (allowing request):', error.message);
      return false; // Fail-open: Allow request if check fails
    }
  }

  /**
   * Cleanup old revoked tokens from memory (periodic cleanup)
   */
  cleanup() {
    // In-memory map will grow, but tokens are short-lived
    // For production, consider using Redis with TTL
    // Use timestamp-based LRU cleanup to prevent memory bloat
    if (this.revokedTokens.size > 10000) {
      console.log('🧹 Cleaning up revoked tokens map (size:', this.revokedTokens.size, ')');
      // Sort by revokedAt timestamp and keep only most recent 5000 entries
      const entriesArray = Array.from(this.revokedTokens.entries())
        .sort((a, b) => b[1] - a[1]) // Sort by revokedAt descending (newest first)
        .slice(0, 5000); // Keep top 5000
      
      // In-place pruning: delete old entries instead of reassigning Map
      const keysToKeep = new Set(entriesArray.map(([key]) => key));
      for (const key of this.revokedTokens.keys()) {
        if (!keysToKeep.has(key)) {
          this.revokedTokens.delete(key);
        }
      }
    }
  }
}

// Singleton instance
const tokenRevocationService = new TokenRevocationService();

// Periodic cleanup (every hour)
setInterval(() => {
  tokenRevocationService.cleanup();
}, 60 * 60 * 1000);

module.exports = tokenRevocationService;


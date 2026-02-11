/**
 * Account Lockout Service
 * 
 * Tracks failed login attempts and locks accounts after threshold.
 * Prevents brute force attacks.
 */

const { supabaseAdmin } = require('../config/supabase');
const { globalCache } = require('./cache');

class AccountLockoutService {
  constructor() {
    this.maxAttempts = 5; // Lock after 5 failed attempts
    this.lockoutDuration = 30 * 60 * 1000; // 30 minutes
    this.useDatabase = true; // Use database for persistence
    this.useCache = true; // Use cache for fast lookups
  }

  /**
   * Record a failed login attempt
   * @param {string} email - User email
   * @param {string} ip - IP address
   * @returns {Promise<{locked: boolean, attemptsRemaining: number, lockoutUntil: Date|null}>}
   */
  async recordFailedAttempt(email, ip = null) {
    try {
      if (!email) {
        return { locked: false, attemptsRemaining: this.maxAttempts };
      }

      const normalizedEmail = email.toLowerCase().trim();
      const cacheKey = `failed_attempts:${normalizedEmail}`;
      
      // Get current attempts from cache (only if cache is enabled)
      let attempts = 0;
      if (this.useCache) {
        attempts = globalCache.get(cacheKey) || 0;
      }
      attempts += 1;

      // Store in cache (only if cache is enabled)
      if (this.useCache) {
        globalCache.set(cacheKey, attempts, this.lockoutDuration);
      }

      // Store in database for persistence
      if (this.useDatabase) {
        try {
          // Check if account is already locked
          const { data: existingLock } = await supabaseAdmin
            .from('account_lockouts')
            .select('*')
            .eq('email', normalizedEmail)
            .gt('locked_until', new Date().toISOString())
            .maybeSingle();

          if (existingLock) {
            // Already locked
            const lockedUntil = new Date(existingLock.locked_until);
            return {
              locked: true,
              attemptsRemaining: 0,
              lockoutUntil: lockedUntil
            };
          }

          // Use atomic RPC function for increment (replaces read-then-upsert TOCTOU race)
          const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('increment_failed_attempts', {
            p_email: normalizedEmail,
            p_ip: ip,
            p_max_attempts: this.maxAttempts,
            p_lockout_duration_ms: this.lockoutDuration
          });

          if (rpcError) {
            if (rpcError.code === '42883') {
              // Function doesn't exist - fallback to read-then-upsert
              console.warn('⚠️ increment_failed_attempts RPC function not found. Using fallback (not atomic).');
              console.warn('   Create function with: CREATE OR REPLACE FUNCTION increment_failed_attempts(p_email TEXT, p_ip TEXT, p_max_attempts INTEGER, p_lockout_duration_ms BIGINT) RETURNS TABLE(failed_attempts INTEGER, locked_until TIMESTAMP WITH TIME ZONE) AS $$ BEGIN INSERT INTO account_lockouts (email, failed_attempts, last_attempt_ip, last_attempt_at) VALUES (p_email, 1, p_ip, NOW()) ON CONFLICT (email) DO UPDATE SET failed_attempts = account_lockouts.failed_attempts + 1, last_attempt_ip = p_ip, last_attempt_at = NOW(), locked_until = CASE WHEN account_lockouts.failed_attempts + 1 >= p_max_attempts THEN NOW() + (p_lockout_duration_ms || \' milliseconds\')::INTERVAL ELSE NULL END RETURNING failed_attempts, locked_until; END; $$ LANGUAGE plpgsql;');
              
              // Fallback: read-then-upsert (not atomic but better than nothing)
              const { data: existingLockout } = await supabaseAdmin
                .from('account_lockouts')
                .select('failed_attempts')
                .eq('email', normalizedEmail)
                .maybeSingle();

              const currentFailedAttempts = existingLockout?.failed_attempts || 0;
              const newFailedAttempts = currentFailedAttempts + 1;
              const shouldLock = newFailedAttempts >= this.maxAttempts;

              const { error: dbError } = await supabaseAdmin
                .from('account_lockouts')
                .upsert({
                  email: normalizedEmail,
                  failed_attempts: newFailedAttempts,
                  locked_until: shouldLock
                    ? new Date(Date.now() + this.lockoutDuration).toISOString()
                    : null,
                  last_attempt_ip: ip,
                  last_attempt_at: new Date().toISOString()
                }, {
                  onConflict: 'email'
                });

              if (dbError && dbError.code !== '42P01') {
                console.error('❌ Error recording failed attempt (fallback):', {
                  code: dbError.code,
                  message: dbError.message
                });
              }
              
              attempts = newFailedAttempts;
            } else {
              // Other RPC error
              console.error('❌ Error calling increment_failed_attempts RPC:', {
                code: rpcError.code,
                message: rpcError.message
              });
            }
          } else if (rpcResult && rpcResult.length > 0) {
            // RPC succeeded - extract values
            attempts = rpcResult[0].failed_attempts || 0;
          }
        } catch (dbError) {
          // Sanitize error logging to avoid PII leakage
          console.error('❌ Database error recording failed attempt:', {
            code: dbError?.code,
            message: dbError?.message,
            hint: dbError?.hint,
            details: dbError?.details
          });
          // Continue with cache-only tracking
        }
      }

      // Check if account should be locked
      if (attempts >= this.maxAttempts) {
        const lockoutUntil = new Date(Date.now() + this.lockoutDuration);
        return {
          locked: true,
          attemptsRemaining: 0,
          lockoutUntil: lockoutUntil
        };
      }

      return {
        locked: false,
        attemptsRemaining: this.maxAttempts - attempts,
        lockoutUntil: null
      };
    } catch (error) {
      console.error('❌ Error recording failed attempt:', error?.code || error?.name || 'unknown');
      // Fail-closed: deny login on DB/cache errors
      return { locked: true, attemptsRemaining: 0 };
    }
  }

  /**
   * Check if account is locked
   * @param {string} email - User email
   * @returns {Promise<{locked: boolean, lockoutUntil: Date|null}>}
   */
  async isAccountLocked(email) {
    try {
      if (!email) {
        return { locked: false, lockoutUntil: null };
      }

      const normalizedEmail = email.toLowerCase().trim();
      const cacheKey = `failed_attempts:${normalizedEmail}`;
      
      // Check cache first (only if cache is enabled)
      let attempts = 0;
      if (this.useCache) {
        attempts = globalCache.get(cacheKey) || 0;
      }

      if (attempts >= this.maxAttempts) {
        // Check database for lockout expiry
        if (this.useDatabase) {
          try {
            const { data: lockout } = await supabaseAdmin
              .from('account_lockouts')
              .select('locked_until')
              .eq('email', normalizedEmail)
              .gt('locked_until', new Date().toISOString())
              .maybeSingle();

            if (lockout) {
              return {
                locked: true,
                lockoutUntil: new Date(lockout.locked_until)
              };
            } else {
              // Database has no active lockout - return unlocked and reset cache
              if (this.useCache) {
                globalCache.delete(cacheKey);
              }
              return {
                locked: false,
                lockoutUntil: null
              };
            }
          } catch (dbError) {
            if (dbError.code !== '42P01') {
              console.error('❌ Error checking account lockout:', { code: dbError?.code, message: dbError?.message });
            }
          }
        }
        // If no database or expired, but cache shows locked - return unlocked (cache is stale)
        if (this.useCache) {
          globalCache.delete(cacheKey);
        }
        return {
          locked: false,
          lockoutUntil: null
        };
      }

      // Check database
      if (this.useDatabase) {
        try {
          const { data: lockout } = await supabaseAdmin
            .from('account_lockouts')
            .select('locked_until')
            .eq('email', normalizedEmail)
            .gt('locked_until', new Date().toISOString())
            .maybeSingle();

          if (lockout) {
            return {
              locked: true,
              lockoutUntil: new Date(lockout.locked_until)
            };
          }
        } catch (dbError) {
          if (dbError.code !== '42P01') {
            console.error('❌ Error checking account lockout:', { code: dbError?.code, message: dbError?.message });
          }
        }
      }

      return { locked: false, lockoutUntil: null };
    } catch (error) {
      console.error('❌ Error checking account lockout:', error?.code || error?.name || 'unknown');
      // Fail-closed: consistent with recordFailedAttempt — deny access when check fails so we do not fail-open on errors
      return { locked: true, lockoutUntil: null };
    }
  }

  /**
   * Clear failed attempts on successful login
   * @param {string} email - User email
   */
  async clearFailedAttempts(email) {
    try {
      if (!email) {
        return;
      }

      const normalizedEmail = email.toLowerCase().trim();
      const cacheKey = `failed_attempts:${normalizedEmail}`;

      // Clear cache
      if (this.useCache) {
        globalCache.delete(cacheKey);
      }

      // Clear database
      if (this.useDatabase) {
        try {
          const { error: deleteError } = await supabaseAdmin
            .from('account_lockouts')
            .delete()
            .eq('email', normalizedEmail);
          if (deleteError && deleteError.code !== '42P01') {
            console.error('❌ Error clearing failed attempts:', { code: deleteError.code, message: deleteError.message });
          }
        } catch (dbError) {
          if (dbError.code !== '42P01') {
            console.error('❌ Error clearing failed attempts:', { code: dbError?.code, message: dbError?.message });
          }
        }
      }
    } catch (error) {
      console.error('❌ Error clearing failed attempts:', error);
    }
  }
}

// Singleton instance
const accountLockoutService = new AccountLockoutService();

module.exports = accountLockoutService;


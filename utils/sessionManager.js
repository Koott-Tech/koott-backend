/**
 * Session Management Service
 * 
 * Tracks active user sessions and allows session revocation.
 * Provides better security visibility and control.
 */

const { supabaseAdmin } = require('../config/supabase');
const crypto = require('crypto');

class SessionManager {
  constructor() {
    this.useDatabase = true;
  }

  /**
   * Hash token for storage
   * @param {string} token - JWT token
   * @returns {string} - SHA-256 hash
   */
  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Create a new session
   * @param {string} userId - User ID
   * @param {string} token - JWT token
   * @param {string} ip - IP address
   * @param {string} userAgent - User agent
   * @returns {Promise<{success: boolean, sessionId?: string}>}
   */
  async createSession(userId, token, ip, userAgent) {
    try {
      if (!userId || !token) {
        return { success: false, error: 'User ID and token required' };
      }

      const tokenHash = this.hashToken(token);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

      if (this.useDatabase) {
        try {
          const { data, error } = await supabaseAdmin
            .from('user_sessions')
            .insert({
              user_id: userId,
              token_hash: tokenHash,
              ip_address: ip,
              user_agent: userAgent,
              expires_at: expiresAt,
              last_activity: new Date().toISOString()
            })
            .select('id')
            .single();

          if (error) {
            if (error.code === '42P01') { // Table doesn't exist
              console.warn('⚠️ user_sessions table not found. Run migration: create_user_sessions_table.sql');
              return { success: false, error: 'Sessions table not found' };
            }
            console.error('❌ Error creating session:', error);
            return { success: false, error: error.message };
          }

          return { success: true, sessionId: data.id };
        } catch (dbError) {
          console.error('❌ Database error creating session:', dbError);
          return { success: false, error: dbError.message };
        }
      }

      return { success: false, error: 'Database not available' };
    } catch (error) {
      console.error('❌ Error creating session:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all active sessions for a user
   * @param {string} userId - User ID
   * @returns {Promise<{sessions: Array, error: Error|null}>}
   */
  async getUserSessions(userId) {
    try {
      if (!userId) {
        return { 
          sessions: null, 
          error: new Error('Missing required parameter: userId') 
        };
      }

      if (this.useDatabase) {
        try {
          const { data, error } = await supabaseAdmin
            .from('user_sessions')
            .select('id, user_id, expires_at, last_activity, created_at, ip_address, user_agent')
            .eq('user_id', userId)
            .gt('expires_at', new Date().toISOString())
            .order('last_activity', { ascending: false });

          if (error) {
            if (error.code === '42P01') {
              // Table doesn't exist - return empty with no error
              return { sessions: [], error: null };
            }
            console.error('❌ Error getting user sessions:', error);
            return { sessions: [], error };
          }

          return { sessions: data || [], error: null };
        } catch (dbError) {
          console.error('❌ Database error getting sessions:', dbError);
          return { sessions: [], error: dbError };
        }
      }

      return { sessions: [], error: null };
    } catch (error) {
      console.error('❌ Error getting user sessions:', error);
      return { sessions: [], error };
    }
  }

  /**
   * Revoke a specific session
   * @param {string} sessionId - Session ID
   * @param {string} userId - User ID (for verification)
   * @returns {Promise<{success: boolean}>}
   */
  async revokeSession(sessionId, userId) {
    try {
      if (!sessionId || !userId) {
        return { success: false, error: 'Session ID and User ID required' };
      }

      if (this.useDatabase) {
        try {
          const { data: deletedRows, error } = await supabaseAdmin
            .from('user_sessions')
            .delete()
            .eq('id', sessionId)
            .eq('user_id', userId) // Verify ownership
            .select('id');

          if (error) {
            if (error.code === '42P01') {
              return { success: false, error: 'Sessions table not found' };
            }
            console.error('❌ Error revoking session:', error);
            return { success: false, error: error.message };
          }

          if (!deletedRows || deletedRows.length === 0) {
            return { success: false, error: 'Session not found or not owned by user' };
          }

          return { success: true };
        } catch (dbError) {
          console.error('❌ Database error revoking session:', dbError);
          return { success: false, error: dbError.message };
        }
      }

      return { success: false, error: 'Database not available' };
    } catch (error) {
      console.error('❌ Error revoking session:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Revoke all sessions for a user
   * @param {string} userId - User ID
   * @returns {Promise<{success: boolean}>}
   */
  async revokeAllUserSessions(userId) {
    try {
      if (!userId) {
        return { success: false, error: 'User ID required' };
      }

      if (this.useDatabase) {
        try {
          const { error } = await supabaseAdmin
            .from('user_sessions')
            .delete()
            .eq('user_id', userId);

          if (error) {
            if (error.code === '42P01') {
              return { success: false, error: 'Sessions table not found' };
            }
            console.error('❌ Error revoking all sessions:', error);
            return { success: false, error: error.message };
          }

          return { success: true };
        } catch (dbError) {
          console.error('❌ Database error revoking all sessions:', dbError);
          return { success: false, error: dbError.message };
        }
      }

      return { success: false, error: 'Database not available' };
    } catch (error) {
      console.error('❌ Error revoking all sessions:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Revoke all sessions except the one matching the current token
   * Uses token_hash internally (never exposed)
   * @param {string} userId - User ID
   * @param {string} currentToken - JWT of the session to keep
   * @returns {Promise<{success: boolean, revokedCount?: number}>}
   */
  async revokeOtherSessions(userId, currentToken) {
    if (!userId || !currentToken) {
      return { success: false, error: 'User ID and token required' };
    }
    
    if (!this.useDatabase) {
      return { success: false, error: 'Database not available' };
    }
    
    const currentHash = this.hashToken(currentToken);
    try {
      // Use single DELETE query instead of N+1 pattern
      const { data: deletedRows, error } = await supabaseAdmin
        .from('user_sessions')
        .delete()
        .eq('user_id', userId)
        .neq('token_hash', currentHash)
        .gt('expires_at', new Date().toISOString())
        .select('id');

      if (error) {
        if (error.code === '42P01') {
          return { success: false, error: 'Sessions table not found' };
        }
        console.error('❌ Error revoking other sessions:', error);
        return { success: false, error: error.message };
      }
      
      const revokedCount = deletedRows?.length || 0;
      return { success: true, revokedCount };
    } catch (e) {
      console.error('❌ Error in revokeOtherSessions:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Update session last activity
   * @param {string} token - JWT token
   * @returns {Promise<void>}
   */
  async updateSessionActivity(token) {
    try {
      if (!token) return;

      const tokenHash = this.hashToken(token);

      if (this.useDatabase) {
        try {
          await supabaseAdmin
            .from('user_sessions')
            .update({ last_activity: new Date().toISOString() })
            .eq('token_hash', tokenHash);
        } catch (dbError) {
          // Log error instead of silently failing
          console.debug('Failed updating session activity:', dbError.message || dbError);
        }
      }
    } catch (error) {
      // Log error instead of silently failing
      console.debug('Failed updating session activity (hashing error):', error.message || error);
    }
  }
}

// Singleton instance
const sessionManager = new SessionManager();

module.exports = sessionManager;


/**
 * Session Management Routes
 * 
 * Allows users to view and manage their active sessions
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const sessionManager = require('../utils/sessionManager');

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/sessions
 * Get all active sessions for the current user
 */
router.get('/', async (req, res) => {
  try {
    const { sessions, error } = await sessionManager.getUserSessions(req.user.id);
    
    // Handle errors from getUserSessions
    if (error) {
      console.error('Error getting sessions:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve sessions'
      });
    }
    
    // Remove sensitive data (token_hash)
    const sanitizedSessions = (sessions || []).map(session => ({
      id: session.id,
      ip_address: session.ip_address,
      user_agent: session.user_agent,
      last_activity: session.last_activity,
      created_at: session.created_at,
      expires_at: session.expires_at
    }));

    res.json({
      success: true,
      data: {
        sessions: sanitizedSessions,
        count: sanitizedSessions.length
      }
    });
  } catch (error) {
    console.error('Error getting sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve sessions'
    });
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * Revoke a specific session
 */
router.delete('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await sessionManager.revokeSession(sessionId, req.user.id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || 'Failed to revoke session'
      });
    }

    res.json({
      success: true,
      message: 'Session revoked successfully'
    });
  } catch (error) {
    console.error('Error revoking session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to revoke session'
    });
  }
});

/**
 * DELETE /api/sessions
 * Revoke all sessions for the current user (except current)
 */
router.delete('/', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        error: 'Authorization token is required' 
      });
    }

    // Always use revokeOtherSessions when token is present (preserves current session)
    const result = await sessionManager.revokeOtherSessions(req.user.id, token);
    
    if (!result.success) {
      return res.status(500).json({ 
        success: false, 
        error: result.error || 'Failed to revoke sessions' 
      });
    }

    res.json({
      success: true,
      message: 'Other sessions revoked',
      revokedCount: result.revokedCount || 0
    });
  } catch (error) {
    console.error('Error revoking all sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to revoke sessions'
    });
  }
});

module.exports = router;

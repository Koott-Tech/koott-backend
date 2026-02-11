const express = require('express');
const router = express.Router();
const securityNotifications = require('../utils/securityNotifications');
const securityMonitor = require('../utils/securityMonitor');
// Note: Bot detection moved to Cloudflare - stats endpoint kept for backward compatibility
let advancedBotDetector = null;
try {
  advancedBotDetector = require('../utils/advancedBotDetector');
} catch (e) {
  // Only treat MODULE_NOT_FOUND as optional, rethrow other errors
  if (e.code === 'MODULE_NOT_FOUND' || e.code === 'ERR_MODULE_NOT_FOUND') {
    // Bot detector not available - Cloudflare handles bot detection now
  } else {
    // Unexpected error (syntax, runtime, etc.) - log and rethrow
    console.error('❌ Unexpected error loading advancedBotDetector:', e);
    throw e;
  }
}
const { authenticateToken, requireAdmin } = require('../middleware/auth');


// Get security alerts for admin dashboard
router.get('/alerts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { limit = 50, severity, acknowledged } = req.query;
    
    let alerts = securityNotifications.getAlerts(parseInt(limit));
    
    // Filter by severity if specified
    if (severity) {
      alerts = alerts.filter(alert => alert.severity === severity);
    }
    
    // Filter by acknowledgment status if specified
    if (acknowledged !== undefined) {
      const isAcknowledged = acknowledged === 'true';
      alerts = alerts.filter(alert => alert.acknowledged === isAcknowledged);
    }
    
    res.json({
      success: true,
      data: {
        alerts,
        total: alerts.length,
        filters: { limit, severity, acknowledged }
      }
    });
  } catch (error) {
    console.error('Error fetching security alerts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch security alerts'
    });
  }
});

// Get security statistics
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const securityStats = securityNotifications.getSecurityStats();
    const monitorStats = securityMonitor.getSecuritySummary();
    // Bot detection now handled by Cloudflare - return empty stats or note
    const botStats = advancedBotDetector ? advancedBotDetector.getStats() : {
      note: 'Bot detection handled by Cloudflare at the edge',
      blocked: 0,
      detected: 0
    };
    
    res.json({
      success: true,
      data: {
        alerts: securityStats,
        monitoring: monitorStats,
        botDetection: botStats,
        note: 'Bot detection is now handled by Cloudflare. Check Cloudflare dashboard for bot statistics.',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching security stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch security statistics'
    });
  }
});

// Acknowledge security alert
router.post('/alerts/:alertId/acknowledge', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { alertId } = req.params;
    const adminId = req.user.id;
    
    securityNotifications.acknowledgeAlert(alertId, adminId);
    
    res.json({
      success: true,
      message: 'Alert acknowledged successfully'
    });
  } catch (error) {
    console.error('Error acknowledging alert:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to acknowledge alert'
    });
  }
});

// Get real-time security status
router.get('/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const recentAlerts = securityNotifications.getAlerts(10);
    const stats = securityNotifications.getSecurityStats();
    
    res.json({
      success: true,
      data: {
        recentAlerts,
        stats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching security status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch security status'
    });
  }
});

// Update notification settings
router.post('/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { settings } = req.body;
    
    securityNotifications.updateNotificationSettings(settings);
    
    res.json({
      success: true,
      message: 'Notification settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating notification settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update notification settings'
    });
  }
});

// Get bot detection details
// Note: Bot detection is now handled by Cloudflare at the edge
router.get('/bot-detection', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const botStats = advancedBotDetector ? advancedBotDetector.getStats() : {
      note: 'Bot detection handled by Cloudflare',
      blocked: 0,
      detected: 0,
      recommendation: 'Check Cloudflare dashboard for bot statistics'
    };
    
    res.json({
      success: true,
      data: {
        statistics: botStats,
        note: 'Bot detection is now handled by Cloudflare at the edge. View bot statistics in Cloudflare dashboard.',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching bot detection details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bot detection details'
    });
  }
});

// Get security trends (for charts)
router.get('/trends', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    let trends = [];
    
    if (period === '24h') {
      trends = securityNotifications.getSecurityStats().recentTrends;
    } else if (period === '7d') {
      // Get daily trends for last 7 days
      const now = Date.now();
      for (let i = 6; i >= 0; i--) {
        const dayStart = now - (i * 24 * 60 * 60 * 1000);
        const dayEnd = dayStart + (24 * 60 * 60 * 1000);
        
        const dailyCount = securityNotifications.getAlerts(1000).filter(alert => {
          const alertTime = new Date(alert.timestamp).getTime();
          return alertTime >= dayStart && alertTime < dayEnd;
        }).length;
        
        trends.push({
          day: new Date(dayStart).toLocaleDateString(),
          count: dailyCount
        });
      }
    }
    
    res.json({
      success: true,
      data: {
        trends,
        period,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching security trends:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch security trends'
    });
  }
});

// Export security logs
router.get('/export', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { format = 'json', limit = 1000 } = req.query;
    
    const alerts = securityNotifications.getAlerts(parseInt(limit));
    
    if (format === 'csv') {
      // Convert to CSV format
      const csvHeaders = 'ID,Type,Severity,Timestamp,IP,User Agent,Confidence,Reasons,Action,Status,Acknowledged\n';
      const csvRows = alerts.map(alert => {
        return [
          alert.id,
          alert.type,
          alert.severity,
          alert.timestamp,
          alert.data.ip || '',
          (alert.data.userAgent || '').replace(/,/g, ';'),
          alert.data.confidence || '',
          (alert.data.reasons || []).join(';'),
          alert.data.action || '',
          alert.status,
          alert.acknowledged
        ].join(',');
      }).join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=security-alerts.csv');
      res.send(csvHeaders + csvRows);
    } else {
      // JSON format
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=security-alerts.json');
      res.json({
        success: true,
        data: alerts,
        exportedAt: new Date().toISOString(),
        total: alerts.length
      });
    }
  } catch (error) {
    console.error('Error exporting security logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export security logs'
    });
  }
});

module.exports = router;

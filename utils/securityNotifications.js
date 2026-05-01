const EventEmitter = require('events');
const nodemailer = require('nodemailer');

class SecurityNotificationSystem extends EventEmitter {
  constructor() {
    super();
    this.alerts = [];
    this.adminSubscribers = new Set();
    this.notificationSettings = {
      email: {
        enabled: true,
        criticalThreshold: 70, // Notify for attacks >70% confidence
        frequency: 'immediate' // immediate, hourly, daily
      },
      dashboard: {
        enabled: true,
        realTimeUpdates: true,
        maxAlerts: 100
      },
      sms: {
        enabled: false, // Enable if you have SMS service
        criticalThreshold: 90
      }
    };
    
    this.setupEmailTransporter();
    this.startCleanupInterval();
  }

  // Setup email transporter for notifications
  setupEmailTransporter() {
    this.emailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: process.env.SMTP_PORT || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }

  // Add admin subscriber for real-time notifications
  addAdminSubscriber(adminId, socketId) {
    this.adminSubscribers.add({ adminId, socketId, timestamp: Date.now() });
    console.log(`📧 Admin ${adminId} subscribed to security notifications`);
  }

  // Remove admin subscriber
  removeAdminSubscriber(socketId) {
    for (const subscriber of this.adminSubscribers) {
      if (subscriber.socketId === socketId) {
        this.adminSubscribers.delete(subscriber);
        console.log(`📧 Admin ${subscriber.adminId} unsubscribed from security notifications`);
        break;
      }
    }
  }

  // Create security alert
  createAlert(type, severity, data) {
    const alert = {
      id: Date.now() + Math.random(),
      type,
      severity, // low, medium, high, critical
      timestamp: new Date().toISOString(),
      data,
      status: 'active',
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null
    };

    this.alerts.unshift(alert);
    
    // Keep only last 100 alerts
    if (this.alerts.length > this.notificationSettings.dashboard.maxAlerts) {
      this.alerts = this.alerts.slice(0, this.notificationSettings.dashboard.maxAlerts);
    }

    console.log(`🚨 Security Alert Created: ${type} (${severity})`);
    
    // Emit real-time notification
    this.emit('securityAlert', alert);
    
    // Send notifications based on severity
    this.handleNotification(alert);
    
    return alert;
  }

  // Handle different types of notifications
  handleNotification(alert) {
    // Real-time dashboard updates
    if (this.notificationSettings.dashboard.enabled) {
      this.sendRealTimeNotification(alert);
    }

    // Email notifications for critical/high severity
    if (this.notificationSettings.email.enabled && 
        (alert.severity === 'critical' || alert.severity === 'high')) {
      this.sendEmailNotification(alert);
    }

    // SMS notifications for critical attacks
    if (this.notificationSettings.sms.enabled && 
        alert.severity === 'critical') {
      this.sendSMSNotification(alert);
    }
  }

  // Send real-time notification to admin dashboard
  sendRealTimeNotification(alert) {
    const notification = {
      type: 'security_alert',
      alert,
      timestamp: new Date().toISOString()
    };

    // Send to all subscribed admins
    this.adminSubscribers.forEach(subscriber => {
      // This would integrate with Socket.IO in a real implementation
      console.log(`📡 Sending real-time alert to admin ${subscriber.adminId}:`, alert.type);
    });

    this.emit('realTimeAlert', notification);
  }

  // Send email notification
  async sendEmailNotification(alert) {
    try {
      const adminEmails = await this.getAdminEmails();
      
      const mailOptions = {
        from: process.env.SMTP_USER,
        to: adminEmails.join(', '),
        subject: `🚨 Security Alert: ${alert.type} - ${alert.severity.toUpperCase()}`,
        html: this.generateEmailTemplate(alert)
      };

      await this.emailTransporter.sendMail(mailOptions);
      console.log(`📧 Security alert email sent to admins: ${alert.type}`);
    } catch (error) {
      console.error('Failed to send security alert email:', error);
    }
  }

  // Send SMS notification (placeholder - integrate with SMS service)
  async sendSMSNotification(alert) {
    try {
      const adminPhones = await this.getAdminPhones();
      
      const message = `🚨 CRITICAL SECURITY ALERT: ${alert.type} detected at ${new Date().toLocaleString()}. Check admin dashboard immediately.`;
      
      // Integrate with SMS service (Twilio, AWS SNS, etc.)
      console.log(`📱 SMS alert sent to admins: ${alert.type}`);
    } catch (error) {
      console.error('Failed to send SMS alert:', error);
    }
  }

  // Generate email template
  generateEmailTemplate(alert) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .header { background: ${this.getSeverityColor(alert.severity)}; color: white; padding: 20px; text-align: center; }
          .content { padding: 30px; }
          .alert-details { background: #f8f9fa; padding: 20px; border-radius: 6px; margin: 20px 0; }
          .detail-row { display: flex; justify-content: space-between; margin: 10px 0; padding: 8px 0; border-bottom: 1px solid #eee; }
          .detail-label { font-weight: bold; color: #333; }
          .detail-value { color: #666; }
          .actions { margin-top: 30px; text-align: center; }
          .btn { display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 6px; margin: 0 10px; }
          .btn-danger { background: #dc3545; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚨 Security Alert</h1>
            <h2>${alert.type.replace(/_/g, ' ').toUpperCase()}</h2>
            <p>Severity: ${alert.severity.toUpperCase()}</p>
          </div>
          
          <div class="content">
            <div class="alert-details">
              <h3>Alert Details</h3>
              <div class="detail-row">
                <span class="detail-label">Type:</span>
                <span class="detail-value">${alert.type}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Severity:</span>
                <span class="detail-value">${alert.severity}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Timestamp:</span>
                <span class="detail-value">${new Date(alert.timestamp).toLocaleString()}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Status:</span>
                <span class="detail-value">${alert.status}</span>
              </div>
            </div>

            <div class="alert-details">
              <h3>Attack Details</h3>
              ${this.generateAttackDetails(alert.data)}
            </div>

            <div class="actions">
              <a href="${process.env.SITE_URL || process.env.CLIENT_SITE_URL || 'https://www.koott.in'}/admin/security" class="btn">View Dashboard</a>
              <a href="${process.env.SITE_URL || process.env.CLIENT_SITE_URL || 'https://www.koott.in'}/admin/security/alerts" class="btn btn-danger">Manage Alerts</a>
            </div>
          </div>

          <div class="footer">
            <p>This is an automated security alert from Koott Security System.</p>
            <p>Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  // Generate attack details HTML
  generateAttackDetails(data) {
    let html = '';
    
    if (data.ip) {
      html += `<div class="detail-row"><span class="detail-label">IP Address:</span><span class="detail-value">${data.ip}</span></div>`;
    }
    
    if (data.userAgent) {
      html += `<div class="detail-row"><span class="detail-label">User Agent:</span><span class="detail-value">${data.userAgent}</span></div>`;
    }
    
    if (data.confidence) {
      html += `<div class="detail-row"><span class="detail-label">Confidence:</span><span class="detail-value">${data.confidence}%</span></div>`;
    }
    
    if (data.reasons && data.reasons.length > 0) {
      html += `<div class="detail-row"><span class="detail-label">Detection Reasons:</span><span class="detail-value">${data.reasons.join(', ')}</span></div>`;
    }
    
    if (data.url) {
      html += `<div class="detail-row"><span class="detail-label">Target URL:</span><span class="detail-value">${data.url}</span></div>`;
    }
    
    if (data.method) {
      html += `<div class="detail-row"><span class="detail-label">Method:</span><span class="detail-value">${data.method}</span></div>`;
    }

    return html || '<p>No additional details available.</p>';
  }

  // Get severity color
  getSeverityColor(severity) {
    const colors = {
      low: '#28a745',
      medium: '#ffc107',
      high: '#fd7e14',
      critical: '#dc3545'
    };
    return colors[severity] || '#6c757d';
  }

  // Get admin emails from database
  async getAdminEmails() {
    try {
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { supabaseAdmin } = require('../config/supabase');
      const { data: admins, error } = await supabaseAdmin
        .from('users')
        .select('email')
        .in('role', ['admin', 'superadmin']);

      if (error) throw error;
      return admins.map(admin => admin.email);
    } catch (error) {
      console.error('Failed to get admin emails:', error);
      return [process.env.ADMIN_EMAIL || 'admin@koott.com'];
    }
  }

  // Get admin phone numbers
  async getAdminPhones() {
    try {
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { supabaseAdmin } = require('../config/supabase');
      const { data: admins, error } = await supabaseAdmin
        .from('users')
        .select('phone_number')
        .in('role', ['admin', 'superadmin'])
        .not('phone_number', 'is', null);

      if (error) throw error;
      return admins.map(admin => admin.phone_number);
    } catch (error) {
      console.error('Failed to get admin phones:', error);
      return [];
    }
  }

  // Acknowledge alert
  acknowledgeAlert(alertId, adminId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedBy = adminId;
      alert.acknowledgedAt = new Date().toISOString();
      console.log(`✅ Alert ${alertId} acknowledged by admin ${adminId}`);
    }
  }

  // Get alerts for admin dashboard
  getAlerts(limit = 50, severity = null) {
    let filteredAlerts = this.alerts;
    
    if (severity) {
      filteredAlerts = this.alerts.filter(alert => alert.severity === severity);
    }
    
    return filteredAlerts.slice(0, limit);
  }

  // Get security statistics
  getSecurityStats() {
    const now = Date.now();
    const last24Hours = now - (24 * 60 * 60 * 1000);
    const lastHour = now - (60 * 60 * 1000);
    
    const recentAlerts = this.alerts.filter(alert => 
      new Date(alert.timestamp).getTime() > last24Hours
    );
    
    const hourlyAlerts = this.alerts.filter(alert => 
      new Date(alert.timestamp).getTime() > lastHour
    );

    return {
      totalAlerts: this.alerts.length,
      activeAlerts: this.alerts.filter(a => a.status === 'active').length,
      acknowledgedAlerts: this.alerts.filter(a => a.acknowledged).length,
      alertsLast24Hours: recentAlerts.length,
      alertsLastHour: hourlyAlerts.length,
      severityBreakdown: {
        low: this.alerts.filter(a => a.severity === 'low').length,
        medium: this.alerts.filter(a => a.severity === 'medium').length,
        high: this.alerts.filter(a => a.severity === 'high').length,
        critical: this.alerts.filter(a => a.severity === 'critical').length
      },
      typeBreakdown: this.getTypeBreakdown(),
      recentTrends: this.getRecentTrends()
    };
  }

  // Get type breakdown
  getTypeBreakdown() {
    const types = {};
    this.alerts.forEach(alert => {
      types[alert.type] = (types[alert.type] || 0) + 1;
    });
    return types;
  }

  // Get recent trends
  getRecentTrends() {
    const now = Date.now();
    const trends = [];
    
    for (let i = 23; i >= 0; i--) {
      const hourStart = now - (i * 60 * 60 * 1000);
      const hourEnd = hourStart + (60 * 60 * 1000);
      
      const hourlyCount = this.alerts.filter(alert => {
        const alertTime = new Date(alert.timestamp).getTime();
        return alertTime >= hourStart && alertTime < hourEnd;
      }).length;
      
      trends.push({
        hour: new Date(hourStart).getHours(),
        count: hourlyCount
      });
    }
    
    return trends;
  }

  // Cleanup old alerts
  startCleanupInterval() {
    setInterval(() => {
      const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      this.alerts = this.alerts.filter(alert => 
        new Date(alert.timestamp).getTime() > oneWeekAgo
      );
      console.log(`🧹 Cleaned up old security alerts. Current count: ${this.alerts.length}`);
    }, 24 * 60 * 60 * 1000); // Daily cleanup
  }

  // Update notification settings
  updateNotificationSettings(settings) {
    this.notificationSettings = { ...this.notificationSettings, ...settings };
    console.log('📧 Notification settings updated:', this.notificationSettings);
  }
}

// Create singleton instance
const securityNotifications = new SecurityNotificationSystem();

module.exports = securityNotifications;

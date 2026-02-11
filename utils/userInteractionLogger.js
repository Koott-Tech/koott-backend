// Use supabaseAdmin from config for consistency and RLS bypass
const { supabaseAdmin } = require('../config/supabase');
// Alias for storage operations (same client, just for clarity)
const supabase = supabaseAdmin;

const LOGS_BUCKET = 'logs';

/**
 * Safely serialize error objects, handling circular references
 * @param {*} error - Error object or any value
 * @returns {Object|null} Serializable error object or null
 */
function safeSerializeError(error) {
  if (!error) return null;
  if (typeof error !== 'object') return { message: String(error) };

  const seen = new WeakSet();
  const replacer = (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular Reference]';
      }
      seen.add(value);
    }
    return value;
  };

  try {
    return JSON.parse(JSON.stringify(error, replacer));
  } catch (e) {
    return {
      message: error.message || String(error),
      name: error.name,
      stack: error.stack ? error.stack.substring(0, 500) : undefined
    };
  }
}

/**
 * User Interaction Logger Service
 * Logs all user interactions to Supabase Storage in organized folders by user name
 */
class UserInteractionLogger {
  constructor() {
    this.initialized = false;
    this.bucketName = LOGS_BUCKET;
    this.writeQueues = new Map(); // Per-filePath queue for serializing writes
  }

  /**
   * Initialize Supabase Storage client and ensure bucket exists
   */
  async initialize() {
    if (this.initialized) return;

    try {
      // Check if bucket exists, create if it doesn't
      const { data: buckets, error: listError } = await supabase.storage.listBuckets();
      
      if (listError) {
        console.error('❌ Error listing buckets:', listError.message);
        this.initialized = false;
        return;
      }

      const bucketExists = buckets.some(bucket => bucket.name === this.bucketName);

      if (!bucketExists) {
        console.log(`📦 Creating bucket: ${this.bucketName}`);
        const { data, error: createError } = await supabase.storage.createBucket(this.bucketName, {
          public: false, // Private bucket
          fileSizeLimit: 10485760, // 10MB per file
          allowedMimeTypes: ['application/json']
        });

        if (createError) {
          console.error('❌ Error creating bucket:', createError.message);
          console.error('💡 Please create the bucket manually in Supabase Dashboard:');
          console.error(`   1. Go to Storage → Create bucket`);
          console.error(`   2. Name: ${this.bucketName}`);
          console.error(`   3. Make it private`);
          this.initialized = false;
          return;
        }

        console.log(`✅ Created bucket: ${this.bucketName}`);
      } else {
        console.log(`✅ Bucket exists: ${this.bucketName}`);
      }

      this.initialized = true;
      console.log('✅ User Interaction Logger initialized successfully');
    } catch (error) {
      console.error('❌ User Interaction Logger initialization failed:', error.message);
      this.initialized = false;
    }
  }

  /**
   * Get user email from client ID or user ID
   */
  async getUserEmail(userId, userRole = 'client') {
    try {
      if (userRole === 'client') {
        // Try to get email from clients table
        // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
        const { supabaseAdmin } = require('../config/supabase');
        const { data: client } = await supabaseAdmin
          .from('clients')
          .select('email, user_id')
          .eq('id', userId)
          .single();

        if (client && client.email) {
          return client.email;
        }

        // If client has user_id, try to get email from users table
        if (client && client.user_id) {
          const { data: user } = await supabaseAdmin
            .from('users')
            .select('email')
            .eq('id', client.user_id)
            .single();

          if (user && user.email) {
            return user.email;
          }
        }
      } else if (userRole === 'psychologist') {
        const { supabaseAdmin } = require('../config/supabase');
        const { data: psychologist } = await supabaseAdmin
          .from('psychologists')
          .select('email')
          .eq('id', userId)
          .single();

        if (psychologist && psychologist.email) {
          return psychologist.email;
        }
      } else {
        // For admin/superadmin, get from users table
        // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
        const { supabaseAdmin } = require('../config/supabase');
        const { data: user } = await supabaseAdmin
          .from('users')
          .select('email')
          .eq('id', userId)
          .single();

        if (user && user.email) {
          return user.email;
        }
      }

      // Fallback to user ID
      return `user_${userId}`;
    } catch (error) {
      console.error('Error getting user email:', error.message);
      return `user_${userId}`;
    }
  }

  /**
   * Get file path in bucket - NEW STRUCTURE: 1 folder per user, 1 file per user
   * Structure: logs/{hashed_identifier}/all_logs.json
   * Uses hashed identifier instead of email to avoid PII leakage
   */
  getFilePath(identifier) {
    // Caller must pass already-hashed identifier to avoid double-hashing
    return `logs/${String(identifier)}/all_logs.json`;
  }

  /**
   * Find existing log file in Supabase Storage
   * @param {string} identifier - Hashed identifier (not email)
   */
  async findExistingLogFile(identifier) {
    try {
      const filePath = this.getFilePath(identifier);
      const folderPath = filePath.split('/').slice(0, -1).join('/'); // Get folder path
      const fileName = filePath.split('/').pop(); // Get filename
      
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .list(folderPath);

      if (error) {
        // Folder doesn't exist yet
        return null;
      }

      // Check if file exists
      const existingFile = data.find(file => file.name === fileName);
      
      return existingFile ? filePath : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Log user interaction to Supabase Storage
   */
  async logInteraction({
    userId,
    userRole = 'client',
    action,
    status, // 'success' or 'failure'
    details = {},
    error = null
  }) {
    // Don't block if logging fails
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      if (!this.initialized) {
        console.warn('⚠️ User Interaction Logger not initialized, skipping log');
        return;
      }

      // Get user email (for internal use only, will be hashed for file path)
      const userEmail = await this.getUserEmail(userId, userRole);
      
      // Use hashed identifier for file path (avoid PII leakage)
      const crypto = require('crypto');
      const hashedIdentifier = crypto.createHash('sha256').update(String(userEmail || userId)).digest('hex').substring(0, 16);

      // Create detailed log entry with backend-style logging
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        userId, // Keep userId for reference, but don't use email in path
        userRole,
        action,
        status,
        details: {
          ...details,
          // Add detailed error information if present
          errorDetails: error ? {
            message: error.message || String(error),
            stack: error.stack,
            code: error.code,
            name: error.name,
          // Include full error object for debugging (safely serialized)
          fullError: safeSerializeError(error)
          } : null,
          // Add failure reason if status is failure
          failureReason: status === 'failure' && error 
            ? (error.message || error.reason || String(error))
            : null
        },
        // Keep error at top level for backward compatibility
        error: error ? {
          message: error.message || String(error),
          stack: error.stack,
          code: error.code,
          name: error.name
        } : null
      };

      // Get file path: logs/{hashed_identifier}/all_logs.json
      const filePath = this.getFilePath(hashedIdentifier);
      const folderPath = filePath.split('/').slice(0, -1).join('/'); // Get folder path

      // Check if file exists (append to it) or create new (use hashed identifier)
      const existingFilePath = await this.findExistingLogFile(hashedIdentifier);
      const targetPath = existingFilePath || filePath;
      
      // Serialize writes per target path to prevent race conditions
      if (!this.writeQueues.has(targetPath)) {
        this.writeQueues.set(targetPath, Promise.resolve());
      }

      // Enqueue this write operation
      this.writeQueues.set(targetPath, this.writeQueues.get(targetPath).then(async () => {
        if (existingFilePath) {
          // Read existing file, append new log, write back
          const { data: fileData, error: downloadError } = await supabase.storage
            .from(this.bucketName)
            .download(existingFilePath);

          if (downloadError) {
            console.error('❌ Error downloading existing log file:', downloadError.message);
            // Create new file instead
            return this.createNewLogFile(filePath, logEntry, userEmail, action, status);
          } else {
            try {
              const fileText = await fileData.text();
              let logs = [];
              try {
                logs = JSON.parse(fileText);
                if (!Array.isArray(logs)) {
                  logs = [logs];
                }
              } catch (e) {
                logs = [];
              }

              // Sort logs by timestamp to maintain chronological order
              logs.push(logEntry);
              logs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

              // Update file
              const { error: uploadError } = await supabase.storage
                .from(this.bucketName)
                .update(existingFilePath, JSON.stringify(logs, null, 2), {
                  contentType: 'application/json',
                  upsert: true
                });

              if (uploadError) {
                console.error('❌ Error updating log file:', uploadError.message);
              } else {
                console.log(`✅ Logged ${action} (${status}) for user: ${hashedIdentifier} → ${filePath}`);
              }
              return;
            } catch (parseError) {
              console.error('❌ Error parsing existing log file:', parseError.message);
              // Fall through to create new file
              return this.createNewLogFile(filePath, logEntry, userEmail, action, status);
            }
          }
        } else {
          return this.createNewLogFile(filePath, logEntry, userEmail, action, status);
        }
      }).catch(err => {
        console.error('❌ Error in write queue for', targetPath, ':', err);
      }));

      // Wait for the write to complete
      await this.writeQueues.get(targetPath);
    } catch (error) {
      // Don't throw - logging failures shouldn't break the app
      console.error('❌ Error logging user interaction:', error.message);
    }
  }

  /**
   * Create a new log file
   * @param {string} filePath - File path in bucket
   * @param {Object} logEntry - Log entry object
   * @param {string} identifier - Hashed identifier (for logging)
   * @param {string} action - Action name (for logging)
   * @param {string} status - Status (for logging)
   * @returns {Promise<void>}
   */
  async createNewLogFile(filePath, logEntry, identifier, action, status) {
    try {
      const folderPath = filePath.split('/').slice(0, -1).join('/');
      
      // Ensure folder exists (create if needed)
      // Note: Supabase Storage doesn't require explicit folder creation
      
      // Create new file with single log entry
      const logs = [logEntry];
      const fileContent = JSON.stringify(logs, null, 2);
      
      const { error: uploadError } = await supabase.storage
        .from(this.bucketName)
        .upload(filePath, fileContent, {
          contentType: 'application/json',
          upsert: false // Don't overwrite if exists
        });

      if (uploadError) {
        console.error('❌ Error creating new log file:', uploadError.message);
      } else {
        console.log(`✅ Created new log file for ${identifier}: ${action} (${status}) → ${filePath}`);
      }
    } catch (error) {
      console.error('❌ Error in createNewLogFile:', error.message);
    }
  }

  /**
   * Log detailed booking flow with comprehensive information
   */
  async logBookingFlow({
    userId,
    userRole = 'client',
    step,
    status,
    data = {},
    error = null
  }) {
    await this.logInteraction({
      userId,
      userRole,
      action: `booking_flow_${step}`,
      status,
      details: {
        step,
        ...data
      },
      error
    });
  }

  /**
   * Log booking interaction
   */
  async logBooking({
    userId,
    userRole = 'client',
    psychologistId,
    packageId,
    scheduledDate,
    scheduledTime,
    price,
    status,
    error = null,
    sessionId = null,
    detailedFlow = null // Optional: include detailed flow data
  }) {
    const details = {
      psychologistId,
      packageId,
      scheduledDate,
      scheduledTime,
      price,
      sessionId
    };

    // If detailed flow data is provided, merge it into details
    if (detailedFlow && typeof detailedFlow === 'object') {
      // Merge all detailed flow data into details
      Object.keys(detailedFlow).forEach(key => {
        details[key] = detailedFlow[key];
      });
    }

    await this.logInteraction({
      userId,
      userRole,
      action: 'booking',
      status,
      details,
      error
    });
  }

  /**
   * Log package interaction
   */
  async logPackageInteraction({
    userId,
    userRole = 'client',
    packageId,
    packageType,
    action, // 'view', 'select', 'purchase'
    status,
    error = null,
    details = {}
  }) {
    await this.logInteraction({
      userId,
      userRole,
      action: `package_${action}`,
      status,
      details: {
        packageId,
        packageType,
        ...details
      },
      error
    });
  }

  /**
   * Log receipt generation/viewing
   */
  async logReceipt({
    userId,
    userRole = 'client',
    paymentId,
    sessionId,
    amount,
    status,
    error = null,
    action = 'view' // 'view', 'generate', 'download'
  }) {
    await this.logInteraction({
      userId,
      userRole,
      action: `receipt_${action}`,
      status,
      details: {
        paymentId,
        sessionId,
        amount
      },
      error
    });
  }

  /**
   * Log reschedule request
   */
  async logReschedule({
    userId,
    userRole = 'client',
    sessionId,
    oldDate,
    oldTime,
    newDate,
    newTime,
    status,
    error = null
  }) {
    await this.logInteraction({
      userId,
      userRole,
      action: 'reschedule',
      status,
      details: {
        sessionId,
        oldDate,
        oldTime,
        newDate,
        newTime
      },
      error
    });
  }

  /**
   * Log message interaction
   */
  async logMessage({
    userId,
    userRole = 'client',
    sessionId,
    action, // 'send', 'view', 'reply'
    status,
    error = null,
    messageId = null
  }) {
    await this.logInteraction({
      userId,
      userRole,
      action: `message_${action}`,
      status,
      details: {
        sessionId,
        messageId
      },
      error
    });
  }
}

const userInteractionLogger = new UserInteractionLogger();
module.exports = userInteractionLogger;

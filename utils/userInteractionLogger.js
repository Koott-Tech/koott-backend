// Use supabaseAdmin from config for consistency and RLS bypass
const { supabaseAdmin } = require('../config/supabase');
const supabase = supabaseAdmin;
const crypto = require('crypto');

/** Historical logs only. Nothing is written here any more — see logInteraction. */
const LOGS_BUCKET = 'logs';

/**
 * Keys whose VALUE must never reach the log, wherever they appear in the nested metadata.
 * Mirrors the allowlist in middleware/auditMiddleware so the two logs redact alike.
 */
const SENSITIVE_KEYS = new Set([
  'password', 'pass', 'passwd', 'pwd', 'password_hash', 'token', 'access_token', 'refresh_token',
  'id_token', 'api_key', 'apikey', 'secret', 'secret_key', 'ssn', 'social_security_number',
  'credit_card', 'card_number', 'cardnum', 'cvv', 'cvc', 'iban', 'routing_number',
  'bank_account', 'auth', 'authorization', 'cookie', 'session_token', 'otp', 'pin',
  // Clinical / message content: never logged.
  'notes', 'session_notes', 'summary', 'session_summary', 'report', 'feedback',
  'client_feedback', 'message', 'message_body', 'content', 'transcript',
]);

function isSensitiveKey(key) {
  const k = String(key || '').toLowerCase();
  if (SENSITIVE_KEYS.has(k)) return true;
  if (k.includes('password') || k.includes('secret') || k.includes('token')) return true;
  if (k.endsWith('_token') || k.includes('card') || k.includes('cvv')) return true;
  return false;
}

function truncate(value, max) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Recursively strip sensitive values and cap size. Metadata only: the goal is "what happened",
 * never "what was said". Depth- and breadth-capped so one oversized object cannot blow up a row.
 */
function redactForLog(value, depth = 0, seen = new WeakSet()) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === 'string') return truncate(value, 500);
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return String(t);

  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactForLog(v, depth + 1, seen));
  }

  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(value)) {
    if (count++ >= 50) {
      out['…'] = '[TRUNCATED]';
      break;
    }
    out[k] = isSensitiveKey(k) ? '[REDACTED]' : redactForLog(v, depth + 1, seen);
  }
  return out;
}

/**
 * User Interaction Logger Service
 * Logs all user interactions to Supabase Storage in organized folders by user name
 */
class UserInteractionLogger {
  constructor() {
    this.initialized = true; // nothing to set up: inserts go straight to Postgres
    this.bucketName = LOGS_BUCKET; // retained: historical logs still live in this bucket
    this.tableName = 'user_interaction_logs';
    this.tableMissingWarned = false;
  }

  /**
   * No-op. Kept because callers and tests may still await it.
   *
   * The previous implementation listed/created a Storage bucket on first use; the append-only
   * table is created by migration 20261003090000_user_interaction_logs.sql instead.
   */
  async initialize() {
    this.initialized = true;
  }

  /**
   * Stable, non-reversible id for a user. Derived from the user id alone — the previous
   * implementation hashed the EMAIL, which cost one or two extra database round-trips per
   * logged event purely to produce a hash.
   *
   * Note: because the input changed, these do not line up with the hashed folder names of the
   * pre-migration files in the `logs` bucket. New rows carry `user_id` directly, which is more
   * useful than the hash was; the old files remain readable on their own terms.
   */
  hashIdentifier(userId) {
    if (userId == null || String(userId) === '') return null;
    return crypto.createHash('sha256').update(String(userId)).digest('hex').substring(0, 16);
  }

  /**
   * Log a user interaction as a single append-only row.
   *
   * Previously this downloaded the user's entire all_logs.json from Storage, parsed it,
   * appended one entry, re-serialised the whole array pretty-printed and uploaded it again —
   * so the cost of recording one event grew without bound as a user's history grew. This is a
   * constant-cost insert.
   *
   * Never throws: logging must not be able to break a booking or a payment.
   */
  async logInteraction({
    userId,
    userRole = 'client',
    action,
    status, // 'success' or 'failure'
    details = {},
    error = null
  }) {
    try {
      const row = {
        hashed_identifier: this.hashIdentifier(userId),
        user_id: userId != null ? String(userId) : null,
        user_role: userRole || null,
        action: action || 'unknown',
        status: status || null,
        details: redactForLog(details),
        // Message and code only. Stack traces were the bulk of the old payload and routinely
        // carried request fragments into the log.
        error_message: error ? truncate(error.message || String(error), 500) : null,
        error_code: error && error.code != null ? truncate(String(error.code), 100) : null,
      };

      const { error: insertError } = await supabase.from(this.tableName).insert(row);

      if (insertError) {
        // Table not created yet (migration not applied) — say so once, then stay quiet.
        if (insertError.code === '42P01' || insertError.code === 'PGRST205') {
          if (!this.tableMissingWarned) {
            this.tableMissingWarned = true;
            console.warn(
              `⚠️ ${this.tableName} is missing — interaction logging is disabled. Apply supabase/migrations/20261003090000_user_interaction_logs.sql.`
            );
          }
          return;
        }
        console.error('❌ Error writing interaction log:', insertError.message);
      }
    } catch (err) {
      // Don't throw - logging failures shouldn't break the app
      console.error('❌ Error logging user interaction:', err.message);
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

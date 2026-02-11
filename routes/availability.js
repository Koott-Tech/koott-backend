const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const availabilityService = require('../utils/availabilityCalendarService');
const calendarSyncService = require('../services/calendarSyncService');
const { successResponse, errorResponse } = require('../utils/helpers');
const { globalCache } = require('../utils/cache');
const router = express.Router();

// Rate limiter for sync requests (prevent abuse of on-demand calendar sync)
const syncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 sync requests per 15 minutes per IP/psychologistId
  message: {
    error: 'Too many sync requests',
    message: 'Rate limit exceeded for calendar sync. Please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use IP + psychologistId for better tracking
    const psychologistId = req.params?.id || 'unknown';
    return `sync-${req.ip}-${psychologistId}`;
  },
  skip: (req) => {
    // Only apply to requests with sync parameter
    const sync = req.query?.sync;
    return sync !== '1' && sync !== 'true';
  }
});

/**
 * GET /api/availability/psychologist/:id
 * Get psychologist availability for a specific date
 */
router.get('/psychologist/:id', async (req, res, next) => {
  try {
    const { id: psychologistId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json(
        errorResponse('Date parameter is required (YYYY-MM-DD format)')
      );
    }

    console.log(`📅 Getting availability for psychologist ${psychologistId} on ${date}`);

    const availability = await availabilityService.getPsychologistAvailability(psychologistId, date);

    // Build response body
    const responseBody = successResponse({
      message: 'Availability retrieved successfully',
      data: availability
    });

    // Compute content-based ETag from response payload
    const responseString = JSON.stringify(responseBody);
    const etagHash = crypto.createHash('sha256').update(responseString).digest('hex');
    const etagQuoted = `"${etagHash}"`;

    const ifNoneMatch = req.get('If-None-Match');
    if (ifNoneMatch && (ifNoneMatch.trim() === etagQuoted || ifNoneMatch.trim() === etagHash)) {
      res.set({
        'Cache-Control': 'public, max-age=120, s-maxage=300',
        'ETag': etagQuoted
      });
      return res.status(304).end();
    }

    // Set cache headers (2 minutes browser cache, 5 minutes CDN)
    res.set({
      'Cache-Control': 'public, max-age=120, s-maxage=300',
      'ETag': etagQuoted
    });

    res.json(responseBody);

  } catch (error) {
    console.error('Error getting psychologist availability:', error);
    next(error);
  }
});

/**
 * GET /api/availability/psychologist/:id/range
 * Get psychologist availability for a date range
 * Optional: ?sync=1 will run a Google Calendar sync for this psychologist
 *           before computing availability, so external events are blocked in real-time.
 * NOTE: Use ?sync=1 sparingly (e.g. therapist profile page) as it triggers
 *       a Google Calendar API call and DB updates.
 */
router.get('/psychologist/:id/range', syncLimiter, async (req, res, next) => {
  try {
    const { id: psychologistId } = req.params;
    const { startDate, endDate, sync } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json(
        errorResponse('Both startDate and endDate parameters are required (YYYY-MM-DD format)')
      );
    }

    // Determine if this is a sync request
    const isSyncRequest = sync === '1' || sync === 'true';
    let syncSucceeded = false;

    // Create cache key (only for non-sync requests)
    const cacheKey = isSyncRequest 
      ? null // Don't cache sync requests
      : `availability-range-${psychologistId}-${startDate}-${endDate}`;

    // Check cache first (only if not syncing)
    if (!isSyncRequest && cacheKey) {
      const cached = globalCache.get(cacheKey);
      if (cached) {
        console.log(`📦 Cache hit for availability range: ${psychologistId} (${startDate} to ${endDate})`);
        // Compute content-based ETag from cached response
        const cachedString = JSON.stringify(cached);
        const etagHash = crypto.createHash('sha256').update(cachedString).digest('hex');
        // Set cache headers
        res.set({
          'Cache-Control': 'public, max-age=120, s-maxage=300',
          'ETag': `"${etagHash}"`,
          'X-Cache': 'HIT'
        });
        return res.json(cached);
      }
    }

    // Optionally run a real-time Google Calendar sync for this psychologist
    // when ?sync=1 or ?sync=true is passed (used by therapist profile page).
    // Rate limiting is applied via syncLimiter middleware above
    if (isSyncRequest) {
      try {
        console.log(`🔄 Running on-demand calendar sync for psychologist ${psychologistId} before availability range fetch`);
        await calendarSyncService.syncPsychologistById(psychologistId);
        syncSucceeded = true;
      } catch (syncError) {
        console.error(`⚠️ On-demand calendar sync failed for psychologist ${psychologistId}:`, syncError.message || syncError);
        // Do not fail the request if sync fails; fall back to last known DB state
      }
    }

    console.log(`📅 Getting availability range for psychologist ${psychologistId} from ${startDate} to ${endDate}`);

    const availability = await availabilityService.getPsychologistAvailabilityRange(
      psychologistId, 
      startDate, 
      endDate
    );

    const response = successResponse({
      message: 'Availability range retrieved successfully',
      data: availability
    });

    // Cache the response only for non-sync requests
    if (!isSyncRequest && cacheKey) {
      const cacheTTL = 10 * 60 * 1000; // 10 minutes for regular requests
      globalCache.set(cacheKey, response, cacheTTL);
      console.log(`💾 Cached availability range: ${psychologistId} (TTL: ${cacheTTL / 1000 / 60} minutes)`);
    } else if (isSyncRequest && syncSucceeded) {
      // Invalidate non-sync cache only when sync completed successfully
      const nonSyncCacheKey = `availability-range-${psychologistId}-${startDate}-${endDate}`;
      globalCache.delete(nonSyncCacheKey);
      console.log(`🗑️ Invalidated non-sync cache: ${nonSyncCacheKey}`);
    }

    // Compute content-based ETag from response payload
    const responseString = JSON.stringify(response);
    const etagHash = crypto.createHash('sha256').update(responseString).digest('hex');

    // Set cache headers (consistent for both sync and non-sync)
    res.set({
      'Cache-Control': 'public, max-age=120, s-maxage=300',
      'ETag': `"${etagHash}"`,
      'X-Cache': isSyncRequest ? 'SYNC' : 'MISS'
    });

    res.json(response);

  } catch (error) {
    console.error('Error getting psychologist availability range:', error);
    next(error);
  }
});

/**
 * GET /api/availability/psychologist/:id/check
 * Check if a specific time slot is available
 */
router.get('/psychologist/:id/check', async (req, res, next) => {
  try {
    const { id: psychologistId } = req.params;
    const { date, time } = req.query;

    if (!date || !time) {
      return res.status(400).json(
        errorResponse('Both date and time parameters are required')
      );
    }

    console.log(`🔍 Checking availability for psychologist ${psychologistId} on ${date} at ${time}`);

    const isAvailable = await availabilityService.isTimeSlotAvailable(psychologistId, date, time);

    // Build response body
    const responseBody = successResponse({
      message: 'Time slot availability checked successfully',
      data: {
        psychologistId,
        date,
        time,
        isAvailable
      }
    });

    // Compute content-based ETag from response payload
    const responseString = JSON.stringify(responseBody);
    const etagHash = crypto.createHash('sha256').update(responseString).digest('hex');

    // Set cache headers (private, short TTL - removed conflicting no-store)
    res.set({
      'Cache-Control': 'private, max-age=5',
      'ETag': `"${etagHash}"`
    });

    res.json(responseBody);

  } catch (error) {
    console.error('Error checking time slot availability:', error);
    next(error);
  }
});

/**
 * GET /api/availability/psychologist/:id/working-hours
 * Get psychologist working hours and preferences
 */
router.get('/psychologist/:id/working-hours', async (req, res, next) => {
  try {
    const { id: psychologistId } = req.params;

    console.log(`🕐 Getting working hours for psychologist ${psychologistId}`);

    const workingHours = await availabilityService.getPsychologistWorkingHours(psychologistId);

    res.json(
      successResponse({
        message: 'Working hours retrieved successfully',
        data: workingHours
      })
    );

  } catch (error) {
    console.error('Error getting psychologist working hours:', error);
    next(error);
  }
});

/**
 * GET /api/availability/public/psychologist/:id
 * Public endpoint to get psychologist availability (no authentication required)
 */
router.get('/public/psychologist/:id', async (req, res, next) => {
  try {
    const { id: psychologistId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json(
        errorResponse('Date parameter is required (YYYY-MM-DD format)')
      );
    }

    console.log(`📅 Getting public availability for psychologist ${psychologistId} on ${date}`);

    const availability = await availabilityService.getPsychologistAvailability(psychologistId, date);

    // Filter out sensitive information for public access
    const publicAvailability = {
      date: availability.date,
      psychologistId: availability.psychologistId,
      timeSlots: availability.timeSlots.map(slot => ({
        time: slot.time,
        available: slot.available,
        displayTime: slot.displayTime,
        reason: slot.available ? null : slot.reason
      })),
      totalSlots: availability.totalSlots,
      availableSlots: availability.availableSlots,
      blockedSlots: availability.blockedSlots
    };

    // Build response body
    const responseBody = successResponse({
      message: 'Public availability retrieved successfully',
      data: publicAvailability
    });

    // Compute content-based ETag from response payload
    const responseString = JSON.stringify(responseBody);
    const etagHash = crypto.createHash('sha256').update(responseString).digest('hex');

    // Set cache headers (2 minutes browser cache, 5 minutes CDN)
    res.set({
      'Cache-Control': 'public, max-age=120, s-maxage=300',
      'ETag': `"${etagHash}"`
    });

    res.json(responseBody);

  } catch (error) {
    console.error('Error getting public availability:', error);
    next(error);
  }
});

module.exports = router;

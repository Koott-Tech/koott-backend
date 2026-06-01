const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const emailService = require('../utils/emailService');

/** Normalize a phone number string. Accepts "+91 9876 543210", "9876543210" → "+919876543210". */
function normalizePhoneNumber(input) {
  if (!input) return null;
  const cleaned = String(input).trim().replace(/[\s\-().]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+')) return cleaned;
  if (/^\d{10}$/.test(cleaned)) return `+91${cleaned}`;
  return `+${cleaned}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKSHOP_NOTIFY_ALSO_E164 = '+918590576385';

function ok(res, data, message = 'OK', status = 200) {
  return res.status(status).json({ success: true, message, data });
}

function fail(res, error, status = 400) {
  return res.status(status).json({ success: false, error });
}

router.post('/workshop-register', async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const countryCode = String(req.body?.countryCode || '').trim();
    const phone = String(req.body?.phone || '').trim().replace(/\s+/g, '');
    const eventSlug = String(req.body?.eventSlug || 'Koott-summer-workshops-2026').trim();

    if (!fullName || fullName.length < 2) return fail(res, 'Please enter your full name.');
    if (!email || !EMAIL_RE.test(email)) return fail(res, 'Please enter a valid email address.');
    if (!countryCode) return fail(res, 'Please select a country code.');
    if (!phone || phone.length < 6) return fail(res, 'Please enter a valid phone number.');

    const { data: eventPage, error: pageError } = await supabaseAdmin
      .from('event_pages')
      .select('slug, cms_data')
      .eq('slug', eventSlug)
      .maybeSingle();

    if (pageError) {
      console.error('[events/workshop-register] event_pages lookup:', pageError);
      return fail(res, 'Could not load this event. Please try again later.', 503);
    }
    if (!eventPage) return fail(res, 'Event not found.', 404);

    const cms = eventPage.cms_data || {};
    const sessionJoinUrl = String(cms.sessionJoinUrl || '').trim();
    if (!sessionJoinUrl) {
      return fail(
        res,
        'Registration is not available for this event yet (session link missing). Please contact support or try again later.',
        503
      );
    }

    const eventTitle =
      String(cms?.sessionBanner?.title || '').trim() ||
      String(cms?.hero?.title || '').trim() ||
      eventSlug.replace(/-/g, ' ');

    const registrantWhatsApp = normalizePhoneNumber(`${countryCode}${phone}`) || null;

    const insertPayload = {
      event_slug: eventSlug,
      event_title: eventTitle,
      full_name: fullName,
      email,
      country_code: countryCode,
      phone,
      whatsapp_e164: registrantWhatsApp,
      session_join_url: sessionJoinUrl,
    };

    let { error: dbError } = await supabaseAdmin.from('event_registrations').insert(insertPayload);
    if (dbError && String(dbError.message || '').includes('session_join_url')) {
      // Backward compatibility if column wasn't migrated yet.
      const fallback = { ...insertPayload };
      delete fallback.session_join_url;
      const retry = await supabaseAdmin.from('event_registrations').insert(fallback);
      dbError = retry.error || null;
    }

    if (dbError) {
      const code = dbError.code || '';
      const msg = dbError.message || '';
      if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
        return fail(res, 'This email is already registered for this event.', 409);
      }
      if (msg.includes('does not exist') || msg.includes('schema cache')) {
        return fail(res, 'Registration is temporarily unavailable. Please try again later or contact support.', 503);
      }
      console.error('[events/workshop-register] insert error:', dbError);
      return fail(res, 'Could not save your registration. Please try again.', 500);
    }

    // Respond immediately after DB success so UI can show instant success popup.
    ok(res, null, "Thank you — we've received your registration.");

    // Send notifications in background; failures here never affect registration result.
    setImmediate(async () => {
      try {
        const recipients = new Set([WORKSHOP_NOTIFY_ALSO_E164]);
        const envNotify = String(
          process.env.WORKSHOP_REGISTRATION_NOTIFY_PHONE || process.env.OPERATIONS_WHATSAPP_NUMBER || ''
        ).trim();
        if (envNotify) recipients.add(envNotify.startsWith('+') ? envNotify : `+${envNotify}`);

        const internalMsg = [
          'New workshop registration',
          '',
          `Event: ${eventTitle}`,
          `Name: ${fullName}`,
          `Email: ${email}`,
          registrantWhatsApp ? `WhatsApp: ${registrantWhatsApp}` : null,
          `Submitted (UTC): ${new Date().toISOString()}`,
        ]
          .filter(Boolean)
          .join('\n');

        // Workshop registration WhatsApp notifications disabled — confirmation email below
        // covers the registrant. Internal team notification needs a dedicated Interakt template
        // (or use email/Slack instead).
        void recipients; void internalMsg; void registrantWhatsApp;

        try {
          await emailService.sendEventRegistrationConfirmation({
            to: email,
            fullName,
            eventTitle,
            sessionJoinUrl,
          });
        } catch (e) {
          console.warn('[events/workshop-register] confirmation email failed:', e?.message || e);
        }
      } catch (notifyError) {
        console.error('[events/workshop-register] background notify fatal:', notifyError);
      }
    });
    return;
  } catch (e) {
    console.error('[events/workshop-register] fatal:', e);
    return fail(res, 'Something went wrong. Please try again.', 500);
  }
});

module.exports = router;

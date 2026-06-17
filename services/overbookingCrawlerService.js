/**
 * Daily Overbooking Crawler
 * ---------------------------------------------------------------------------
 * Runs once a day (early morning IST) and scans EVERY therapist for same-slot
 * double-bookings across all future dates. A slot is "overbooked" when 2+ ACTIVE
 * sessions share the same psychologist_id + scheduled_date + scheduled_time.
 *
 * It emails a report to OVERBOOKING_ALERT_EMAIL (default koottfordeveloper@gmail.com)
 * ONLY when at least one overbooking is found. If everything is clean, no email is
 * sent (silent success).
 */

const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const emailService = require('../utils/emailService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const ALERT_EMAIL = process.env.OVERBOOKING_ALERT_EMAIL || 'koottfordeveloper@gmail.com';
const ACTIVE_STATUSES = ['booked', 'rescheduled', 'reschedule_requested', 'confirmed', 'scheduled', 'upcoming'];

class OverbookingCrawlerService {
  constructor() {
    this.isRunning = false;
  }

  /**
   * Start the daily crawler. Runs at 05:30 AM IST every day.
   * Cron runs in the server's local timezone; we schedule with an explicit
   * Asia/Kolkata timezone so it fires at 05:30 IST regardless of host TZ.
   */
  start() {
    console.log('🕷️  Starting Daily Overbooking Crawler...');
    cron.schedule('30 5 * * *', async () => {
      await this.run();
    }, { timezone: 'Asia/Kolkata' });
    console.log(`✅ Overbooking Crawler scheduled (daily 05:30 IST → alerts to ${ALERT_EMAIL})`);
  }

  /**
   * Scan all therapists for future same-slot double-bookings.
   * @returns {Promise<Array>} list of clash groups (each is an array of sessions)
   */
  async findOverbookings() {
    const today = dayjs().tz('Asia/Kolkata').format('YYYY-MM-DD');

    const { data: sessions, error } = await supabaseAdmin
      .from('sessions')
      .select('id, client_id, psychologist_id, scheduled_date, scheduled_time, status, source')
      .gte('scheduled_date', today)
      .in('status', ACTIVE_STATUSES)
      .not('psychologist_id', 'is', null)
      .not('scheduled_time', 'is', null);

    if (error) {
      throw new Error(`Overbooking query failed: ${error.message}`);
    }

    const groups = new Map();
    for (const s of sessions || []) {
      const key = `${s.psychologist_id}|${s.scheduled_date}|${s.scheduled_time}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const clashes = [...groups.values()].filter((g) => g.length > 1);
    // Sort chronologically for a readable report
    clashes.sort((a, b) =>
      (a[0].scheduled_date + a[0].scheduled_time).localeCompare(b[0].scheduled_date + b[0].scheduled_time)
    );
    return { clashes, scanned: (sessions || []).length };
  }

  /**
   * Resolve psychologist + client names/contacts for the clashing rows.
   */
  async hydrate(clashes) {
    const flat = clashes.flat();
    const psychIds = [...new Set(flat.map((s) => s.psychologist_id).filter(Boolean))];
    const clientIds = [...new Set(flat.map((s) => s.client_id).filter(Boolean))];

    const [{ data: psychs }, { data: clients }] = await Promise.all([
      psychIds.length
        ? supabaseAdmin.from('psychologists').select('id, first_name, last_name, email').in('id', psychIds)
        : Promise.resolve({ data: [] }),
      clientIds.length
        ? supabaseAdmin.from('clients').select('id, first_name, last_name, phone_number, user:users(email)').in('id', clientIds)
        : Promise.resolve({ data: [] }),
    ]);

    const pMap = new Map((psychs || []).map((p) => [p.id, p]));
    const cMap = new Map((clients || []).map((c) => [c.id, c]));
    return { pMap, cMap };
  }

  buildEmailHtml(clashes, pMap, cMap, scanned) {
    const fmtPsych = (id) => {
      const p = pMap.get(id);
      return p ? `${[p.first_name, p.last_name].filter(Boolean).join(' ')}${p.email ? ` &lt;${p.email}&gt;` : ''}` : id;
    };
    const fmtClient = (s) => {
      const c = cMap.get(s.client_id);
      if (!c) return '(no client)';
      const email = Array.isArray(c.user) ? c.user?.[0]?.email : c.user?.email;
      return `${[c.first_name, c.last_name].filter(Boolean).join(' ')}${c.phone_number ? ` · ${c.phone_number}` : ''}${email ? ` · ${email}` : ''}`;
    };

    const blocks = clashes.map((g, i) => {
      const { psychologist_id, scheduled_date, scheduled_time } = g[0];
      const rows = g.map((s) => `
        <li style="margin:4px 0;">
          <strong>${fmtClient(s)}</strong>
          <span style="color:#6b7280;"> — status: ${s.status} · source: ${s.source || '-'} · session: ${s.id}</span>
        </li>`).join('');
      return `
        <div style="margin:0 0 18px 0;padding:14px 16px;border:1px solid #fecaca;background:#fef2f2;border-radius:10px;">
          <div style="font-weight:700;color:#b91c1c;">#${i + 1} · ${fmtPsych(psychologist_id)}</div>
          <div style="color:#111827;margin:2px 0 8px 0;">${scheduled_date} at ${scheduled_time} — <strong>${g.length} overlapping sessions</strong></div>
          <ul style="margin:0;padding-left:18px;color:#111827;">${rows}</ul>
        </div>`;
    }).join('');

    return `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;">
        <h2 style="color:#b91c1c;margin:0 0 6px 0;">🚨 Overbooking Alert — ${clashes.length} slot(s) double-booked</h2>
        <p style="color:#6b7280;margin:0 0 16px 0;">
          Daily crawler scanned ${scanned} active future sessions on
          ${dayjs().tz('Asia/Kolkata').format('DD MMM YYYY, HH:mm')} IST and found the following clashes:
        </p>
        ${blocks}
        <p style="color:#9ca3af;font-size:12px;margin-top:18px;">
          A slot is flagged when 2+ active sessions share the same therapist, date and time.
          This is an automated message from the Koott overbooking crawler.
        </p>
      </div>`;
  }

  /**
   * Run the crawl once. Sends an email only if overbookings are found.
   */
  async run() {
    if (this.isRunning) {
      console.log('⏭️  Overbooking crawler already running, skipping...');
      return { clashes: 0 };
    }
    this.isRunning = true;
    console.log('🕷️  [OverbookingCrawler] Scanning all therapists for future overbookings...');
    try {
      const { clashes, scanned } = await this.findOverbookings();

      if (clashes.length === 0) {
        console.log(`✅ [OverbookingCrawler] No overbookings found (scanned ${scanned} sessions). No email sent.`);
        return { clashes: 0, scanned };
      }

      console.log(`🚨 [OverbookingCrawler] Found ${clashes.length} overbooked slot(s). Emailing ${ALERT_EMAIL}...`);
      const { pMap, cMap } = await this.hydrate(clashes);
      const html = this.buildEmailHtml(clashes, pMap, cMap, scanned);

      try {
        await emailService.sendCustomEmail({
          to: ALERT_EMAIL,
          subject: `🚨 Overbooking Alert: ${clashes.length} double-booked slot(s)`,
          html,
        });
        console.log(`✅ [OverbookingCrawler] Alert email sent to ${ALERT_EMAIL}`);
      } catch (mailErr) {
        console.error('❌ [OverbookingCrawler] Failed to send alert email:', mailErr.message || mailErr);
      }

      return { clashes: clashes.length, scanned };
    } catch (err) {
      console.error('❌ [OverbookingCrawler] error:', err.message || err);
      return { clashes: 0, error: err.message || String(err) };
    } finally {
      this.isRunning = false;
    }
  }

  /** Manual trigger (for testing / admin use). */
  async trigger() {
    console.log('🕷️  Manually triggering overbooking crawler...');
    return this.run();
  }
}

module.exports = new OverbookingCrawlerService();

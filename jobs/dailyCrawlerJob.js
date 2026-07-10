const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const EmailService = require('../utils/emailService');

const startDailyCrawlerScheduler = () => {
  // Schedule to run at 12:00 AM every day in IST
  cron.schedule('0 0 * * *', async () => {
    console.log('🕒 Running Daily Missing Links Crawler...');
    
    try {
      // Get today's date in YYYY-MM-DD
      // Note: Because it runs at midnight IST, the local date in Asia/Kolkata is exactly "today"
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
      const today = formatter.format(new Date());

      const { data: sessions, error } = await supabaseAdmin
        .from('sessions')
        .select('id, client_id, psychologist_id, scheduled_time, status, google_calendar_event_id, google_meet_link')
        .eq('scheduled_date', today)
        // Only ACTIVE bookings actually need a Meet link. Excludes cancelled, refunded,
        // on_hold, no_show, completed, deleted, pending — those legitimately have none, so
        // flagging them produced false-positive alerts.
        .in('status', ['booked', 'scheduled', 'confirmed', 'rescheduled', 'reschedule_requested']);

      if (error) {
        console.error('Error fetching sessions for crawler:', error);
        return;
      }

      const missingSessions = sessions.filter(
        (s) => !s.google_meet_link || !s.google_calendar_event_id
      );

      console.log(`Crawler checked ${sessions.length} sessions for ${today}. Found ${missingSessions.length} with missing links.`);

      if (missingSessions.length > 0) {
        let htmlBody = `
          <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 20px;">
            <h2 style="color: #d9534f; border-bottom: 2px solid #eee; padding-bottom: 10px;">Missing Meet Links Alert</h2>
            <p><strong>Date:</strong> ${today}</p>
            <p>The following <strong>${missingSessions.length}</strong> session(s) scheduled for today are missing their Google Meet link or Calendar Event ID:</p>
            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
              <thead>
                <tr style="background-color: #f8f9fa;">
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Time</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Client</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Email</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Phone</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Therapist</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Missing</th>
                </tr>
              </thead>
              <tbody>
        `;

        for (const sess of missingSessions) {
          const { data: psych } = await supabaseAdmin.from('psychologists').select('first_name, last_name').eq('id', sess.psychologist_id).maybeSingle();
          // client_id references the CLIENTS table (not users) — the old users lookup always
          // returned null → "Unknown". Resolve the real name/phone from clients.
          const { data: client } = sess.client_id
            ? await supabaseAdmin.from('clients').select('first_name, last_name, phone_number, user_id').eq('id', sess.client_id).maybeSingle()
            : { data: null };
          // Email lives on the linked users row (clients.email is usually empty).
          let clientEmail = '—';
          if (client?.user_id) {
            const { data: u } = await supabaseAdmin.from('users').select('email').eq('id', client.user_id).maybeSingle();
            clientEmail = u?.email || '—';
          }

          const psychName = psych ? `${psych.first_name} ${psych.last_name || ''}`.trim() : 'Unknown';
          const clientName = client
            ? (`${client.first_name || ''} ${client.last_name || ''}`.trim() || 'Unknown')
            : 'Unknown';
          const clientPhone = client?.phone_number || '—';

          let missingItems = [];
          if (!sess.google_meet_link) missingItems.push('Meet Link');
          if (!sess.google_calendar_event_id) missingItems.push('Event ID');

          htmlBody += `
                <tr>
                  <td style="padding: 10px; border: 1px solid #ddd;">${sess.scheduled_time}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${clientName}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${clientEmail}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${clientPhone}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${psychName}</td>
                  <td style="padding: 10px; border: 1px solid #ddd; color: #d9534f;">${missingItems.join(', ')}</td>
                </tr>
          `;
        }

        htmlBody += `
              </tbody>
            </table>
            <p style="margin-top: 20px; font-size: 12px; color: #777;">This is an automated alert generated by the Koott System.</p>
          </div>
        `;

        await EmailService.sendEmail({
          to: 'abhishekravi063@gmail.com',
          subject: `⚠️ URGENT: ${missingSessions.length} sessions missing Meet Links today (${today})`,
          html: htmlBody,
          text: `There are ${missingSessions.length} sessions missing links today.`
        });
        
        console.log('✅ Daily missing links alert email sent successfully.');
      }
    } catch (err) {
      console.error('Error in daily missing links crawler:', err);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });
};

module.exports = {
  startDailyCrawlerScheduler,
};

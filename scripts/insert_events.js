require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  const event1 = {
    slug: 'connection-to-closure',
    title: 'From Connection to Closure',
    is_published: true,
    content: {
      seo_title: 'From Connection to Closure | Koott',
      seo_description: 'Strengthening Therapeutic Alliances, Preventing Premature Dropout, and Ethical Termination',
      cms_data: {
        hero: {
          eyebrow: 'Workshop by Koott',
          title: 'From Connection to Closure',
          body: 'Strengthening Therapeutic Alliances, Preventing Premature Dropout, and Ethical Termination',
        },
        eventListCard: {
          category: 'Workshop',
          title: 'From Connection to Closure',
          description: 'Strengthening Therapeutic Alliances, Preventing Premature Dropout, and Ethical Termination',
          organizer: 'Koott',
          scheduleText: 'July 18, 2026 at 9:00 AM – 1:00 PM',
        },
        sessionBanner: {
          passLabel: 'Session pass',
          strikePrice: '',
          priceLarge: 'FREE',
          badgeText: 'Certificate of Participation provided',
          title: 'From Connection to Closure',
          subtitle: '',
          details: [
            { label: 'Date', value: 'July 18, 2026' },
            { label: 'Time', value: '9:00 AM – 1:00 PM' },
          ],
          ctaText: 'Register Now',
        },
        speakers: {
          eyebrow: 'Resource Person',
          heading: 'Meet the Speaker',
          items: [
            {
              name: 'Dr. Thaniya K. Leela, PhD',
              designation: 'Senior Consultant Psychologist',
              experience: '',
              image: '',
              details: '',
              languages: '',
              focus: '',
              style: '',
            }
          ]
        },
        whatIsThis: { eyebrow: '', title: '', body: '', bullets: [] },
        whyItMatters: { eyebrow: '', heading: '', body: '', outcomeCards: [], ctaLabel: '' },
        whoCanJoin: { heading: '', badge: '', columns: [] },
        takeBack: { title: '', body: '', items: [] },
        reviews: { title: '', items: [] },
      }
    },
    updated_at: new Date().toISOString()
  };

  const event2 = {
    slug: 'when-and-why-medications-are-used',
    title: 'When and Why Medications Are Used',
    is_published: true,
    content: {
      seo_title: 'When and Why Medications Are Used | Koott',
      seo_description: 'Psychiatric Disorders: An Overview',
      cms_data: {
        hero: {
          eyebrow: 'Internship session by Koott',
          title: 'When and Why Medications Are Used',
          body: 'Psychiatric Disorders: An Overview',
        },
        eventListCard: {
          category: 'Internship Session',
          title: 'When and Why Medications Are Used',
          description: 'Psychiatric Disorders: An Overview',
          organizer: 'Koott',
          scheduleText: 'July 10, 2026 at 4:00 PM – 5:00 PM',
        },
        sessionBanner: {
          passLabel: 'Session pass',
          strikePrice: '',
          priceLarge: 'FREE',
          badgeText: 'Certificate of Participation provided',
          title: 'When and Why Medications Are Used',
          subtitle: '',
          details: [
            { label: 'Date', value: 'July 10, 2026' },
            { label: 'Time', value: '4:00 PM – 5:00 PM' },
          ],
          ctaText: 'Register Now',
        },
        speakers: {
          eyebrow: 'Resource Person',
          heading: 'Meet the Speaker',
          items: [
            {
              name: 'Dr. Aswathy Balan',
              designation: 'Chief Consultant Psychiatrist',
              experience: '',
              image: '',
              details: '',
              languages: '',
              focus: '',
              style: '',
            }
          ]
        },
        whatIsThis: { eyebrow: '', title: '', body: '', bullets: [] },
        whyItMatters: { eyebrow: '', heading: '', body: '', outcomeCards: [], ctaLabel: '' },
        whoCanJoin: { heading: '', badge: '', columns: [] },
        takeBack: { title: '', body: '', items: [] },
        reviews: { title: '', items: [] },
      }
    },
    updated_at: new Date().toISOString()
  };

  for (const ev of [event1, event2]) {
    const { data: existing } = await supabaseAdmin.from('event_pages').select('id').eq('slug', ev.slug).maybeSingle();
    if (existing) {
      console.log(`Updating ${ev.slug}`);
      const { error } = await supabaseAdmin.from('event_pages').update(ev).eq('id', existing.id);
      if (error) console.error(error);
    } else {
      console.log(`Inserting ${ev.slug}`);
      const { error } = await supabaseAdmin.from('event_pages').insert(ev);
      if (error) console.error(error);
    }
  }

  console.log("Done!");
}

run();

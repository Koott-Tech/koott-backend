/**
 * Instrument definitions: items, scoring keys and descriptive text.
 *
 * Everything here is transcribed from the source documents supplied by the practice:
 *   - Big Five Inventory (John & Srivastava, 1999) — 44 items, scoring key on p.4
 *   - DASS-21 (Lovibond & Lovibond, 1995) — 21 items, cut-offs on p.2
 *   - Kalyana Raman — 10 domains x 3 prompts, taken from the Report 1 template
 *
 * Nothing is inferred. If a value is not in a source document it is not here.
 */

/* ───────────────────────── BIG FIVE (BFI-44) ───────────────────────── */

const BFI_ITEMS = [
  'Is talkative', 'Tends to find fault with others', 'Does a thorough job', 'Is depressed, blue',
  'Is original, comes up with new ideas', 'Is reserved', 'Is helpful and unselfish with others',
  'Can be somewhat careless', 'Is relaxed, handles stress well', 'Is curious about many different things',
  'Is full of energy', 'Starts quarrels with others', 'Is a reliable worker', 'Can be tense',
  'Is ingenious, a deep thinker', 'Generates a lot of enthusiasm', 'Has a forgiving nature',
  'Tends to be disorganized', 'Worries a lot', 'Has an active imagination', 'Tends to be quiet',
  'Is generally trusting', 'Tends to be lazy', 'Is emotionally stable, not easily upset', 'Is inventive',
  'Has an assertive personality', 'Can be cold and aloof', 'Perseveres until the task is finished',
  'Can be moody', 'Values artistic, aesthetic experiences', 'Is sometimes shy, inhibited',
  'Is considerate and kind to almost everyone', 'Does things efficiently', 'Remains calm in tense situations',
  'Prefers work that is routine', 'Is outgoing, sociable', 'Is sometimes rude to others',
  'Makes plans and follows through with them', 'Gets nervous easily', 'Likes to reflect, play with ideas',
  'Has few artistic interests', 'Likes to cooperate with others', 'Is easily distracted',
  'Is sophisticated in art, music, or literature',
].map((text, i) => ({ n: i + 1, text }));

/** [item number, reverse-keyed?] — verbatim from the BFI scoring key. */
const BFI_KEY = {
  Extraversion:      [[1,0],[6,1],[11,0],[16,0],[21,1],[26,0],[31,1],[36,0]],
  Agreeableness:     [[2,1],[7,0],[12,1],[17,0],[22,0],[27,1],[32,0],[37,1],[42,0]],
  Conscientiousness: [[3,0],[8,1],[13,0],[18,1],[23,1],[28,0],[33,0],[38,0],[43,1]],
  Neuroticism:       [[4,0],[9,1],[14,0],[19,0],[24,1],[29,0],[34,1],[39,0]],
  Openness:          [[5,0],[10,0],[15,0],[20,0],[25,0],[30,0],[35,1],[40,0],[41,1],[44,0]],
};

const BFI_SCALE_LABELS = [
  'Disagree strongly', 'Disagree a little', 'Neither agree nor disagree', 'Agree a little', 'Agree strongly',
];

/** Facets per dimension, from the table on page 1 of the BFI document. */
const BFI_TRAITS = {
  Extraversion: {
    contrast: 'Extraversion vs. Introversion',
    description: 'Extraversion describes how outwardly directed, sociable and energetic a person’s engagement with the world tends to be, with introversion at the opposite end of the dimension. In the Big Five Inventory manual (John & Srivastava, 1999) it is made up of six facets, each paired with a trait adjective:',
    facets: ['Gregariousness (sociable)','Assertiveness (forceful)','Activity (energetic)','Excitement-seeking (adventurous)','Positive emotions (enthusiastic)','Warmth (outgoing)'],
  },
  Agreeableness: {
    contrast: 'Agreeableness vs. Antagonism',
    description: 'Agreeableness describes the quality of a person’s interpersonal orientation: how cooperative, considerate and trusting they tend to be toward others, with antagonism at the opposite end. Its six facets are:',
    facets: ['Trust (forgiving)','Straightforwardness (not demanding)','Altruism (warm)','Compliance (not stubborn)','Modesty (not show-off)','Tender-mindedness (sympathetic)'],
  },
  Conscientiousness: {
    contrast: 'Conscientiousness vs. Lack of Direction',
    description: 'Conscientiousness describes how organised, dependable and goal-directed a person tends to be in carrying out tasks and responsibilities, with lack of direction at the opposite end. Its six facets are:',
    facets: ['Competence (efficient)','Order (organized)','Dutifulness (not careless)','Achievement striving (thorough)','Self-discipline (not lazy)','Deliberation (not impulsive)'],
  },
  Neuroticism: {
    contrast: 'Neuroticism vs. Emotional Stability',
    description: 'Neuroticism describes the tendency to experience negative emotions and emotional reactivity, with emotional stability at the opposite end. Its six facets are:',
    facets: ['Anxiety (tense)','Angry hostility (irritable)','Depression (not contented)','Self-consciousness (shy)','Impulsiveness (moody)','Vulnerability (not self-confident)'],
  },
  Openness: {
    contrast: 'Openness vs. Closedness to Experience',
    description: 'Openness describes a person’s curiosity and receptiveness toward new ideas, imagination, art and varied experiences, with closedness to experience at the opposite end. Its six facets are:',
    facets: ['Ideas (curious)','Fantasy (imaginative)','Aesthetics (artistic)','Actions (wide interests)','Feelings (excitable)','Values (unconventional)'],
  },
};

/**
 * Mean of the scale's items, 1.00-5.00, reverse-keyed items recoded as 6 - raw.
 * Percentage is the position on that range: (mean - 1) / 4.
 */
function scoreBigFive(answers) {
  return Object.entries(BFI_KEY).map(([trait, items]) => {
    const total = items.reduce((sum, [n, rev]) => {
      const raw = Number(answers[n]);
      if (!Number.isFinite(raw)) throw new Error(`Big Five: missing or non-numeric answer for item ${n}`);
      if (raw < 1 || raw > 5) throw new Error(`Big Five: item ${n} out of range (${raw})`);
      return sum + (rev ? 6 - raw : raw);
    }, 0);
    // The percentage is derived from the mean AS DISPLAYED (2 dp), not the exact quotient.
    // That is how the practice's own report template computes it: Agreeableness 29/9 shows
    // 3.22 and 55.5%, which only follows from (3.22 - 1) / 4 — the exact value would give 55.6%.
    const mean = Math.round((total / items.length) * 100) / 100;
    return { trait, mean, pct: ((mean - 1) / 4) * 100, items: items.length, ...BFI_TRAITS[trait] };
  });
}

/* ───────────────────────────── DASS-21 ───────────────────────────── */

const DASS_ITEMS = [
  ['s','I found it hard to wind down'],
  ['a','I was aware of dryness of my mouth'],
  ['d','I couldn’t seem to experience any positive feeling at all'],
  ['a','I experienced breathing difficulty (e.g. excessively rapid breathing, breathlessness in the absence of physical exertion)'],
  ['d','I found it difficult to work up the initiative to do things'],
  ['s','I tended to over-react to situations'],
  ['a','I experienced trembling (e.g. in the hands)'],
  ['s','I felt that I was using a lot of nervous energy'],
  ['a','I was worried about situations in which I might panic and make a fool of myself'],
  ['d','I felt that I had nothing to look forward to'],
  ['s','I found myself getting agitated'],
  ['s','I found it difficult to relax'],
  ['d','I felt down-hearted and blue'],
  ['s','I was intolerant of anything that kept me from getting on with what I was doing'],
  ['a','I felt I was close to panic'],
  ['d','I was unable to become enthusiastic about anything'],
  ['d','I felt I wasn’t worth much as a person'],
  ['s','I felt that I was rather touchy'],
  ['a','I was aware of the action of my heart in the absence of physical exertion (e.g. sense of heart rate increase, heart missing a beat)'],
  ['a','I felt scared without any good reason'],
  ['d','I felt that life was meaningless'],
].map(([scale, text], i) => ({ n: i + 1, scale, text }));

const DASS_SCALE_LABELS = [
  'Did not apply to me at all',
  'Applied to me to some degree, or some of the time',
  'Applied to me to a considerable degree, or a good part of time',
  'Applied to me very much or most of the time',
];

/** Cut-offs from the DASS-21 scoring instructions, applied to the DOUBLED score. */
const DASS_SEVERITY = {
  Depression: [[9,'Normal'],[13,'Mild'],[20,'Moderate'],[27,'Severe'],[Infinity,'Extremely Severe']],
  Anxiety:    [[7,'Normal'],[9,'Mild'],[14,'Moderate'],[19,'Severe'],[Infinity,'Extremely Severe']],
  Stress:     [[14,'Normal'],[18,'Mild'],[25,'Moderate'],[33,'Severe'],[Infinity,'Extremely Severe']],
};
const DASS_TRAITS = {
  Depression: {
    key: 'd',
    description: 'The Depression scale assesses low mood and loss of motivation and self-worth. Per the DASS manual (Lovibond & Lovibond, 1995) it covers:',
    facets: ['Dysphoria','Hopelessness','Devaluation of life','Self-deprecation','Lack of interest / involvement','Anhedonia','Inertia'],
  },
  Anxiety: {
    key: 'a',
    description: 'The Anxiety scale assesses physiological arousal and the felt experience of anxiety, including fear responses. It covers:',
    facets: ['Autonomic arousal','Skeletal muscle effects','Situational anxiety','Subjective experience of anxious affect'],
  },
  Stress: {
    key: 's',
    description: 'The Stress scale assesses persistent tension and difficulty unwinding, a state of chronic non-specific arousal. It covers:',
    facets: ['Difficulty relaxing','Nervous arousal','Being easily upset / agitated','Irritability / over-reactivity','Impatience'],
  },
};

/** Sum the 7 items, multiply by 2 (per the manual), then band. Max doubled score is 42. */
function scoreDass21(answers) {
  return Object.entries(DASS_TRAITS).map(([name, meta]) => {
    const items = DASS_ITEMS.filter((i) => i.scale === meta.key);
    const raw = items.reduce((sum, i) => {
      const v = Number(answers[i.n]);
      if (!Number.isFinite(v)) throw new Error(`DASS-21: missing or non-numeric answer for item ${i.n}`);
      if (v < 0 || v > 3) throw new Error(`DASS-21: item ${i.n} out of range (${v})`);
      return sum + v;
    }, 0);
    const score = raw * 2;
    const severity = DASS_SEVERITY[name].find(([max]) => score <= max)[1];
    return { trait: name, score, severity, pct: (score / 42) * 100, items: items.length, ...meta };
  });
}

/* ──────────────────────── KALYANA RAMAN ──────────────────────── */

const KR_DOMAINS = [
  { title: 'Meaning of Marriage, Expectations and Partner Role', questions: [
    'What does marriage mean to you?',
    'What do you expect from yourself and from your partner in the marriage?',
    'What are your non-negotiables?' ] },
  { title: 'Emotional, Communication and Conflict Patterns', questions: [
    'What do you need emotionally when you are upset?',
    'How do you usually act during a disagreement?',
    'How do you apologise and forgive?' ] },
  { title: 'Roles, Responsibilities, Autonomy and Boundaries', questions: [
    'How should household work be shared?',
    'How should major decisions be made?',
    'What privacy and personal space do you need?' ] },
  { title: 'Family Background, Family of Origin, In-laws and Values', questions: [
    'How has your family shaped your view of relationships?',
    'What role should extended family have in your married life?',
    'What living arrangement do you prefer after marriage?' ] },
  { title: 'Financial, Career, Educational and Lifestyle Expectations', questions: [
    'How should income and spending be managed?',
    'What are your career and education plans?',
    'What lifestyle and leisure do you prefer?' ] },
  { title: 'Children, Parenting, Sexuality and Reproductive Life', questions: [
    'What are your views on children and their timing?',
    'How should parenting responsibilities be shared?',
    'How do you view physical intimacy, communication about it, and consent?' ] },
  { title: 'Physical Health, Psychological Health, Substance Use and Addictions', questions: [
    'Are there any health conditions you wish to share?',
    'Is there any psychological care history you wish to share?',
    'What is your pattern of substance use, if any?' ] },
  { title: 'Personality, Previous Relationships and Coping', questions: [
    'What are your strengths and difficulties?',
    'Have you had previous significant relationships?',
    'How do you cope with stress and seek help?' ] },
  { title: 'Relationship Safety, Trust, Digital and Social Boundaries', questions: [
    'What does trust mean to you?',
    'Is there anything about fear, control or safety you wish to share?',
    'What are your views on phones, social media and digital privacy?' ] },
  { title: 'Major Life Responsibilities, Crisis, Health Transitions and Future Expectations', questions: [
    'Do you have prior marriage, dependants or ongoing obligations?',
    'How would you handle illness or a crisis?',
    'What do you expect from a long-term partnership?' ] },
];

module.exports = {
  BFI_ITEMS, BFI_KEY, BFI_SCALE_LABELS, BFI_TRAITS, scoreBigFive,
  DASS_ITEMS, DASS_SCALE_LABELS, DASS_SEVERITY, DASS_TRAITS, scoreDass21,
  KR_DOMAINS,
};

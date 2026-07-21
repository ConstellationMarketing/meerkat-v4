#!/usr/bin/env node
/**
 * Update the Practice Page and Supporting Page templates so each section's
 * brief (description) and wordCount match the editorial SOPs
 * (Practice Page Structure SOP + Supporting/Resource Page Structure SOP).
 *
 * Pairs with the prompt change in prompts/section-writer.md (page-type-split
 * intros + concept-only statutes + scannable bullets + comparisons).
 *
 * Matches sections by title; updates only description + wordCount. Idempotent.
 *
 *   node scripts/update-templates-to-sop.js --dry-run   # show planned changes
 *   node scripts/update-templates-to-sop.js --commit    # apply
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  db: { schema: 'meerkat' },
});
const COMMIT = process.argv.includes('--commit');

const PRACTICE = {
  Introduction: {
    wordCount: 250,
    description:
      `Practice Page SOP: a 200-300 word empathetic opening. Empathize with the reader's situation using the keyword (e.g., "If you're facing DUI charges in Nassau County…"), present {{clientName}} as the trusted solution, speak directly to the reader ("you"), set up the problem, and link the homepage. Warm, understanding tone — not a hard sell (no "free consultation"/"call now"; those belong in the CTA). Lead naturally into How We Can Help.`,
  },
  'How We Can Help': {
    wordCount: 200,
    description:
      `100-300 words. Use Problem → Agitation → Agitation: expand on the problem, agitate the pain, and agitate the consequences of not acting, then show how the firm helps. Build on the intro's emotional setup; move the reader fear → clarity → hope. May link to related practice-area pages; no unrelated external links. Do NOT list credentials (Why Choose Us) or walk through process steps (What to Expect).`,
  },
  'Why Choose Us': {
    wordCount: 500,
    description:
      `400-600 words. Explain why {{clientName}} is the best choice using specifics from CLIENT DETAILS — experience, awards, case results, testimonials, trust signals. Use short, scannable paragraphs or bullet points. Answer "Why should I trust THIS lawyer over anyone else?" Link the About Us page. No boilerplate — ground every claim in a concrete detail.`,
  },
  'What to Expect': {
    wordCount: 500,
    description:
      `400-600 words. Walk through the legal process step by step in simple terms (e.g., consultation → document review → strategy → representation → resolution). Describe what working with {{clientName}} will be like. Keep steps in correct order; avoid jargon; reference the law in plain language (do NOT cite statute numbers). Do NOT pitch the firm or list credentials.`,
  },
  CTA: {
    wordCount: 200,
    description:
      `100-300 words. Summarize the main takeaway, reaffirm empathy, give clear next steps, and directly instruct the reader to contact the firm. Warm, human, supportive. Include a local signal. Link the Contact Us page. This is where conversion language belongs.`,
  },
};

const SUPPORTING = {
  Introduction: {
    wordCount: 50,
    description:
      `Supporting Page SOP: 2-3 sentences ONLY. Briefly frame the question/topic and surface the core answer immediately. Do NOT mention the firm and do NOT link the homepage. Informational and neutral. A short contextual heading is optional.`,
  },
  'Core Answer': {
    wordCount: 250,
    description:
      `200-300 words. This is the first H2; it must rephrase the primary question in a helpful, informational way and immediately begin answering it. The H2 MUST begin with What / How / When / Why (e.g., "What Happens If You Refuse a Breathalyzer in Maryland?"). Do NOT introduce the firm or link the homepage. Match search intent, give immediate clarity. Reference the law in plain language (no statute numbers).`,
  },
  'Additional Considerations': {
    wordCount: 300,
    description:
      `Main-body detail. Break into scannable sections (H3s) with simple legal explanations, examples/scenarios, and checklists or timelines where useful. Where the topic involves related options readers weigh against each other (e.g., revocable vs. irrevocable trust, codicil vs. new will), include a brief side-by-side comparison. MUST NOT repeat the Core Answer — build on it. No firm references. No sales language. Plain-language law only (no statute numbers).`,
  },
  'What to Expect': {
    wordCount: 250,
    description:
      `Practical, step-by-step walk-through of the process, in correct order, with realistic timelines and what happens at each stage. Scannable (numbered steps). Factual — not a firm-services pitch. No firm references. Plain-language law (no statute numbers).`,
  },
  'Soft CTA': {
    wordCount: 70,
    description:
      `Gentle, non-promotional nudge — 2-4 sentences, 50-80 words. Suggest speaking with a local attorney about the topic. This is the ONLY section on a supporting page where the firm may be mentioned. Do NOT say "hire us", "call now", "free consultation", or guarantee results. Use a natural prompt heading (e.g., "When to Speak With an Attorney About [Topic]"), not the literal "Soft CTA".`,
  },
};

async function updateTemplate(id, briefs) {
  const { data, error } = await supabase
    .from('templates')
    .select('id, sections')
    .eq('id', id)
    .single();
  if (error) throw new Error(`Fetch ${id}: ${error.message}`);

  const sections = Array.isArray(data.sections) ? data.sections : [];
  let changes = 0;
  const next = sections.map((s) => {
    const title = (s.title || s.name || '').trim();
    const b = briefs[title];
    if (!b) return s;
    const changed = s.description !== b.description || s.wordCount !== b.wordCount;
    if (changed) {
      changes++;
      console.log(`  [${id}] ${title}: wordCount ${s.wordCount} -> ${b.wordCount}`);
    }
    return { ...s, description: b.description, wordCount: b.wordCount };
  });

  if (!changes) {
    console.log(`  [${id}] already up to date.`);
    return;
  }
  if (!COMMIT) return;

  const { error: upErr } = await supabase
    .from('templates')
    .update({ sections: next })
    .eq('id', id);
  if (upErr) throw new Error(`Update ${id}: ${upErr.message}`);
  console.log(`  [${id}] updated ${changes} section(s).`);
}

(async () => {
  console.log(COMMIT ? 'COMMIT mode' : 'DRY RUN (use --commit to apply)');
  await updateTemplate('practice-page', PRACTICE);
  await updateTemplate('supporting-page', SUPPORTING);
  console.log('Done.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

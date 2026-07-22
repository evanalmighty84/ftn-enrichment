const pool = require('../db/db');

/* ---------------- Perplexity Sonar config ---------------- */
const PPLX_API_URL =
    process.env.PPLX_API_URL || 'https://api.perplexity.ai/chat/completions';
const PPLX_MODEL = process.env.PPLX_MODEL || 'sonar';
const PPLX_BATCH_SIZE = parseInt(process.env.PPLX_BATCH_SIZE || '25', 10);

/* ---------------- Allowed lead_type values (text array) ----------------
   lead_type is a Postgres text[] column. Each element must be one of these
   atomic trades. A post may have more than one. If none fit, use an empty
   array. */
const ALLOWED_LEAD_TYPES = [
    'christmas_lights',
    'commercial_lending',
    'concrete',
    'dentist',
    'electrician',
    'fencing',
    'garage',
    'general_contractor',
    'handyman',
    'house_cleaner',
    'hvac',
    'insurance',
    'interior_designer',
    'junk_removal',
    'landscaping',
    'lawn_care',
    'lighting',
    'mold',
    'mover',
    'painter',
    'pest_control',
    'pet_sitter',
    'plumber',
    'pool',
    'power_washing',
    'realtor',
    'roofer',
    'security',
    'windows',
];

const ALLOWED_SET = new Set(ALLOWED_LEAD_TYPES);
const ALLOWED_NORMALIZED = new Map(
    ALLOWED_LEAD_TYPES.map((v) => [v.toLowerCase().replace(/\s+/g, '').replace(/-/g, '_'), v])
);

const SYSTEM_PROMPT = `You classify Nextdoor neighborhood posts for a general-contractor lead pipeline.

A post is a LEAD (is_lead=true) ONLY when the AUTHOR is a homeowner/property owner SEEKING TO HIRE someone for a service ON their home or property: general-contracting (deck, fence, remodel, addition, roofing, siding, restoration, foundation, garage), home trades (plumbing, electrical, HVAC, gutters, windows, doors, drywall, tile, painting, lighting, generator), or home maintenance (lawn/yard, landscaping, house cleaning, handyman, pest control, junk removal, pool, power washing, christmas lights).
NOT a lead when the author is advertising their own services, posting spam/duplicates, only recommending a pro they already used, says the job is done, is not a home service, is off-topic, is venting/asking with no intent to hire, or is about moving.

lead_type is an ARRAY of one or more atomic trade values describing what the post is about, chosen from this list:
${JSON.stringify(ALLOWED_LEAD_TYPES)}
Pick only the trades the work actually involves. If no trade applies (e.g. off-topic), return an empty array []. Every element must match a list entry exactly.

Respond with ONLY a JSON array, no markdown. Each element:
{"id":<number>,"is_lead":<bool>,"lead_type":[<allowed strings>],"lead_reason":"<short sentence>"}
Preserve every input id.`;

/**
 * Accepts a string, comma-separated string, or array; returns a valid
 * de-duplicated array of allowed lead_type values (empty array if nothing matches).
 */
function coerceLeadTypes(raw) {
    const tokens = Array.isArray(raw) ? raw : String(raw || '').split(',');
    const out = [];
    const seen = new Set();
    for (const tok of tokens) {
        for (const sub of String(tok).split(',')) {
            const s = sub.trim();
            if (!s) continue;
            const resolved = ALLOWED_SET.has(s) ? s : ALLOWED_NORMALIZED.get(s.toLowerCase().replace(/\s+/g, '').replace(/-/g, '_'));
            if (resolved && !seen.has(resolved)) {
                seen.add(resolved);
                out.push(resolved);
            }
        }
    }
    return out;
}

/* ---------------- Sonar helpers ---------------- */

function extractJsonArray(text) {
    let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.results)) return parsed.results;
        if (parsed && Array.isArray(parsed.leads)) return parsed.leads;
    } catch { /* fall through */ }
    const m = t.match(/\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
    return null;
}

async function callSonar(messages) {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error('PERPLEXITY_API_KEY is not set (get one at https://www.perplexity.ai/account/api)');
    const resp = await fetch(PPLX_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: PPLX_MODEL, messages, temperature: 0, max_tokens: 8192, return_citations: false }),
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Perplexity API ${resp.status}: ${body.slice(0, 500)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Perplexity API returned no content');
    return content;
}

async function classifyLeads(rows) {
    const out = new Map();
    if (!rows.length) return out;
    for (let i = 0; i < rows.length; i += PPLX_BATCH_SIZE) {
        const batch = rows.slice(i, i + PPLX_BATCH_SIZE);
        const payload = batch.map((r) => ({ id: r.id, author: r.author || '', city: r.city || '', post: (r.description || '').slice(0, 4000) }));
        const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'Classify each post. Return ONLY a JSON array with one object per id.\n\n' + JSON.stringify(payload) }];
        let content = await callSonar(messages);
        let arr = extractJsonArray(content);
        if (!arr) { // one retry — Sonar occasionally returns malformed JSON
            content = await callSonar(messages);
            arr = extractJsonArray(content);
        }
        if (!arr) {
            console.error(`[ftn] sonar batch unparseable, skipping (rows left for retry). Raw: ${String(content).slice(0, 800)}`);
            continue;
        }
        const byId = new Map(arr.map((x) => [Number(x.id), x]));
        for (const row of batch) {
            const r = byId.get(Number(row.id));
            out.set(row.id, r
                ? { is_lead: Boolean(r.is_lead), lead_types: coerceLeadTypes(r.lead_type), lead_reason: String(r.lead_reason || '').slice(0, 500) }
                : { is_lead: false, lead_types: [], lead_reason: 'Sonar returned no verdict for this post' });
        }
    }
    return out;
}

/* ---------------- Main ---------------- */

async function main() {
    const minutesBack = parseInt(process.env.MINUTES_BACK || '60', 10);
    const limit = parseInt(process.env.BATCH_LIMIT || '50', 10);

    const { rows } = await pool.query(
        `SELECT id, author, description, city, state
         FROM unfiltered_general_contracting
         WHERE enrichment = false
           AND created_at >= now() - make_interval(mins => $1)
         ORDER BY created_at ASC
             LIMIT $2`,
        [minutesBack, limit]
    );

    if (rows.length === 0) {
        console.log('[ftn] no rows to enrich');
        return;
    }

    const verdicts = await classifyLeads(rows);

    let leads = 0, nonLeads = 0, errors = 0;
    for (const row of rows) {
        const v = verdicts.get(row.id);
        try {
            if (!v) {
                await pool.query(
                    `UPDATE unfiltered_general_contracting
                     SET enrichment_status = 'error', enrichment_error = 'no sonar verdict', enriched_at = now()
                     WHERE id = $1`,
                    [row.id]
                );
                errors += 1;
                continue;
            }
            const status = v.is_lead ? 'lead' : 'not_lead';
            await pool.query(
                `UPDATE unfiltered_general_contracting
                 SET is_lead = $2, lead_type = $3, lead_reason = $4,
                     lead_classified_at = now(), enrichment_status = $5, enriched_at = now(), enrichment = true
                 WHERE id = $1`,
                [row.id, v.is_lead, v.lead_types, v.lead_reason, status]
            );
            if (v.is_lead) leads += 1; else nonLeads += 1;
        } catch (e) {
            console.error(`[ftn] write failed for id ${row.id}: ${e.message}`);
            errors += 1;
        }
    }

    console.log(`[ftn] batch=${rows.length} leads=${leads} nonLeads=${nonLeads} errors=${errors}`);
}

main()
    .then(async () => {
        await pool.end().catch(() => {});
        process.exit(0);
    })
    .catch(async (error) => {
        console.error('❌ Fatal error:', error.message);
        await pool.end().catch(() => {});
        process.exit(1);
    });
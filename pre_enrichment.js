#!/usr/bin/env node

"use strict";

const { Pool } = require("pg");

function buildPool() {
    const connectionString =
        process.env.DATABASE_URL ||
        (
            process.env.DB_USER &&
            process.env.DB_HOST &&
            process.env.DB_NAME
                ? `postgres://${encodeURIComponent(
                    process.env.DB_USER,
                )}:${encodeURIComponent(
                    process.env.DB_PASSWORD || "",
                )}@${process.env.DB_HOST}:${
                    process.env.DB_PORT || 5432
                }/${encodeURIComponent(process.env.DB_NAME)}`
                : null
        );

    if (!connectionString) {
        throw new Error(
            "No Postgres connection configured. Set DATABASE_URL or " +
            "DB_USER/DB_HOST/DB_NAME/DB_PASSWORD/DB_PORT.",
        );
    }

    return new Pool({
        connectionString,
        ssl: {
            rejectUnauthorized: false,
        },
    });
}

const pool = buildPool();

/* ---------------- Source table config ----------------
   ftn-trigger-server.js passes FTN_SOURCE_TABLE to this process.

   Only these approved table names are allowed because PostgreSQL table
   identifiers cannot be supplied through ordinary $1 query parameters.
*/
const ALLOWED_SOURCE_TABLES = new Set([
    "unfiltered_general_contracting",
    "unfiltered_ins_mold_pest_housecl_plumb_paint_land_lawn_handy",
]);

const TABLE_NAME = String(
    process.env.FTN_SOURCE_TABLE ||
    "unfiltered_general_contracting",
).trim();

if (!ALLOWED_SOURCE_TABLES.has(TABLE_NAME)) {
    throw new Error(
        `Invalid FTN source table: ${TABLE_NAME}`,
    );
}

console.log(`[ftn] using source table: ${TABLE_NAME}`);

/* ---------------- Perplexity Sonar config ---------------- */
const PPLX_API_URL =
    process.env.PPLX_API_URL ||
    "https://api.perplexity.ai/chat/completions";

const PPLX_MODEL =
    process.env.PPLX_MODEL || "sonar";

const PPLX_BATCH_SIZE = parseInt(
    process.env.PPLX_BATCH_SIZE || "25",
    10,
);

/* ---------------- Allowed lead_type values (text array) ----------------
   lead_type is a Postgres text[] column. Each element must be one of these
   atomic trades. A post may have more than one. If none fit, use an empty
   array.
*/
const ALLOWED_LEAD_TYPES = [
    "christmas_lights",
    "commercial_lending",
    "concrete",
    "dentist",
    "electrician",
    "fencing",
    "garage",
    "general_contractor",
    "handyman",
    "homecare",
    "house_cleaner",
    "hvac",
    "insurance",
    "interior_designer",
    "junk_removal",
    "landscaping",
    "lawn_care",
    "lighting",
    "mold",
    "mover",
    "painter",
    "pest_control",
    "pet_sitter",
    "plumber",
    "pool",
    "power_washing",
    "realtor",
    "roofer",
    "security",
    "windows",
];

const ALLOWED_SET = new Set(ALLOWED_LEAD_TYPES);

const ALLOWED_NORMALIZED = new Map(
    ALLOWED_LEAD_TYPES.map((value) => [
        value
            .toLowerCase()
            .replace(/\s+/g, "")
            .replace(/-/g, "_"),
        value,
    ]),
);

const SYSTEM_PROMPT = `You classify Nextdoor neighborhood posts for a multi-service lead-generation pipeline.

A post is a LEAD (is_lead=true) when the AUTHOR has an unresolved need, problem, question, request, or situation that a professional in one or more of the supported service categories could reasonably help with.

The author does NOT need to explicitly say they intend to hire someone.

A post can be a lead when the author is:
- seeking to hire or find a professional;
- asking for referrals or recommendations;
- asking who to call or what type of professional they need;
- asking for advice, opinions, pricing, guidance, or next steps;
- describing an unresolved problem that a supported professional could help solve;
- researching options before deciding what to do.

Advice and information-seeking posts can be leads when there is a genuine unresolved need.

Relevant services include:

HOME / PROPERTY SERVICES:
General contracting, decks, fences, remodeling, additions, roofing, siding, restoration, foundation, garage work, plumbing, electrical, HVAC, gutters, windows, doors, drywall, tile, flooring, painting, staining, lighting, generators, lawn care, landscaping, tree work, house cleaning, handyman services, pest control, junk removal, pools, power washing, exterior lighting, Christmas lights, mold remediation, and other supported home/property services.

INSURANCE:
Posts involving home insurance, homeowners insurance, auto insurance, renters insurance, insurance shopping, comparing rates or coverage, looking for an insurance agent, asking for an insurance recommendation, problems obtaining coverage, questions about coverage, filing or considering filing an insurance claim, or needing help with an insurance-related issue.

HOME CARE / SENIOR CARE:
Posts involving a need for help caring for the author or another person, including a parent, spouse, relative, elderly person, disabled person, or someone needing assistance at home.

Examples include caregiver needs, senior care, elderly care, companion care, dementia or Alzheimer's care, respite care, help with daily living, personal care assistance, someone to stay with or check on a loved one, or questions about arranging in-home care.

The author does NOT need to explicitly use the words "home care" or "caregiver." Infer the need from the situation described.

BOOKKEEPING / BUSINESS FINANCIAL HELP:
Posts from business owners, self-employed people, contractors, organizations, or individuals needing help with bookkeeping, QuickBooks, bookkeeping cleanup, catching up books, reconciling accounts, categorizing transactions, financial reporting, financial dashboards, profit-and-loss reporting, bookkeeping systems, correcting bookkeeping problems, or ongoing bookkeeping support.

Advice, referrals, recommendations, and questions about an unresolved bookkeeping or business-financial issue can be leads.

REAL ESTATE / REALTOR:
Posts involving someone looking to buy, sell, rent, relocate, move, find a realtor, find a real-estate agent, ask questions about buying or selling, evaluate whether to sell, or otherwise showing an unresolved real-estate need.

Moving or relocation is NOT automatically disqualifying when it creates a legitimate realtor or real-estate opportunity.

NOT a lead when:
- the author is advertising or promoting their own services;
- the post is spam or clearly irrelevant;
- the author is only recommending or praising a professional they already used and has no unresolved need;
- the job or problem is clearly completed and no additional help is needed;
- the post is general conversation with no professional need;
- the post does not relate to any supported lead category.

IMPORTANT:
Classify the post based on the AUTHOR'S actual need, not based on the search term that found the post.

Do not assume every lead must involve a homeowner, a house, construction, or physical property work.

Do not reject bookkeeping, home care, insurance, or real-estate posts merely because they are not traditional home-service jobs.

A post may have more than one lead_type when multiple supported services are genuinely relevant.

lead_type is an ARRAY of one or more atomic trade values describing what the post is about, chosen from this list: ${JSON.stringify(ALLOWED_LEAD_TYPES)}

Pick only the lead types actually supported by the post.

If no supported lead type applies, return an empty array [].

Every element must match an ALLOWED_LEAD_TYPES entry exactly.

Respond with ONLY a JSON array, no markdown. Each element:
{"id":<number>,"is_lead":<bool>,"lead_type":[<allowed strings>],"lead_reason":"<short sentence>"}

Preserve every input id.`;

/**
 * Accepts a string, comma-separated string, or array; returns a valid
 * de-duplicated array of allowed lead_type values.
 */
function coerceLeadTypes(raw) {
    const tokens = Array.isArray(raw)
        ? raw
        : String(raw || "").split(",");

    const out = [];
    const seen = new Set();

    for (const token of tokens) {
        for (const subToken of String(token).split(",")) {
            const value = subToken.trim();

            if (!value) {
                continue;
            }

            const normalized = value
                .toLowerCase()
                .replace(/\s+/g, "")
                .replace(/-/g, "_");

            const resolved = ALLOWED_SET.has(value)
                ? value
                : ALLOWED_NORMALIZED.get(normalized);

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
    const cleaned = String(text || "")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();

    try {
        const parsed = JSON.parse(cleaned);

        if (Array.isArray(parsed)) {
            return parsed;
        }

        if (parsed && Array.isArray(parsed.results)) {
            return parsed.results;
        }

        if (parsed && Array.isArray(parsed.leads)) {
            return parsed.leads;
        }
    } catch {
        // Fall through.
    }

    const match = cleaned.match(/\[[\s\S]*\]/);

    if (match) {
        try {
            return JSON.parse(match[0]);
        } catch {
            // Ignore malformed embedded JSON.
        }
    }

    return null;
}

async function callSonar(messages) {
    const apiKey = process.env.PERPLEXITY_API_KEY;

    if (!apiKey) {
        throw new Error(
            "PERPLEXITY_API_KEY is not set " +
            "(get one at https://www.perplexity.ai/account/api)",
        );
    }

    const response = await fetch(PPLX_API_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            model: PPLX_MODEL,
            messages,
            temperature: 0,
            max_tokens: 8192,
            return_citations: false,
        }),
    });

    if (!response.ok) {
        const body = await response
            .text()
            .catch(() => "");

        throw new Error(
            `Perplexity API ${response.status}: ` +
            `${body.slice(0, 500)}`,
        );
    }

    const data = await response.json();
    const content =
        data?.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error(
            "Perplexity API returned no content",
        );
    }

    return content;
}

async function classifyLeads(rows) {
    const out = new Map();

    if (!rows.length) {
        return out;
    }

    for (
        let index = 0;
        index < rows.length;
        index += PPLX_BATCH_SIZE
    ) {
        const batch = rows.slice(
            index,
            index + PPLX_BATCH_SIZE,
        );

        const payload = batch.map((row) => ({
            id: row.id,
            author: row.author || "",
            city: row.city || "",
            post: (row.description || "").slice(0, 4000),
        }));

        const messages = [
            {
                role: "system",
                content: SYSTEM_PROMPT,
            },
            {
                role: "user",
                content:
                    "Classify each post. Return ONLY a JSON array " +
                    "with one object per id.\n\n" +
                    JSON.stringify(payload),
            },
        ];

        let content = await callSonar(messages);
        let array = extractJsonArray(content);

        // One retry — Sonar occasionally returns malformed JSON.
        if (!array) {
            content = await callSonar(messages);
            array = extractJsonArray(content);
        }

        if (!array) {
            console.error(
                "[ftn] sonar batch unparseable, skipping " +
                "(rows left for retry). Raw: " +
                String(content).slice(0, 800),
            );

            continue;
        }

        const byId = new Map(
            array.map((item) => [
                Number(item.id),
                item,
            ]),
        );

        for (const row of batch) {
            const verdict = byId.get(Number(row.id));

            out.set(
                row.id,
                verdict
                    ? {
                        is_lead: Boolean(verdict.is_lead),
                        lead_types: coerceLeadTypes(
                            verdict.lead_type,
                        ),
                        lead_reason: String(
                            verdict.lead_reason || "",
                        ).slice(0, 500),
                    }
                    : {
                        is_lead: false,
                        lead_types: [],
                        lead_reason:
                            "Sonar returned no verdict for this post",
                    },
            );
        }
    }

    return out;
}

/* ---------------- Main ---------------- */

async function main() {
    const minutesBack = parseInt(
        process.env.MINUTES_BACK || "60",
        10,
    );

    const limit = parseInt(
        process.env.BATCH_LIMIT || "50",
        10,
    );

    console.log(
        `[ftn] table=${TABLE_NAME} ` +
        `minutesBack=${minutesBack} limit=${limit}`,
    );

    const { rows } = await pool.query(
        `
            SELECT
                id,
                author,
                description,
                city,
                state
            FROM ${TABLE_NAME}
            WHERE enrichment = false
              AND created_at >=
                  now() - make_interval(mins => $1)
            ORDER BY created_at ASC
            LIMIT $2
        `,
        [minutesBack, limit],
    );

    if (rows.length === 0) {
        console.log(
            `[ftn] no rows to enrich in ${TABLE_NAME}`,
        );

        return;
    }

    const verdicts = await classifyLeads(rows);

    let leads = 0;
    let nonLeads = 0;
    let errors = 0;

    for (const row of rows) {
        const verdict = verdicts.get(row.id);

        try {
            if (!verdict) {
                await pool.query(
                    `
                        UPDATE ${TABLE_NAME}
                        SET enrichment_status = 'error',
                            enrichment_error = 'no sonar verdict',
                            enriched_at = now()
                        WHERE id = $1
                    `,
                    [row.id],
                );

                errors += 1;
                continue;
            }

            const status = verdict.is_lead
                ? "lead"
                : "not_lead";

            await pool.query(
                `
                    UPDATE ${TABLE_NAME}
                    SET is_lead = $2,
                        lead_type = $3,
                        lead_reason = $4,
                        lead_classified_at = now(),
                        enrichment_status = $5,
                        enriched_at = now(),
                        enrichment = true
                    WHERE id = $1
                `,
                [
                    row.id,
                    verdict.is_lead,
                    verdict.lead_types,
                    verdict.lead_reason,
                    status,
                ],
            );

            if (verdict.is_lead) {
                leads += 1;
            } else {
                nonLeads += 1;
            }
        } catch (error) {
            console.error(
                `[ftn] write failed for id ${row.id}: ` +
                error.message,
            );

            errors += 1;
        }
    }

    console.log(
        `[ftn] table=${TABLE_NAME} batch=${rows.length} ` +
        `leads=${leads} nonLeads=${nonLeads} ` +
        `errors=${errors}`,
    );
}

main()
    .then(async () => {
        await pool.end().catch(() => {});
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(
            "❌ Fatal error:",
            error.message,
        );

        await pool.end().catch(() => {});
        process.exit(1);
    });

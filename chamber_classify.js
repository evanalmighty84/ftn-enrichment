#!/usr/bin/env node

"use strict";

require("dotenv").config();

const { Pool } = require("pg");

const {
    ALLOWED_LEAD_TYPES,
} = require("./lead_types");


/* --------------------------------------------------------------------------
 * PostgreSQL
 * ----------------------------------------------------------------------- */

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
                }/${encodeURIComponent(
                    process.env.DB_NAME,
                )}`
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


/* --------------------------------------------------------------------------
 * Perplexity / Sonar
 * ----------------------------------------------------------------------- */

const PPLX_API_URL =
    process.env.PPLX_API_URL ||
    "https://api.perplexity.ai/chat/completions";

const PPLX_MODEL =
    process.env.PPLX_MODEL ||
    "sonar";

const BATCH_SIZE = Number(
    process.env.CHAMBER_CLASSIFY_BATCH_SIZE || 20,
);


/* --------------------------------------------------------------------------
 * Allowed industries
 * ----------------------------------------------------------------------- */

const ALLOWED_SET =
    new Set(ALLOWED_LEAD_TYPES);


/* --------------------------------------------------------------------------
 * Sonar business-classification prompt
 * ----------------------------------------------------------------------- */

const SYSTEM_PROMPT = `
You classify businesses from local Chamber of Commerce directories
for a lead-generation system.

Your job is to determine which of our supported lead industries
each business ACTUALLY provides.

You are classifying the BUSINESS — not the Chamber's generic category.

The only allowed industry values are:

${JSON.stringify(ALLOWED_LEAD_TYPES)}

A business may have more than one industry.

IMPORTANT:

Use the business name, current Chamber industry guess, city, and any
reliable public information you can establish about the business.

The Chamber category may be broad or inaccurate.

For example:

- "Construction Services" does NOT automatically mean
  "general_contractor".

- A roofing company listed under "Construction Services"
  should normally be "roofer".

- A plumbing company listed under "Construction & Contractors"
  should be "plumber".

- A window company should be "windows".

- A door replacement company should be "doors".

- A siding company should be "siding".

- A garage-door company may qualify as "garage" and "doors".

- A flooring installer or flooring company should be "flooring".

- A painting company should be "painter".

- A residential remodeling/general construction company may be
  "general_contractor".

Do not classify commercial builders, engineering firms, developers,
suppliers, or unrelated construction companies as
"general_contractor" unless they actually provide the type of
residential/home contracting service represented by our leads.

BOOKKEEPER:

Accounting, bookkeeping, CPA, tax preparation, bookkeeping cleanup,
QuickBooks, payroll, or related financial-record services may use
"bookkeeper".

INSURANCE:

Use "insurance" only when the business appears relevant to the
personal insurance opportunities our system generates, such as
homeowners, auto, renters, or bundled personal insurance.

Do NOT use "insurance" for health-insurance-only businesses.

COMMERCIAL LENDING:

Use "commercial_lending" only when the business actually offers
business/commercial lending or financing.

Do not assign every bank automatically.

HOMECARE:

Use "homecare" for in-home senior care, caregiver services,
elder care, companion care, or similar home-care services.

CHRISTMAS LIGHTS:

Holiday / Christmas lighting installers may use
"christmas_lights".

General landscape/exterior lighting should normally use "lighting".

AUTO BODY:

Use "auto_body" for businesses that actually provide collision repair,
dent repair, body work, hail damage repair, bumper/fender repair,
vehicle painting, refinishing, or similar automotive body services.

Do not use "auto_body" for ordinary mechanical repair shops unless
they also clearly provide body/collision services.

GENERAL CONTRACTOR:

Use "general_contractor" for businesses that actually perform
residential remodeling, renovations, additions, general construction,
or similar homeowner-facing contracting work.

Do not classify a company as "general_contractor" merely because the
Chamber placed it in a broad construction category.

ROOFING:

Use "roofer" for roofing companies, roof repair, roof replacement,
residential roofing contractors, and related roofing services.

PLUMBING:

Use "plumber" for plumbing companies and businesses that actually
provide plumbing installation, repair, drain, water-line, fixture,
water-heater, or similar plumbing services.

ELECTRICAL:

Use "electrician" for electrical contractors and businesses that
actually perform electrical repair, wiring, panel work, outlets,
fixtures, generators, or other electrical services.

WINDOWS:

Use "windows" for companies that install, replace, repair, or sell
replacement windows as a professional service.

DOORS:

Use "doors" for companies that install, replace, or repair residential
doors, entry doors, patio doors, French doors, sliding doors, or
similar door products.

SIDING:

Use "siding" for businesses that install, replace, or repair siding,
including vinyl siding, fiber-cement siding, Hardie siding, or
similar exterior siding products.

FLOORING:

Use "flooring" for flooring installation, replacement, refinishing,
hardwood, engineered wood, laminate, LVP, vinyl, tile flooring,
carpet installation, and similar flooring services.

PAINTING:

Use "painter" for residential or commercial painting companies when
painting is actually one of their offered services.

PEST CONTROL:

Use "pest_control" for pest-control, extermination, termite-control,
rodent-control, or similar professional pest services.

HOUSE CLEANING:

Use "house_cleaner" for residential house-cleaning companies and
professional maid or housekeeping services.

MOVING:

Use "mover" for companies that actually provide moving services.

Do not classify companies that merely sell moving boxes or supplies
as "mover".

GARAGE:

Use "garage" for garage-door repair/installation and other supported
garage-service businesses when appropriate.

A garage-door company may also qualify as "doors".

LANDSCAPING:

Use "landscaping" for landscape installation, design, planting,
hardscape-related landscape work, tree/shrub landscape services,
and similar landscaping businesses.

LAWN CARE:

Use "lawn_care" when the business primarily provides mowing,
fertilization, routine lawn maintenance, turf maintenance, or
similar lawn-care services.

LIGHTING:

Use "lighting" for outdoor lighting, landscape lighting, architectural
lighting, or similar installed lighting services.

Use "christmas_lights" separately for holiday-light installation.

SECURITY:

Use "security" for alarm systems, home-security systems, surveillance,
security cameras, access control, and similar security-service
companies.

INTERIOR DESIGN:

Use "interior_designer" for businesses that actually provide
professional interior-design services.

Do not classify every construction or remodeling company as
"interior_designer".

CONCRETE:

Use "concrete" for concrete installation, repair, patios, driveways,
walkways, slabs, foundations, or similar concrete services when
clearly offered.

FENCING:

Use "fencing" for fence installation, replacement, repair, staining,
or fence contracting businesses.

HANDYMAN:

Use "handyman" for companies that primarily provide general handyman,
small-repair, punch-list, or miscellaneous homeowner repair services.

POWER WASHING:

Use "power_washing" for pressure-washing or power-washing companies.

POOL:

Use "pool" for pool service, pool maintenance, pool repair,
pool equipment, leak repair, pool remodeling, or other pool-service
businesses.

MOLD:

Use "mold" for mold inspection, mold remediation, mold removal,
water-damage remediation involving mold, or similar services.

JUNK REMOVAL:

Use "junk_removal" for companies that actually haul away junk,
furniture, debris, trash, or unwanted household items.

PET SITTER:

Use "pet_sitter" for pet sitting, dog walking, in-home pet care,
or similar pet-care services.

REALTOR:

Use "realtor" for real-estate agents, brokers, and residential
real-estate companies that could serve buyers or sellers.

DENTIST:

Use "dentist" only for actual dental practices or dental professionals.

If the business does not clearly provide one of the supported
services, return an empty array.

It is MUCH better to return [] than to force an incorrect category.

Never invent an unsupported industry.

Every returned industry must exactly match one of the allowed values.

Respond ONLY with JSON.

Return one object for every supplied id:

[
  {
    "id": 123,
    "lead_industries": ["roofer"],
    "reason": "Residential roofing company."
  }
]
`;


/* --------------------------------------------------------------------------
 * Normalize returned industry values
 * ----------------------------------------------------------------------- */

function normalizeIndustries(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const result = [];
    const seen = new Set();

    for (const value of raw) {
        const normalized = String(value || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/-/g, "_");

        if (
            ALLOWED_SET.has(normalized) &&
            !seen.has(normalized)
        ) {
            seen.add(normalized);
            result.push(normalized);
        }
    }

    return result;
}


/* --------------------------------------------------------------------------
 * Parse Sonar JSON response
 * ----------------------------------------------------------------------- */

function extractJsonArray(text) {
    const cleaned = String(text || "")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();

    try {
        const parsed =
            JSON.parse(cleaned);

        if (Array.isArray(parsed)) {
            return parsed;
        }

        if (
            parsed &&
            Array.isArray(parsed.results)
        ) {
            return parsed.results;
        }

        if (
            parsed &&
            Array.isArray(parsed.businesses)
        ) {
            return parsed.businesses;
        }
    } catch {
        // Continue to embedded-array extraction.
    }

    const match =
        cleaned.match(/\[[\s\S]*\]/);

    if (!match) {
        return null;
    }

    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}


/* --------------------------------------------------------------------------
 * Call Perplexity Sonar
 * ----------------------------------------------------------------------- */

async function callSonar(rows) {
    const apiKey =
        process.env.PERPLEXITY_API_KEY;

    if (!apiKey) {
        throw new Error(
            "PERPLEXITY_API_KEY is missing.",
        );
    }

    const payload =
        rows.map((row) => ({
            id: row.id,
            name: row.name,
            company_name:
            row.company_name,
            industry_guess:
            row.industry_guess,
            city:
            row.city,
        }));

    const response =
        await fetch(
            PPLX_API_URL,
            {
                method: "POST",

                headers: {
                    Authorization:
                        `Bearer ${apiKey}`,

                    "Content-Type":
                        "application/json",

                    Accept:
                        "application/json",
                },

                body: JSON.stringify({
                    model:
                    PPLX_MODEL,

                    temperature:
                        0,

                    max_tokens:
                        5000,

                    return_citations:
                        false,

                    messages: [
                        {
                            role:
                                "system",

                            content:
                            SYSTEM_PROMPT,
                        },
                        {
                            role:
                                "user",

                            content:
                                "Classify every Chamber business " +
                                "in the following JSON array. " +
                                "Return exactly one result for every id.\n\n" +
                                JSON.stringify(
                                    payload,
                                ),
                        },
                    ],
                }),
            },
        );

    if (!response.ok) {
        const body =
            await response
                .text()
                .catch(() => "");

        throw new Error(
            `Sonar ${response.status}: ` +
            body.slice(0, 500),
        );
    }

    const data =
        await response.json();

    const content =
        data?.choices?.[0]
            ?.message?.content;

    if (!content) {
        throw new Error(
            "Perplexity API returned no content.",
        );
    }

    return content;
}


/* --------------------------------------------------------------------------
 * Classify one batch
 * ----------------------------------------------------------------------- */

async function classifyBatch(rows) {
    let content =
        await callSonar(rows);

    let classifications =
        extractJsonArray(content);

    /*
     * Sonar occasionally returns malformed JSON.
     * Retry once using the same batch.
     */
    if (!classifications) {
        console.warn(
            "[chamber] Malformed Sonar response. Retrying once...",
        );

        content =
            await callSonar(rows);

        classifications =
            extractJsonArray(content);
    }

    if (!classifications) {
        throw new Error(
            "Could not parse Sonar classification.",
        );
    }

    const byId =
        new Map(
            classifications.map(
                (item) => [
                    Number(item.id),
                    item,
                ],
            ),
        );

    for (const row of rows) {
        const result =
            byId.get(
                Number(row.id),
            );

        if (!result) {
            console.warn(
                `[chamber] No classification returned ` +
                `for Chamber row ${row.id}.`,
            );

            /*
             * Do NOT mark the row classified.
             *
             * Leaving industry_classified_at NULL means the row can
             * automatically be retried during the next run.
             */
            continue;
        }

        const industries =
            normalizeIndustries(
                result.lead_industries,
            );

        const reason =
            String(
                result.reason || "",
            )
                .trim()
                .slice(0, 1000);

        await pool.query(
            `
                UPDATE chamber_of_commerce

                SET
                    lead_industries =
                        $1::text[],

                    industry_classification_reason =
                    $2,

                    industry_classification_model =
                    $3,

                    industry_classified_at =
                    NOW()

                WHERE id =
                    $4
            `,
            [
                industries,
                reason,
                PPLX_MODEL,
                row.id,
            ],
        );

        console.log(
            `[chamber] ${row.id} ` +
            `${row.company_name || row.name || "Unknown business"}: ` +
            `${JSON.stringify(industries)}` +
            (
                reason
                    ? ` — ${reason}`
                    : ""
            ),
        );
    }
}


/* --------------------------------------------------------------------------
 * Main
 * ----------------------------------------------------------------------- */

async function main() {
    console.log(
        "[chamber] Starting Chamber business classification...",
    );

    console.log(
        `[chamber] Sonar model: ${PPLX_MODEL}`,
    );

    console.log(
        `[chamber] Batch size: ${BATCH_SIZE}`,
    );

    console.log(
        `[chamber] Allowed industries: ` +
        `${ALLOWED_LEAD_TYPES.length}`,
    );

    const {
        rows,
    } = await pool.query(
        `
            SELECT
                id,
                name,
                company_name,
                phone,
                email,
                industry_guess,
                city

            FROM chamber_of_commerce

            WHERE
                industry_classified_at
                    IS NULL

            ORDER BY
                id ASC
        `,
    );

    console.log(
        `[chamber] ${rows.length} business(es) ` +
        `need classification.`,
    );

    if (!rows.length) {
        console.log(
            "[chamber] Nothing to classify.",
        );

        return;
    }

    for (
        let index = 0;
        index < rows.length;
        index += BATCH_SIZE
    ) {
        const batch =
            rows.slice(
                index,
                index + BATCH_SIZE,
            );

        const startNumber =
            index + 1;

        const endNumber =
            index + batch.length;

        console.log(
            `[chamber] Classifying businesses ` +
            `${startNumber}-${endNumber} ` +
            `of ${rows.length}...`,
        );

        try {
            await classifyBatch(
                batch,
            );
        } catch (error) {
            /*
             * Stop instead of incorrectly marking an entire bad batch.
             *
             * Because rows remain industry_classified_at IS NULL,
             * another run can pick them back up.
             */
            console.error(
                `[chamber] Classification failed for batch ` +
                `${startNumber}-${endNumber}:`,
                error,
            );

            throw error;
        }
    }

    console.log(
        "[chamber] Classification complete.",
    );
}


/* --------------------------------------------------------------------------
 * Run
 * ----------------------------------------------------------------------- */

main()
    .catch((error) => {
        console.error(
            "[chamber] Fatal:",
            error,
        );

        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await pool.end();
        } catch (error) {
            console.error(
                "[chamber] Error closing database pool:",
                error,
            );
        }
    });
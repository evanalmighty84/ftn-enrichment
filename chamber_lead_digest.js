#!/usr/bin/env node

"use strict";

require("dotenv").config();

const { Pool } = require("pg");

const allowedChamberIds =
    String(
        process.env.CHAMBER_DIGEST_ALLOWED_IDS || ""
    )
        .split(",")
        .map((value) =>
            Number(value.trim())
        )
        .filter((value) =>
            Number.isSafeInteger(value) &&
            value > 0
        );

const allowedChamberIdSet =
    new Set(
        allowedChamberIds
    );
/* --------------------------------------------------------------------------
 * Database
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
 * Configuration
 * ----------------------------------------------------------------------- */

const DIGEST_SIZE = 10;
const CHAMBER_DIGEST_COOLDOWN_HOURS =
    Number.parseInt(
        process.env.CHAMBER_DIGEST_COOLDOWN_HOURS || "24",
        10,
    );

const ENABLED =
    /^(1|true|yes)$/i.test(
        String(
            process.env.CHAMBER_DIGEST_ENABLED || "0",
        ).trim(),
    );

const API_BASE_URL =
    String(
        process.env.CLUBHOUSE_API_BASE_URL || "",
    )
        .trim()
        .replace(/\/+$/, "");

const CHAMBER_ALERT_SECRET =
    String(
        process.env.CHAMBER_ALERT_SECRET || "",
    ).trim();

const MAX_AGE_DAYS =
    Number.parseInt(
        process.env.CHAMBER_LEAD_MAX_AGE_DAYS || "30",
        10,
    );

const REQUEST_TIMEOUT_MS =
    Number.parseInt(
        process.env.CHAMBER_DIGEST_REQUEST_TIMEOUT_MS ||
        "45000",
        10,
    );


/* --------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

function normalizeEmail(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function normalizeIndustry(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/-/g, "_");
}


/* --------------------------------------------------------------------------
 * Eligible Chamber recipients
 * ----------------------------------------------------------------------- */

async function loadRecipients() {
    const {
        rows,
    } = await pool.query(
        `
            SELECT
                c.id,
                c.name,
                c.company_name,
                c.email,
                c.city,
                c.lead_industries

            FROM chamber_of_commerce c

            WHERE
                NULLIF(
                        BTRIM(c.email),
                        ''
                ) IS NOT NULL

              AND CARDINALITY(
                          COALESCE(
                                  c.lead_industries,
                                  ARRAY[]::text[]
                          )
                  ) > 0


                /*
                 * ---------------------------------------------
                 * Skip unsubscribed recipients.
                 * ---------------------------------------------
                 */

              AND NOT EXISTS (
                SELECT 1

                FROM chamber_email_unsubscribes u

                WHERE
                    LOWER(
                            BTRIM(u.email)
                    ) =
                    LOWER(
                            BTRIM(c.email)
                    )

                  AND u.unsubscribed_at
                    IS NOT NULL
            )


                /*
                 * ---------------------------------------------
                 * 24-hour recipient cooldown.
                 *
                 * If this email received ANY Chamber digest
                 * in the last X hours, don't process it.
                 *
                 * Include pending as well as sent so that an
                 * uncertain SMTP/database state cannot cause
                 * a duplicate email.
                 * ---------------------------------------------
                 */

              AND NOT EXISTS (
                SELECT 1

                FROM chamber_lead_email_log log

                WHERE
                    LOWER(
                            BTRIM(log.recipient_email)
                    ) =
                    LOWER(
                            BTRIM(c.email)
                    )

                  AND log.status IN (
                                     'pending',
                                     'sent'
                    )

                  AND log.sent_at >=
                      NOW() -
                      (
                          $1::int *
                          INTERVAL '1 hour'
                          )
            )

            ORDER BY
                c.id ASC;
        `,
        [
            CHAMBER_DIGEST_COOLDOWN_HOURS,
        ],
    );

    return rows;
}


/* --------------------------------------------------------------------------
 * Get next ten unsent leads for recipient + industry
 * ----------------------------------------------------------------------- */

async function loadLeadBatch(
    recipientEmail,
    industry,
) {
    const {
        rows,
    } = await pool.query(
        `
            SELECT
                f.id,
                f.scraped_at

            FROM familytreenow f

            WHERE
                $1 = ANY(
                    string_to_array(
                            TRIM(
                                    BOTH '{}'
                                    FROM LOWER(
                                            REPLACE(
                                                    COALESCE(
                                                            f.lead_type,
                                                            ''
                                                    ),
                                                    ' ',
                                                    ''
                                            )
                                         )
                            ),
                            ','
                    )
                    )

              AND NULLIF(
                    BTRIM(f.description),
                    ''
                  ) IS NOT NULL

              AND (
                $3::int <= 0

                OR f.scraped_at >=
                   NOW() -
                   (
                       $3::int *
                       INTERVAL '1 day'
                   )
                )

              AND NOT EXISTS (
                SELECT 1

                FROM chamber_lead_email_log log

                WHERE
                    log.lead_id = f.id

                  AND LOWER(
                              BTRIM(log.recipient_email)
                      ) =
                      LOWER(
                              BTRIM($2)
                      )
            )

            ORDER BY
                f.scraped_at DESC,
                f.id DESC

                LIMIT ${DIGEST_SIZE};
        `,
        [
            industry,
            recipientEmail,
            MAX_AGE_DAYS,
        ],
    );

    return rows;
}


/* --------------------------------------------------------------------------
 * Call Clubhouse Links backend
 * ----------------------------------------------------------------------- */

async function sendDigest({
                              chamberRecordId,
                              industry,
                              leadIds,
                          }) {
    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            REQUEST_TIMEOUT_MS,
        );

    try {
        const response =
            await fetch(
                `${API_BASE_URL}` +
                `/send-chamber-lead-digest`,
                {
                    method: "POST",

                    signal:
                    controller.signal,

                    headers: {
                        "Content-Type":
                            "application/json",

                        "x-chamber-alert-secret":
                        CHAMBER_ALERT_SECRET,
                    },

                    body:
                        JSON.stringify({
                            chamber_record_id:
                            chamberRecordId,

                            industry,

                            lead_ids:
                            leadIds,
                        }),
                },
            );

        const text =
            await response.text();

        let body = null;

        try {
            body =
                text
                    ? JSON.parse(text)
                    : {};
        } catch {
            body = {
                raw: text,
            };
        }

        if (!response.ok) {
            throw new Error(
                `Backend returned ${response.status}: ` +
                JSON.stringify(body),
            );
        }

        return body;
    } finally {
        clearTimeout(timeout);
    }
}


/* --------------------------------------------------------------------------
 * Main
 * ----------------------------------------------------------------------- */

async function main() {
    console.log(
        "[chamber-digest] Starting...",
    );

    /*
     * Deploy safely before turning outbound email on.
     */
    if (!ENABLED) {
        console.log(
            "[chamber-digest] CHAMBER_DIGEST_ENABLED is off. Nothing sent.",
        );

        return;
    }

    if (!API_BASE_URL) {
        throw new Error(
            "CLUBHOUSE_API_BASE_URL is required.",
        );
    }

    if (!CHAMBER_ALERT_SECRET) {
        throw new Error(
            "CHAMBER_ALERT_SECRET is required.",
        );
    }

    const recipients =
        await loadRecipients();

    console.log(
        `[chamber-digest] ${recipients.length} eligible Chamber recipient(s).`,
    );

    let sent = 0;
    let waiting = 0;
    let failed = 0;

    for (const recipient of recipients) {

        /*
         * ---------------------------------------------------------
         * Optional first-wave Chamber whitelist
         *
         * If CHAMBER_DIGEST_ALLOWED_IDS is empty,
         * everybody is allowed.
         *
         * If it contains IDs, only those Chamber records run.
         * ---------------------------------------------------------
         */

        if (
            allowedChamberIdSet.size > 0 &&
            !allowedChamberIdSet.has(
                Number(recipient.id)
            )
        ) {
            console.log(
                `[chamber-digest] SKIP ` +
                `${recipient.company_name || recipient.name} ` +
                `(Chamber ID ${recipient.id} not allowed)`
            );

            continue;
        }


        const email =
            normalizeEmail(
                recipient.email,
            );

        const industries =
            [
                ...new Set(
                    (
                        Array.isArray(
                            recipient.lead_industries,
                        )
                            ? recipient.lead_industries
                            : []
                    )
                        .map(
                            normalizeIndustry,
                        )
                        .filter(Boolean),
                ),
            ];

        for (const industry of industries) {
            const leads =
                await loadLeadBatch(
                    email,
                    industry,
                );

            if (
                leads.length <
                DIGEST_SIZE
            ) {
                console.log(
                    `[chamber-digest] WAIT ` +
                    `${recipient.company_name || recipient.name} ` +
                    `(${industry}): ` +
                    `${leads.length}/${DIGEST_SIZE}`,
                );

                waiting += 1;
                continue;
            }

            const leadIds =
                leads.map(
                    (lead) =>
                        Number(lead.id),
                );

            console.log(
                `[chamber-digest] SEND ` +
                `${recipient.company_name || recipient.name} ` +
                `(${industry}) -> ${email}: ` +
                leadIds.join(", "),
            );

            try {
                const result =
                    await sendDigest({
                        chamberRecordId:
                        recipient.id,

                        industry,

                        leadIds,
                    });

                sent += 1;

                console.log(
                    `[chamber-digest] SENT batch ` +
                    `${result.batch_id || "(unknown)"} ` +
                    `to ${email}.`,
                );

                /*
                 * One successful digest max
                 * per recipient during this run.
                 */
                break;

            } catch (error) {
                failed += 1;

                console.error(
                    `[chamber-digest] FAILED ` +
                    `${email} / ${industry}:`,
                    error.message,
                );
            }
        }
    }

    console.log(
        `[chamber-digest] Complete. ` +
        `sent=${sent}, ` +
        `waiting=${waiting}, ` +
        `failed=${failed}`,
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
}


main()
    .catch((error) => {
        console.error(
            "[chamber-digest] Fatal:",
            error,
        );

        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
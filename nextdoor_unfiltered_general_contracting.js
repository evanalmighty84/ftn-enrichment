#!/usr/bin/env node

"use strict";

require("dotenv").config();

const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const pool = require("./db/db");
const normalizeCity = require("./normalizeCity");

const TABLE_NAME = "unfiltered_general_contracting";

const ENRICHMENT_ENDPOINT_PATH =
    "/server/crm_function/api/ftn/enrichment";

const CRM_API_BASE_URL =
    process.env.CRM_API_BASE_URL ||
    process.env.API_BASE_URL ||
    "https://crm-function-app-5d4de511071d.herokuapp.com";

const MAX_POSTS_PER_TERM = Number(
    process.env.GENERAL_CONTRACTING_MAX_POSTS || 50,
);
const FALLBACK_STATE =
    process.env.GENERAL_CONTRACTING_FALLBACK_STATE || "TX";

const SEARCH_TERMS = [
    "general contractor",
    "build a deck",
    "remodeling recommendations",
    "fence builder",
];

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

function cleanText(value = "") {
    return String(value).replace(/\s+/g, " ").trim();
}

function normalizePostUrl(url) {
    try {
        const parsed = new URL(url);
        const postId =
            parsed.pathname.match(/\/(?:p|posting)\/([^/?#]+)/i)?.[1];

        return postId
            ? `https://nextdoor.com/p/${postId}`
            : `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
}

function parseExplicitLocation(location = "") {
    const clean = cleanText(location);
    const match = clean.match(/^(.+?),\s*([A-Z]{2})$/);

    return match
        ? {
            city: match[1].trim(),
            state: match[2].trim(),
        }
        : {
            city: clean || null,
            state: null,
        };
}

function guessCity(location = "") {
    const lower = location.toLowerCase();

    const knownCities = [
        "allen",
        "mckinney",
        "plano",
        "frisco",
        "dallas",
        "prosper",
        "little elm",
        "richardson",
        "garland",
        "carrollton",
        "mesquite",
        "arlington",
        "grapevine",
        "sachse",
        "celina",
        "lewisville",
        "desoto",
        "north richland hills",
        "lowry crossing",
        "melissa",
    ];

    const direct = knownCities.find((city) => lower.includes(city));

    if (direct) return direct;
    if (lower.includes("craig ranch")) return "mckinney";
    if (lower.includes("eldorado")) return "mckinney";
    if (lower.includes("trinity falls")) return "mckinney";
    if (lower.includes("stonebridge ranch")) return "mckinney";
    if (lower.includes("westridge")) return "mckinney";
    if (lower.includes("mckinney north")) return "mckinney";

    return null;
}

async function resolveCityState({ location, description }) {
    const explicit = parseExplicitLocation(location);

    let city = explicit.city;
    let state = explicit.state || FALLBACK_STATE;

    const guessed = guessCity(location);
    if (guessed) city = guessed;

    try {
        const normalized = await normalizeCity({
            city,
            state,
            location,
            description,
        });

        return {
            city: normalized?.city || city || null,
            state: normalized?.state || state || null,
        };
    } catch (error) {
        console.warn(
            `⚠️ normalizeCity failed for "${location}": ${error.message}`,
        );

        return {
            city: city || null,
            state: state || null,
        };
    }
}

async function getCurrentNextdoorPage(context) {
    const pages = context.pages().filter((page) => !page.isClosed());

    return (
        pages.find((page) => /nextdoor\.com/i.test(page.url())) ||
        pages[0] ||
        context.newPage()
    );
}

async function findVisibleSearchBox(page) {
    const selectors = [
        'input[aria-label="Search Nextdoor"]',
        'input[placeholder*="Search Nextdoor" i]',
        'input[type="search"]',
        '[data-testid="search-input"] input',
    ];

    for (const selector of selectors) {
        const candidate = page.locator(selector).first();

        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            return candidate;
        }
    }

    return null;
}

async function waitForNextdoorReady(context, totalMs = 120_000) {
    console.log(
        "⏳ Waiting for the Multilogin profile and Nextdoor feed to finish loading...",
    );
    console.log(`   Context has ${context.pages().length} page(s) open`);

    const deadline = Date.now() + totalMs;
    let page = null;
    let navigatedToFeed = false;

    console.log("   Sleeping 7s for Multilogin to stabilize...");
    await sleep(7_000);
    console.log("   Initial sleep done, entering wait loop...");

    while (Date.now() < deadline) {
        const remaining = Math.round((deadline - Date.now()) / 1_000);
        console.log(`   ⏱ Polling... ${remaining}s remaining`);

        page = await getCurrentNextdoorPage(context);

        if (page && !page.isClosed()) {
            const url = page.url();
            console.log(`   Current page URL: ${url}`);

            if (/nextdoor\.com/i.test(url)) {
                const searchBox = await findVisibleSearchBox(page);

                if (searchBox) {
                    console.log(`✅ Nextdoor is ready: ${url}`);
                    return page;
                }

                if (/\/(login|verify|choose_address)/i.test(url)) {
                    console.log(
                        `ℹ️ Waiting for Nextdoor login/interstitial: ${url}`,
                    );
                } else {
                    console.log(
                        `   Nextdoor page is open but still hydrating: ${url}`,
                    );
                }
            } else if (!navigatedToFeed) {
                navigatedToFeed = true;
                console.log("🧭 Opening the Nextdoor news feed...");

                await page
                    .goto("https://nextdoor.com/news_feed/", {
                        waitUntil: "domcontentloaded",
                        timeout: 60_000,
                    })
                    .catch((error) => {
                        console.log(
                            `ℹ️ Initial feed navigation is still settling: ${error.message}`,
                        );
                    });
            } else {
                console.log(`   Non-Nextdoor page still open: ${url}`);
            }
        } else {
            console.log("   No open page found in context yet...");
        }

        await sleep(2_500);
    }

    throw new Error(
        "Nextdoor did not finish loading within 2 minutes. " +
        "Open the feed in the Multilogin profile and run the script again.",
    );
}

async function goToPostsTab(page, query) {
    const candidates = [
        page.getByRole("tab", { name: /^Posts$/i }).first(),
        page.locator('[data-testid="tab-posts"]').first(),
        page.locator("a,button").filter({ hasText: /^Posts$/i }).first(),
    ];

    for (const candidate of candidates) {
        try {
            if (
                (await candidate.count()) &&
                (await candidate.isVisible())
            ) {
                await candidate.click();
                await sleep(1_600);
                console.log("✅ Opened Posts results.");
                return;
            }
        } catch {}
    }

    await page.goto(
        `https://nextdoor.com/search/posts/?query=${encodeURIComponent(query)}`,
        {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
        },
    );

    await sleep(2_000);
    console.log("✅ Opened Posts results directly.");
}

async function applyMostRecentFilter(page) {
    console.log("🔃 Applying Most Recent sort...");

    const triggerCandidates = [
        page.locator('[aria-label="Sort By"]').first(),
        page.locator('div[role="button"][aria-label="Sort By"]').first(),
        page
            .locator("button, [role=button]")
            .filter({ hasText: /^(Most Relevant|Most Recent)$/i })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        console.log("ℹ️ Could not find the sort control.");
        return false;
    }

    const currentText = cleanText(await trigger.innerText().catch(() => ""));

    if (/most recent/i.test(currentText)) {
        console.log("✅ Most Recent was already selected.");
        return true;
    }

    await trigger.click();
    await sleep(500);

    const optionCandidates = [
        page.getByRole("menuitem", { name: /^Most Recent$/i }).first(),
        page.getByRole("option", { name: /^Most Recent$/i }).first(),
        page.getByText(/^Most Recent$/i).last(),
    ];

    for (const option of optionCandidates) {
        if (
            (await option.count().catch(() => 0)) &&
            (await option.isVisible().catch(() => false))
        ) {
            await option.click();
            await sleep(1_000);
            console.log("✅ Applied Most Recent.");
            return true;
        }
    }

    console.log("ℹ️ Most Recent option was not found.");
    return false;
}

async function applyDistanceFilter(page, targetMiles = 15) {
    console.log(`📍 Applying ${targetMiles}-mile distance filter...`);

    const triggerCandidates = [
        page
            .getByRole("button", {
                name: /(?:\d+\s*miles?|distance)/i,
            })
            .first(),
        page
            .locator("button, [role=button]")
            .filter({ hasText: /\d+\s*miles?/i })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        console.log("ℹ️ Could not find the distance control.");
        return false;
    }

    const currentText = cleanText(await trigger.innerText().catch(() => ""));

    if (new RegExp(`^${targetMiles}\\s*miles?$`, "i").test(currentText)) {
        console.log(`✅ Distance was already ${targetMiles} miles.`);
        return true;
    }

    await trigger.click();
    await sleep(500);

    const exactLabel = new RegExp(`^${targetMiles}\\s*miles?$`, "i");

    const optionCandidates = [
        page.getByRole("menuitem", { name: exactLabel }).first(),
        page.getByRole("option", { name: exactLabel }).first(),
        page.getByText(exactLabel).last(),
    ];

    for (const option of optionCandidates) {
        if (
            (await option.count().catch(() => 0)) &&
            (await option.isVisible().catch(() => false))
        ) {
            await option.click();
            await sleep(1_000);
            console.log(`✅ Applied ${targetMiles} miles.`);
            return true;
        }
    }

    const slider = page.locator('.rc-slider-handle[role="slider"]').first();

    if (
        (await slider.count().catch(() => 0)) &&
        (await slider.isVisible().catch(() => false))
    ) {
        await slider.focus();

        let current = Number(await slider.getAttribute("aria-valuenow"));

        if (!Number.isFinite(current)) current = 1;

        while (current > 1) {
            await page.keyboard.press("ArrowLeft");
            current -= 1;
        }

        for (let value = 1; value < targetMiles; value += 1) {
            await page.keyboard.press("ArrowRight");
        }

        await sleep(800);

        const finalValue = await slider.getAttribute("aria-valuenow");

        console.log(
            `✅ Distance slider set to ${finalValue || targetMiles} miles.`,
        );

        await page.keyboard.press("Escape").catch(() => {});
        return true;
    }

    console.log(
        `ℹ️ Could not find the ${targetMiles}-mile option or slider.`,
    );
    return false;
}

async function applyTodayFilter(page) {
    console.log('🗓️ Applying "Today" date filter...');

    const triggerCandidates = [
        page
            .getByRole("button", {
                name: /^(All Time|Today|This Week|This Month|This Year)$/i,
            })
            .first(),
        page
            .locator("button, [role=button]")
            .filter({
                hasText:
                    /^(All Time|Today|This Week|This Month|This Year)$/i,
            })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        console.log("ℹ️ Could not find the date filter.");
        return false;
    }

    const currentText = cleanText(await trigger.innerText().catch(() => ""));

    if (/^today$/i.test(currentText)) {
        console.log('✅ Date was already set to "Today".');
        return true;
    }

    await trigger.click();
    await sleep(500);

    const optionCandidates = [
        page.getByRole("menuitem", { name: /^Today$/i }).first(),
        page.getByRole("option", { name: /^Today$/i }).first(),
        page.getByText(/^Today$/i).last(),
    ];

    for (const option of optionCandidates) {
        if (
            (await option.count().catch(() => 0)) &&
            (await option.isVisible().catch(() => false))
        ) {
            await option.click();
            await sleep(1_000);
            console.log('✅ Applied "Today".');
            return true;
        }
    }

    console.log('ℹ️ Could not find the "Today" option.');
    return false;
}

async function searchNextdoor(page, query) {
    console.log("");
    console.log("============================================================");
    console.log(`🔍 Searching Nextdoor for "${query}"...`);
    console.log("============================================================");

    if (!/nextdoor\.com/i.test(page.url())) {
        await page.goto("https://nextdoor.com/news_feed/", {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
        });
    }

    let searchBox = await findVisibleSearchBox(page);

    if (!searchBox) {
        console.log(
            "⏳ Search bar is not visible yet; waiting up to 10 more seconds...",
        );

        const deadline = Date.now() + 10_000;

        while (Date.now() < deadline && !searchBox) {
            await sleep(1_500);
            searchBox = await findVisibleSearchBox(page);
        }
    }

    if (!searchBox) {
        throw new Error(
            "Could not find the Nextdoor search bar after waiting for the feed.",
        );
    }

    await searchBox.click();
    await searchBox.fill(query);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(3_000);

    await goToPostsTab(page, query);
    await applyMostRecentFilter(page);
    await applyDistanceFilter(page, 15);
    await applyTodayFilter(page);
    await sleep(1_800);
}

async function collectPostLinks(page, limit = MAX_POSTS_PER_TERM) {
    console.log("⬇️ Loading search results...");

    let previousCount = -1;
    let stablePasses = 0;

    for (let pass = 1; pass <= 20; pass += 1) {
        const count = await page
            .locator('a[href*="/p/"], a[href*="/posting/"]')
            .count();

        console.log(`   pass ${pass}: ${count} links loaded`);

        stablePasses =
            count === previousCount ? stablePasses + 1 : 0;

        previousCount = count;

        if (stablePasses >= 4) break;

        await page.mouse.wheel(0, 1_700);
        await sleep(900);
    }

    const raw = await page.evaluate((maxResults) => {
        const results = [];
        const seen = new Set();

        for (const anchor of document.querySelectorAll(
            'a[href*="/p/"], a[href*="/posting/"]',
        )) {
            const href = anchor.href;

            if (!href || seen.has(href)) continue;

            const root =
                anchor.closest("article, [role=article], li") ||
                anchor.parentElement;

            const preview = (
                root?.innerText ||
                anchor.innerText ||
                ""
            )
                .replace(/\s+/g, " ")
                .trim();

            if (preview.length < 15) continue;

            seen.add(href);

            results.push({
                url: href,
                preview: preview.slice(0, 1_500),
            });

            if (results.length >= maxResults) break;
        }

        return results;
    }, limit);

    const unique = new Map();

    for (const post of raw) {
        const normalizedUrl = normalizePostUrl(post.url);

        unique.set(normalizedUrl, {
            ...post,
            url: normalizedUrl,
        });
    }

    const posts = [...unique.values()];

    console.log(`🔗 Found ${posts.length} unique posts.`);
    return posts;
}

async function getExistingUrls(posts) {
    const urls = posts.map((post) => normalizePostUrl(post.url));

    if (!urls.length) return new Set();

    const { rows } = await pool.query(
        `
            SELECT post_url
            FROM ${TABLE_NAME}
            WHERE post_url = ANY($1::text[])
        `,
        [urls],
    );

    return new Set(
        rows.map((row) => normalizePostUrl(row.post_url)),
    );
}

async function expandSeeMore(page) {
    const buttons = page.locator(
        'button:has-text("See more"), [data-testid="see-more-text"]',
    );

    const count = Math.min(await buttons.count(), 4);

    for (let index = 0; index < count; index += 1) {
        try {
            if (await buttons.nth(index).isVisible()) {
                await buttons.nth(index).click({ timeout: 1_200 });
                await sleep(250);
            }
        } catch {}
    }
}

async function extractAuthor(page) {
    const selectors = [
        'a[href*="/profile/"][href*="detail_author"]',
        'a[href*="/profile/"][href*="is=detail_author"]',
        'main article a[href*="/profile/"]',
        'a[href*="/profile/"]',
    ];

    for (const selector of selectors) {
        const links = page.locator(selector);
        const count = Math.min(await links.count(), 15);

        for (let index = 0; index < count; index += 1) {
            try {
                const link = links.nth(index);
                const text = cleanText(await link.innerText());

                if (
                    /^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+){1,5}$/.test(
                        text,
                    )
                ) {
                    return text;
                }

                const aria = await link
                    .locator('[aria-label*="Avatar for" i]')
                    .first()
                    .getAttribute("aria-label")
                    .catch(() => null);

                if (aria) {
                    return cleanText(
                        aria.replace(/^Avatar for\s*/i, ""),
                    );
                }
            } catch {}
        }
    }

    return null;
}

async function extractPostDetails(detailPage, post, searchTerm) {
    const url = normalizePostUrl(post.url);

    await detailPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
    });

    await detailPage
        .waitForURL(
            (current) =>
                normalizePostUrl(current.href) === url,
            { timeout: 12_000 },
        )
        .catch(() => {});

    await sleep(1_400);
    await expandSeeMore(detailPage);

    const author = await extractAuthor(detailPage);

    const extracted = await detailPage.evaluate(
        ({ preview }) => {
            const clean = (value) =>
                (value || "").replace(/\s+/g, " ").trim();

            const junk =
                /Home For Sale & Free Local News Ask Alerts Groups Events Post Settings Help Center/i;

            const tokens = clean(preview)
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((word) => word.length >= 4);

            const tokenSet = new Set(tokens.slice(0, 80));
            const candidates = [];

            const selectors = [
                '[data-testid="post-body-text"]',
                '[data-testid="styled-text-wrapper"]',
                'span[data-testid="styled-text"]',
                ".postTextBodySpan",
                'main [dir="auto"]',
            ];

            for (const selector of selectors) {
                for (const element of document.querySelectorAll(selector)) {
                    const text = clean(
                        element.innerText ||
                        element.textContent,
                    );

                    if (
                        text.length < 20 ||
                        text.length > 7_000 ||
                        junk.test(text)
                    ) {
                        continue;
                    }

                    const words = text
                        .toLowerCase()
                        .split(/[^a-z0-9]+/);

                    const overlap = words.reduce(
                        (total, word) =>
                            total + (tokenSet.has(word) ? 1 : 0),
                        0,
                    );

                    candidates.push({
                        text,
                        score:
                            overlap * 100 +
                            Math.min(text.length, 1_500),
                    });
                }
            }

            candidates.sort((a, b) => b.score - a.score);

            const description =
                candidates[0]?.text ||
                clean(preview) ||
                null;

            let location = null;

            const neighborhoodLinks = [
                ...document.querySelectorAll(
                    'a[href*="/neighborhood/"]',
                ),
            ];

            for (const link of neighborhoodLinks) {
                const text = clean(link.innerText);

                if (text && text.length < 100) {
                    location = text;
                    break;
                }
            }

            if (!location) {
                const lines = document.body.innerText
                    .split("\n")
                    .map(clean)
                    .filter(Boolean);

                const explicit = lines.find((line) =>
                    /^[A-Za-z .'-]+,\s*[A-Z]{2}$/.test(line),
                );

                if (explicit) location = explicit;
            }

            return {
                description,
                location,
            };
        },
        { preview: post.preview },
    );

    const description = cleanText(
        extracted.description || post.preview,
    );

    const location = cleanText(
        extracted.location || "",
    );

    const cityState = await resolveCityState({
        location,
        description,
    });

    return {
        author,
        location: location || null,
        description,
        post_url: url,
        city: cityState.city,
        state: cityState.state,
        lead_type: "general_contracting",
        search_term: searchTerm,
    };
}

async function insertUnfilteredGeneralContracting(record) {
    const query = `
        INSERT INTO ${TABLE_NAME}
        (
            author,
            location,
            description,
            post_url,
            city,
            state,
            lead_type,
            timestamp
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (post_url) DO UPDATE SET
            author = COALESCE(
                                          EXCLUDED.author,
                                          ${TABLE_NAME}.author
                                          ),
                                          location = COALESCE(
                                          EXCLUDED.location,
                                          ${TABLE_NAME}.location
                                          ),
                                          description = COALESCE(
                                          EXCLUDED.description,
                                          ${TABLE_NAME}.description
                                          ),
                                          city = COALESCE(
                                          EXCLUDED.city,
                                          ${TABLE_NAME}.city
                                          ),
                                          state = COALESCE(
                                          EXCLUDED.state,
                                          ${TABLE_NAME}.state
                                          ),
                                          lead_type = COALESCE(
                                          EXCLUDED.lead_type,
                                          ${TABLE_NAME}.lead_type
                                          )
                                          RETURNING id
    `;

    await pool.query(query, [
        record.author,
        record.location,
        record.description,
        record.post_url,
        record.city,
        record.state,
        record.lead_type,
    ]);

    console.log(
        `✅ Saved: ${record.author || "(unknown)"} → ` +
        `${record.city || "(unknown city)"}, ` +
        `${record.state || "(unknown state)"}`,
    );
}

async function processSearchTerm({
                                     page,
                                     detailPage,
                                     query,
                                     seenDuringRun,
                                 }) {
    await searchNextdoor(page, query);

    const allPosts = await collectPostLinks(
        page,
        MAX_POSTS_PER_TERM,
    );

    const uniqueForThisRun = allPosts.filter((post) => {
        const url = normalizePostUrl(post.url);

        if (seenDuringRun.has(url)) return false;

        seenDuringRun.add(url);
        return true;
    });

    console.log(
        `🔁 Cross-term duplicate check: ` +
        `${allPosts.length - uniqueForThisRun.length} already found ` +
        `during this run, ${uniqueForThisRun.length} remain.`,
    );

    const existing = await getExistingUrls(uniqueForThisRun);

    const posts = uniqueForThisRun.filter(
        (post) =>
            !existing.has(normalizePostUrl(post.url)),
    );

    console.log(
        `🧱 Database duplicate check: ` +
        `${existing.size} existing, ${posts.length} new.`,
    );

    let inserted = 0;
    let failed = 0;

    for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];

        console.log(
            `\n[${index + 1}/${posts.length}] ` +
            `"${query}" → ${post.url}`,
        );

        try {
            const record = await extractPostDetails(
                detailPage,
                post,
                query,
            );

            console.dir(record, { depth: null });

            if (
                !record.description ||
                record.description.length < 10
            ) {
                console.log("⏭️ No usable description.");
                continue;
            }

            await insertUnfilteredGeneralContracting(record);
            inserted += 1;
        } catch (error) {
            console.error(`❌ Failed: ${error.message}`);
            failed += 1;
        }

        await sleep(
            650 + Math.floor(Math.random() * 700),
        );
    }

    return {
        inserted,
        failed,
        existingSkipped: existing.size,
        crossTermSkipped:
            allPosts.length - uniqueForThisRun.length,
    };
}

function triggerFtnEnrichmentInBackground({
                                              totalInserted,
                                              totalFailed,
                                              totalExistingSkipped,
                                              totalCrossTermSkipped,
                                          }) {
    if (!CRM_API_BASE_URL) {
        throw new Error(
            "CRM_API_BASE_URL is missing. Set it to the host that serves " +
            ENRICHMENT_ENDPOINT_PATH,
        );
    }

    const endpointUrl = new URL(
        ENRICHMENT_ENDPOINT_PATH,
        CRM_API_BASE_URL,
    ).toString();

    const payload = {
        source_table: TABLE_NAME,
        lead_type: "general_contracting",
        scrape_summary: {
            inserted: totalInserted,
            failed: totalFailed,
            existing_db_posts_skipped:
            totalExistingSkipped,
            cross_term_duplicates_skipped:
            totalCrossTermSkipped,
        },
    };

    const backgroundScript = `
        const endpointUrl = ${JSON.stringify(endpointUrl)};
        const payload = ${JSON.stringify(payload)};

        fetch(endpointUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        }).catch(() => {});
    `;

    console.log("");
    console.log("============================================================");
    console.log("🚀 Launching FTN enrichment trigger in the background...");
    console.log(`   Endpoint: ${endpointUrl}`);
    console.log("============================================================");

    const child = spawn(
        process.execPath,
        ["-e", backgroundScript],
        {
            detached: true,
            stdio: "ignore",
            env: process.env,
        },
    );

    child.unref();

    console.log(
        "✅ FTN enrichment trigger launched independently.",
    );
}

async function main() {
    console.log(
        "🏗️ Nextdoor Unfiltered General Contracting Scraper Started",
    );

    if (!process.env.MULTILOGIN_WS) {
        throw new Error("MULTILOGIN_WS is missing.");
    }

    const browser = await chromium.connectOverCDP(
        process.env.MULTILOGIN_WS,
    );

    const context = browser.contexts()[0];

    if (!context) {
        throw new Error("No Multilogin browser context found.");
    }

    const searchPage = await waitForNextdoorReady(
        context,
        120_000,
    );

    searchPage.setDefaultTimeout(30_000);
    searchPage.setDefaultNavigationTimeout(60_000);

    await searchPage.bringToFront();

    const detailPage = await context.newPage();

    detailPage.setDefaultTimeout(30_000);
    detailPage.setDefaultNavigationTimeout(60_000);

    await searchPage.bringToFront();

    const seenDuringRun = new Set();

    let totalInserted = 0;
    let totalFailed = 0;
    let totalExistingSkipped = 0;
    let totalCrossTermSkipped = 0;

    try {
        for (const query of SEARCH_TERMS) {
            const result = await processSearchTerm({
                page: searchPage,
                detailPage,
                query,
                seenDuringRun,
            });

            totalInserted += result.inserted;
            totalFailed += result.failed;
            totalExistingSkipped +=
                result.existingSkipped;
            totalCrossTermSkipped +=
                result.crossTermSkipped;

            await searchPage.bringToFront();
            await sleep(1_500);
        }

        console.log("");
        console.log(
            "============================================================",
        );
        console.log("✅ General contracting scrape finished.");
        console.log(`   Inserted: ${totalInserted}`);
        console.log(`   Failed: ${totalFailed}`);
        console.log(
            `   Existing DB posts skipped: ${totalExistingSkipped}`,
        );
        console.log(
            `   Cross-term duplicates skipped: ${totalCrossTermSkipped}`,
        );
        console.log(
            "============================================================",
        );

        // All posts are inserted before this background trigger is launched.
        triggerFtnEnrichmentInBackground({
            totalInserted,
            totalFailed,
            totalExistingSkipped,
            totalCrossTermSkipped,
        });

        console.log("");
        console.log(
            "✅ Scrape completed. FTN enrichment is running separately.",
        );
    } finally {
        await detailPage.close().catch(() => {});
        await searchPage.bringToFront().catch(() => {});
        await pool.end().catch(() => {});
    }
}

main().catch(async (error) => {
    console.error("❌ Fatal error:", error.message);
    await pool.end().catch(() => {});
    process.exit(1);
});

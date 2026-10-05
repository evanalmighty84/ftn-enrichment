#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

const targetPath = path.join(__dirname, "ftn_enrichment.js");
const source = fs.readFileSync(targetPath, "utf8");

const startMarker = [
    "    console.log(",
    "        `[WARN] Exact autocomplete location was not offered: ${target}` ,",
].join("\n");

// Keep this marker deliberately short and unique so the patch remains easy
// to audit while still failing closed if the source changes substantially.
const fallbackStart = source.indexOf(
    "    const visibleSuggestions =\n        await getVisibleAutocompleteTexts(page);",
    source.indexOf("[WARN] Exact autocomplete location was not offered"),
);

const fallbackEndMarker = [
    "    console.log(",
    "        `[SKIP] City/state fallback failed for: ${target}` ,",
].join("\n");

const warnIndex = source.indexOf(
    "[WARN] Exact autocomplete location was not offered: ${target}",
);
const fallbackEndIndex = source.indexOf(
    "[SKIP] City/state fallback failed for: ${target}",
    warnIndex,
);

if (warnIndex < 0 || fallbackStart < 0 || fallbackEndIndex < 0) {
    throw new Error(
        "Expected FTN direct city/state fallback block was not found; refusing to patch.",
    );
}

const logStart = source.lastIndexOf("    console.log(", warnIndex);
const returnFalseEnd = source.indexOf("    return false;", fallbackEndIndex);

if (logStart < 0 || returnFalseEnd < 0) {
    throw new Error(
        "Could not determine FTN fallback patch boundaries; refusing to patch.",
    );
}

const endExclusive = returnFalseEnd + "    return false;".length;

const replacement = [
    "    console.log(",
    "        `[SKIP] Exact autocomplete location was not offered: ${target}` ,",
    "    );",
    "",
    "    return false;",
].join("\n");

const patched =
    source.slice(0, logStart) +
    replacement +
    source.slice(endExclusive);

if (patched === source) {
    throw new Error("FTN autocomplete fallback patch made no changes.");
}

if (patched.includes("[FALLBACK] Typing \"${target}\" directly into city/state field.")) {
    throw new Error("Unsafe direct city/state fallback still exists after patch.");
}

fs.writeFileSync(targetPath, patched, "utf8");
console.log("Patched FTN city/state fallback to require a real autocomplete selection.");

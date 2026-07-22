#!/usr/bin/env node

"use strict";

const http = require("http");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const HOST = "::";

let enrichmentProcess = null;

function isRunning() {
    return (
        enrichmentProcess &&
        enrichmentProcess.exitCode === null &&
        !enrichmentProcess.killed
    );
}

function sendJson(res, statusCode, body) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
    });

    res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
    const url = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`,
    );

    if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
            success: true,
            service: "ftn-enrichment",
            running: isRunning(),
            pid: enrichmentProcess?.pid || null,
        });

        return;
    }

    if (req.method !== "POST" || url.pathname !== "/run") {
        sendJson(res, 404, {
            success: false,
            error: "Route not found",
        });

        return;
    }

    req.resume();

    if (isRunning()) {
        sendJson(res, 409, {
            success: false,
            message: "FTN enrichment is already running",
            pid: enrichmentProcess.pid,
        });

        return;
    }

    console.log("🚀 Starting ftn_enrichment.js...");

    enrichmentProcess = spawn(
        process.execPath,
        ["/app/ftn_enrichment.js"],
        {
            cwd: "/app",
            env: process.env,
            stdio: "inherit",
        },
    );

    const pid = enrichmentProcess.pid;

    enrichmentProcess.once("error", (error) => {
        console.error(
            `❌ FTN enrichment failed to start: ${error.message}`,
        );

        enrichmentProcess = null;
    });

    enrichmentProcess.once("exit", (code, signal) => {
        if (signal) {
            console.log(
                `⚠️ FTN enrichment stopped by signal ${signal}`,
            );
        } else if (code === 0) {
            console.log("✅ FTN enrichment completed successfully");
        } else {
            console.error(
                `❌ FTN enrichment exited with code ${code}`,
            );
        }

        enrichmentProcess = null;
    });

    sendJson(res, 202, {
        success: true,
        message: "FTN enrichment started",
        pid,
    });
});

server.listen(PORT, HOST, () => {
    console.log(
        `✅ FTN trigger server listening on [${HOST}]:${PORT}`,
    );
    console.log("   POST /run");
    console.log("   GET  /health");
});
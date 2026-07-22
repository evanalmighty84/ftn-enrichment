#!/usr/bin/env node

"use strict";

const http = require("http");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const HOST = "::";

const PRE_ENRICHMENT_SCRIPT = "/app/pre_enrichment.js";
const FTN_ENRICHMENT_SCRIPT = "/app/ftn_enrichment.js";

let workflowProcess = null;
let workflowStage = null;

function isRunning() {
    return (
        workflowProcess &&
        workflowProcess.exitCode === null &&
        !workflowProcess.killed
    );
}

function sendJson(res, statusCode, body) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
    });

    res.end(JSON.stringify(body));
}

function runFtnEnrichment() {
    console.log("✅ Preliminary script completed successfully.");
    console.log("▶️ Starting ftn_enrichment.js...");

    workflowStage = "ftn_enrichment";

    const child = spawn(
        process.execPath,
        [FTN_ENRICHMENT_SCRIPT],
        {
            cwd: "/app",
            env: process.env,
            stdio: "inherit",
        },
    );

    workflowProcess = child;

    let failedToStart = false;

    child.once("error", (error) => {
        failedToStart = true;

        console.error(
            `❌ FTN enrichment failed to start: ${error.message}`,
        );

        if (workflowProcess === child) {
            workflowProcess = null;
            workflowStage = null;
        }
    });

    child.once("exit", (code, signal) => {
        if (failedToStart) {
            return;
        }

        if (signal) {
            console.error(
                `❌ FTN enrichment stopped by signal ${signal}.`,
            );
        } else if (code === 0) {
            console.log(
                "✅ FTN enrichment completed successfully.",
            );
        } else {
            console.error(
                `❌ FTN enrichment exited with code ${code}.`,
            );
        }

        if (workflowProcess === child) {
            workflowProcess = null;
            workflowStage = null;
        }
    });
}

function startWorkflow() {
    console.log("▶️ Starting preliminary enrichment script...");

    workflowStage = "pre_enrichment";

    const child = spawn(
        process.execPath,
        [PRE_ENRICHMENT_SCRIPT],
        {
            cwd: "/app",
            env: process.env,
            stdio: "inherit",
        },
    );

    workflowProcess = child;

    let failedToStart = false;

    child.once("error", (error) => {
        failedToStart = true;

        console.error(
            `❌ Preliminary script failed to start: ${error.message}`,
        );

        if (workflowProcess === child) {
            workflowProcess = null;
            workflowStage = null;
        }
    });

    child.once("exit", (code, signal) => {
        if (failedToStart) {
            return;
        }

        if (workflowProcess === child) {
            workflowProcess = null;
        }

        if (signal) {
            console.error(
                `❌ Preliminary script stopped by signal ${signal}.`,
            );

            workflowStage = null;
            return;
        }

        if (code !== 0) {
            console.error(
                `❌ Preliminary script exited with code ${code}. ` +
                "FTN enrichment will not run.",
            );

            workflowStage = null;
            return;
        }

        runFtnEnrichment();
    });

    return child.pid;
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
            stage: workflowStage,
            pid: workflowProcess?.pid || null,
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
            message: "The FTN workflow is already running.",
            stage: workflowStage,
            pid: workflowProcess.pid,
        });

        return;
    }

    const pid = startWorkflow();

    sendJson(res, 202, {
        success: true,
        message:
            "The preliminary script was started. " +
            "FTN enrichment will run after it completes.",
        stage: workflowStage,
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
#!/usr/bin/env node

"use strict";

const http = require("http");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const HOST = "::";

const PRE_ENRICHMENT_SCRIPT = "/app/pre_enrichment.js";
const FTN_ENRICHMENT_SCRIPT = "/app/ftn_enrichment.js";

const ALLOWED_SOURCE_TABLES = new Set([
    "unfiltered_general_contracting",
    "unfiltered_ins_mold_pest_housecl_plumb_paint_land_lawn_handy",
]);

const DEFAULT_SOURCE_TABLE =
    "unfiltered_general_contracting";

const MAX_REQUEST_BODY_BYTES = 100_000;

function positiveIntegerFromEnv(name, fallback) {
    const value = Number(process.env[name]);

    return Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}

// The preliminary classifier should normally finish quickly.
const PRE_ENRICHMENT_TIMEOUT_MS = positiveIntegerFromEnv(
    "PRE_ENRICHMENT_TIMEOUT_MS",
    10 * 60 * 1000,
);

// The FTN browser workers may need longer, but they may not run forever.
const FTN_ENRICHMENT_TIMEOUT_MS = positiveIntegerFromEnv(
    "FTN_ENRICHMENT_TIMEOUT_MS",
    30 * 60 * 1000,
);

// Give Chromium/Node a chance to shut down cleanly before SIGKILL.
const CHILD_TERMINATION_GRACE_MS = positiveIntegerFromEnv(
    "FTN_CHILD_TERMINATION_GRACE_MS",
    15_000,
);

// Last-resort queue release if the operating system never emits child "exit".
const CHILD_FORCE_RELEASE_MS = positiveIntegerFromEnv(
    "FTN_CHILD_FORCE_RELEASE_MS",
    5_000,
);

const workflowQueue = [];

let workflowProcess = null;
let workflowStage = null;
let workflowSourceTable = null;
let workflowStartedAt = null;
let workflowDeadlineAt = null;
let workflowTimedOut = false;
let workflowTimeoutHandle = null;
let workflowKillHandle = null;
let workflowReleaseHandle = null;
let shuttingDown = false;

function isRunning() {
    return Boolean(
        workflowProcess &&
        workflowProcess.exitCode === null &&
        workflowProcess.signalCode === null,
    );
}

function getStageTimeoutMs(stage) {
    return stage === "pre_enrichment"
        ? PRE_ENRICHMENT_TIMEOUT_MS
        : FTN_ENRICHMENT_TIMEOUT_MS;
}

function resolveSourceTable(value) {
    const sourceTable =
        typeof value === "string" && value.trim()
            ? value.trim()
            : DEFAULT_SOURCE_TABLE;

    if (!ALLOWED_SOURCE_TABLES.has(sourceTable)) {
        throw new Error(
            `Unsupported source_table: ${sourceTable}`,
        );
    }

    return sourceTable;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let rawBody = "";
        let settled = false;

        const finishResolve = (value) => {
            if (settled) {
                return;
            }

            settled = true;
            resolve(value);
        };

        const finishReject = (error) => {
            if (settled) {
                return;
            }

            settled = true;
            reject(error);
        };

        req.setEncoding("utf8");

        req.on("data", (chunk) => {
            rawBody += chunk;

            if (
                Buffer.byteLength(rawBody, "utf8") >
                MAX_REQUEST_BODY_BYTES
            ) {
                finishReject(
                    new Error("Request body is too large."),
                );

                req.destroy();
            }
        });

        req.on("end", () => {
            if (settled) {
                return;
            }

            if (!rawBody.trim()) {
                finishResolve({});
                return;
            }

            try {
                finishResolve(JSON.parse(rawBody));
            } catch {
                finishReject(
                    new Error(
                        "Request body contains invalid JSON.",
                    ),
                );
            }
        });

        req.on("error", finishReject);
        req.on("aborted", () => {
            finishReject(
                new Error(
                    "Request was aborted before the body was received.",
                ),
            );
        });
    });
}

function sendJson(res, statusCode, body) {
    if (res.headersSent) {
        return;
    }

    const payload = JSON.stringify(body);

    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
    });

    res.end(payload);
}

function getQueueSnapshot() {
    return workflowQueue.map((item, index) => ({
        position: index + 1,
        source_table: item.sourceTable,
        queued_at: item.queuedAt,
    }));
}

function getQueuedPosition(sourceTable) {
    const index = workflowQueue.findIndex(
        (item) => item.sourceTable === sourceTable,
    );

    return index === -1 ? null : index + 1;
}

function enqueueWorkflow(sourceTable) {
    if (
        isRunning() &&
        workflowSourceTable === sourceTable
    ) {
        return {
            status: "already_running",
            position: 0,
        };
    }

    const existingPosition =
        getQueuedPosition(sourceTable);

    if (existingPosition !== null) {
        return {
            status: "already_queued",
            position: existingPosition,
        };
    }

    workflowQueue.push({
        sourceTable,
        queuedAt: new Date().toISOString(),
    });

    console.log(
        `📥 Queued ${sourceTable} at position ` +
        `${workflowQueue.length}.`,
    );

    return {
        status: "queued",
        position: workflowQueue.length,
    };
}

function clearTimer(handle) {
    if (handle) {
        clearTimeout(handle);
    }
}

function clearWorkflowTimers(child = null) {
    if (
        child &&
        workflowProcess &&
        workflowProcess !== child
    ) {
        return;
    }

    clearTimer(workflowTimeoutHandle);
    clearTimer(workflowKillHandle);
    clearTimer(workflowReleaseHandle);

    workflowTimeoutHandle = null;
    workflowKillHandle = null;
    workflowReleaseHandle = null;
}

function clearWorkflowState(child = null) {
    if (
        child &&
        workflowProcess &&
        workflowProcess !== child
    ) {
        return false;
    }

    clearWorkflowTimers(child);

    workflowProcess = null;
    workflowStage = null;
    workflowSourceTable = null;
    workflowStartedAt = null;
    workflowDeadlineAt = null;
    workflowTimedOut = false;

    return true;
}

function terminateChildTree(child, signal) {
    if (
        !child ||
        !child.pid ||
        child.exitCode !== null ||
        child.signalCode !== null
    ) {
        return;
    }

    try {
        // Each workflow child is spawned as a Linux process-group leader.
        // Negative PID therefore signals the Node parent plus Chromium workers.
        if (process.platform !== "win32") {
            process.kill(-child.pid, signal);
        } else {
            child.kill(signal);
        }
    } catch (error) {
        if (error?.code !== "ESRCH") {
            console.warn(
                `⚠️ Could not send ${signal} to process group ` +
                `${child.pid}: ${error.message}`,
            );
        }

        try {
            child.kill(signal);
        } catch (fallbackError) {
            if (fallbackError?.code !== "ESRCH") {
                console.warn(
                    `⚠️ Could not send ${signal} to child ` +
                    `${child.pid}: ${fallbackError.message}`,
                );
            }
        }
    }
}

function startNextQueuedWorkflow() {
    if (shuttingDown || isRunning()) {
        return;
    }

    const next = workflowQueue.shift();

    if (!next) {
        console.log("📭 FTN workflow queue is empty.");
        return;
    }

    console.log(
        `📤 Starting queued workflow for ` +
        `${next.sourceTable}.`,
    );

    try {
        startWorkflow(next.sourceTable);
    } catch (error) {
        console.error(
            `❌ Could not start queued workflow for ` +
            `${next.sourceTable}: ${error.message}`,
        );

        clearWorkflowState();
        setImmediate(startNextQueuedWorkflow);
    }
}

function finishWorkflowAndContinue(child = null) {
    if (!clearWorkflowState(child)) {
        return;
    }

    if (!shuttingDown) {
        setImmediate(startNextQueuedWorkflow);
    }
}

function armWorkflowTimeout(
    child,
    stage,
    sourceTable,
    timeoutMs,
) {
    workflowStartedAt = new Date().toISOString();
    workflowDeadlineAt = new Date(
        Date.now() + timeoutMs,
    ).toISOString();
    workflowTimedOut = false;

    console.log(
        `⏱️ ${stage} timeout armed for ` +
        `${Math.round(timeoutMs / 60_000)} minute(s) ` +
        `(deadline ${workflowDeadlineAt}).`,
    );

    workflowTimeoutHandle = setTimeout(() => {
        if (
            workflowProcess !== child ||
            !isRunning()
        ) {
            return;
        }

        workflowTimedOut = true;

        console.error(
            `⏰ ${stage} timed out after ${timeoutMs}ms ` +
            `for ${sourceTable}. Sending SIGTERM to ` +
            `process group ${child.pid}.`,
        );

        terminateChildTree(child, "SIGTERM");

        workflowKillHandle = setTimeout(() => {
            if (
                workflowProcess !== child ||
                child.exitCode !== null ||
                child.signalCode !== null
            ) {
                return;
            }

            console.error(
                `🧨 ${stage} did not stop within ` +
                `${CHILD_TERMINATION_GRACE_MS}ms. ` +
                `Sending SIGKILL to process group ${child.pid}.`,
            );

            terminateChildTree(child, "SIGKILL");

            workflowReleaseHandle = setTimeout(() => {
                if (workflowProcess !== child) {
                    return;
                }

                console.error(
                    `⚠️ No child exit event arrived after SIGKILL. ` +
                    `Releasing the workflow slot so the FIFO queue ` +
                    `can continue.`,
                );

                finishWorkflowAndContinue(child);
            }, CHILD_FORCE_RELEASE_MS);
        }, CHILD_TERMINATION_GRACE_MS);
    }, timeoutMs);
}

function spawnWorkflowStage({
                                sourceTable,
                                stage,
                                scriptPath,
                                successMessage,
                                onSuccess = null,
                            }) {
    workflowStage = stage;
    workflowSourceTable = sourceTable;

    const child = spawn(
        process.execPath,
        [scriptPath],
        {
            cwd: "/app",
            env: {
                ...process.env,
                FTN_SOURCE_TABLE: sourceTable,
            },
            stdio: "inherit",

            // Linux: make the child a process-group leader so a timeout can
            // terminate the worker parent and every Chromium/worker descendant.
            detached: process.platform !== "win32",
        },
    );

    workflowProcess = child;

    const timeoutMs = getStageTimeoutMs(stage);

    armWorkflowTimeout(
        child,
        stage,
        sourceTable,
        timeoutMs,
    );

    let failedToStart = false;

    child.once("error", (error) => {
        failedToStart = true;

        if (workflowProcess !== child) {
            return;
        }

        console.error(
            `❌ ${stage} failed to start for ` +
            `${sourceTable}: ${error.message}`,
        );

        finishWorkflowAndContinue(child);
    });

    child.once("exit", (code, signal) => {
        if (
            failedToStart ||
            workflowProcess !== child
        ) {
            return;
        }

        const timedOut = workflowTimedOut;

        clearWorkflowTimers(child);

        if (timedOut) {
            console.error(
                `⏰ ${stage} was terminated after exceeding ` +
                `its ${timeoutMs}ms timeout for ${sourceTable}.`,
            );

            finishWorkflowAndContinue(child);
            return;
        }

        if (signal) {
            console.error(
                `❌ ${stage} stopped by signal ${signal} ` +
                `for ${sourceTable}.`,
            );

            finishWorkflowAndContinue(child);
            return;
        }

        if (code !== 0) {
            console.error(
                `❌ ${stage} exited with code ${code} ` +
                `for ${sourceTable}.`,
            );

            finishWorkflowAndContinue(child);
            return;
        }

        console.log(successMessage);

        if (!onSuccess) {
            finishWorkflowAndContinue(child);
            return;
        }

        // Release the completed preliminary child before starting FTN.
        if (!clearWorkflowState(child)) {
            return;
        }

        try {
            onSuccess();
        } catch (error) {
            console.error(
                `❌ Could not start the next stage for ` +
                `${sourceTable}: ${error.message}`,
            );

            finishWorkflowAndContinue();
        }
    });

    return child.pid;
}

function runFtnEnrichment(sourceTable) {
    console.log(
        `▶️ Starting ftn_enrichment.js for ${sourceTable}...`,
    );

    return spawnWorkflowStage({
        sourceTable,
        stage: "ftn_enrichment",
        scriptPath: FTN_ENRICHMENT_SCRIPT,
        successMessage:
            `✅ FTN enrichment completed successfully ` +
            `for ${sourceTable}.`,
    });
}

function startWorkflow(sourceTable) {
    console.log(
        `🗃️ Requested source table: ${sourceTable}`,
    );

    console.log(
        `▶️ Starting pre_enrichment.js for ` +
        `${sourceTable}...`,
    );

    return spawnWorkflowStage({
        sourceTable,
        stage: "pre_enrichment",
        scriptPath: PRE_ENRICHMENT_SCRIPT,
        successMessage:
            "✅ Preliminary script completed successfully.",
        onSuccess: () => runFtnEnrichment(sourceTable),
    });
}

const server = http.createServer(
    async (req, res) => {
        let url;

        try {
            url = new URL(
                req.url,
                `http://${req.headers.host || "localhost"}`,
            );
        } catch {
            sendJson(res, 400, {
                success: false,
                error: "Invalid request URL.",
            });

            return;
        }

        console.log(
            `📥 Received ${req.method} ${url.pathname}`,
        );

        if (
            req.method === "GET" &&
            url.pathname === "/health"
        ) {
            const elapsedMs = workflowStartedAt
                ? Math.max(
                    0,
                    Date.now() -
                    Date.parse(workflowStartedAt),
                )
                : null;

            sendJson(res, 200, {
                success: true,
                service: "ftn-enrichment",
                running: isRunning(),
                stage: workflowStage,
                source_table: workflowSourceTable,
                pid: workflowProcess?.pid || null,
                started_at: workflowStartedAt,
                deadline_at: workflowDeadlineAt,
                elapsed_ms: elapsedMs,
                timed_out: workflowTimedOut,
                stage_timeout_ms:
                    workflowStage
                        ? getStageTimeoutMs(workflowStage)
                        : null,
                queue_length: workflowQueue.length,
                queue: getQueueSnapshot(),
                allowed_source_tables: [
                    ...ALLOWED_SOURCE_TABLES,
                ],
                timeout_configuration: {
                    pre_enrichment_timeout_ms:
                    PRE_ENRICHMENT_TIMEOUT_MS,
                    ftn_enrichment_timeout_ms:
                    FTN_ENRICHMENT_TIMEOUT_MS,
                    child_termination_grace_ms:
                    CHILD_TERMINATION_GRACE_MS,
                    child_force_release_ms:
                    CHILD_FORCE_RELEASE_MS,
                },
            });

            return;
        }

        if (
            req.method !== "POST" ||
            url.pathname !== "/run"
        ) {
            sendJson(res, 404, {
                success: false,
                error: "Route not found",
            });

            return;
        }

        let body;

        try {
            body = await readJsonBody(req);
        } catch (error) {
            sendJson(res, 400, {
                success: false,
                error: error.message,
            });

            return;
        }

        let sourceTable;

        try {
            sourceTable = resolveSourceTable(
                body.source_table,
            );
        } catch (error) {
            sendJson(res, 400, {
                success: false,
                error: error.message,
                allowed_source_tables: [
                    ...ALLOWED_SOURCE_TABLES,
                ],
            });

            return;
        }

        if (isRunning()) {
            const queueResult =
                enqueueWorkflow(sourceTable);

            if (
                queueResult.status ===
                "already_running"
            ) {
                sendJson(res, 202, {
                    success: true,
                    status: "already_running",
                    message:
                        "A workflow for this source table " +
                        "is already running.",
                    stage: workflowStage,
                    source_table:
                    workflowSourceTable,
                    pid:
                        workflowProcess?.pid || null,
                    started_at: workflowStartedAt,
                    deadline_at: workflowDeadlineAt,
                    queue_length:
                    workflowQueue.length,
                    queue: getQueueSnapshot(),
                });

                return;
            }

            if (
                queueResult.status ===
                "already_queued"
            ) {
                sendJson(res, 202, {
                    success: true,
                    status: "already_queued",
                    message:
                        "A workflow for this source table " +
                        "is already queued.",
                    source_table: sourceTable,
                    queue_position:
                    queueResult.position,
                    active_source_table:
                    workflowSourceTable,
                    active_stage: workflowStage,
                    active_deadline_at:
                    workflowDeadlineAt,
                    queue_length:
                    workflowQueue.length,
                    queue: getQueueSnapshot(),
                });

                return;
            }

            sendJson(res, 202, {
                success: true,
                status: "queued",
                message:
                    "The FTN workflow is busy. This " +
                    "source table was added to the queue.",
                source_table: sourceTable,
                queue_position:
                queueResult.position,
                active_source_table:
                workflowSourceTable,
                active_stage: workflowStage,
                active_deadline_at:
                workflowDeadlineAt,
                queue_length:
                workflowQueue.length,
                queue: getQueueSnapshot(),
            });

            return;
        }

        let pid;

        try {
            pid = startWorkflow(sourceTable);
        } catch (error) {
            clearWorkflowState();

            console.error(
                `❌ Could not start FTN workflow: ` +
                `${error.message}`,
            );

            sendJson(res, 500, {
                success: false,
                error:
                    "The FTN workflow could not be started.",
                detail: error.message,
            });

            return;
        }

        sendJson(res, 202, {
            success: true,
            status: "started",
            message:
                "The preliminary script was started. " +
                "FTN enrichment will run after it completes.",
            stage: workflowStage,
            source_table: sourceTable,
            pid,
            started_at: workflowStartedAt,
            deadline_at: workflowDeadlineAt,
            queue_length: workflowQueue.length,
        });
    },
);

server.on("clientError", (error, socket) => {
    console.warn(
        `⚠️ HTTP client error: ${error.message}`,
    );

    if (socket.writable) {
        socket.end(
            "HTTP/1.1 400 Bad Request\r\n" +
            "Connection: close\r\n\r\n",
        );
    }
});

function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `🛑 Received ${signal}; shutting down FTN server.`,
    );

    server.close(() => {
        console.log("✅ FTN HTTP server closed.");
    });

    const child = workflowProcess;

    if (child && isRunning()) {
        console.log(
            `🛑 Stopping active ${workflowStage} process group ` +
            `${child.pid} before server exit.`,
        );

        terminateChildTree(child, "SIGTERM");

        setTimeout(() => {
            if (
                workflowProcess === child &&
                child.exitCode === null &&
                child.signalCode === null
            ) {
                terminateChildTree(child, "SIGKILL");
            }
        }, CHILD_TERMINATION_GRACE_MS).unref();
    }

    setTimeout(() => {
        process.exit(0);
    }, CHILD_TERMINATION_GRACE_MS + 5_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
    console.log(
        `✅ FTN trigger server listening on ` +
        `[${HOST}]:${PORT}`,
    );

    console.log("   POST /run");
    console.log("   GET  /health");

    console.log(
        "   Allowed source tables: " +
        [...ALLOWED_SOURCE_TABLES].join(", "),
    );

    console.log(
        "   Queue mode: FIFO; duplicate table requests are deduplicated",
    );

    console.log(
        `   Timeouts: pre=${PRE_ENRICHMENT_TIMEOUT_MS}ms, ` +
        `ftn=${FTN_ENRICHMENT_TIMEOUT_MS}ms, ` +
        `grace=${CHILD_TERMINATION_GRACE_MS}ms`,
    );
});

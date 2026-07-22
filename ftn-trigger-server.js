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

const workflowQueue = [];

let workflowProcess = null;
let workflowStage = null;
let workflowSourceTable = null;

function isRunning() {
    return Boolean(
        workflowProcess &&
        workflowProcess.exitCode === null &&
        !workflowProcess.killed,
    );
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

function startNextQueuedWorkflow() {
    if (isRunning()) {
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

        workflowProcess = null;
        workflowStage = null;
        workflowSourceTable = null;

        setImmediate(startNextQueuedWorkflow);
    }
}

function finishWorkflowAndContinue(child = null) {
    if (
        child &&
        workflowProcess &&
        workflowProcess !== child
    ) {
        return;
    }

    workflowProcess = null;
    workflowStage = null;
    workflowSourceTable = null;

    setImmediate(startNextQueuedWorkflow);
}

function clearWorkflowState(child) {
    if (workflowProcess !== child) {
        return;
    }

    workflowProcess = null;
    workflowStage = null;
    workflowSourceTable = null;
}

function createChildEnvironment(sourceTable) {
    return {
        ...process.env,
        FTN_SOURCE_TABLE: sourceTable,
    };
}

function runFtnEnrichment(sourceTable) {
    console.log(
        "✅ Preliminary script completed successfully.",
    );
    console.log(
        `▶️ Starting ftn_enrichment.js for ${sourceTable}...`,
    );

    workflowStage = "ftn_enrichment";
    workflowSourceTable = sourceTable;

    const child = spawn(
        process.execPath,
        [FTN_ENRICHMENT_SCRIPT],
        {
            cwd: "/app",
            env: createChildEnvironment(sourceTable),
            stdio: "inherit",
        },
    );

    workflowProcess = child;

    let failedToStart = false;

    child.once("error", (error) => {
        failedToStart = true;

        console.error(
            `❌ FTN enrichment failed to start: ` +
            `${error.message}`,
        );

        finishWorkflowAndContinue(child);
    });

    child.once("exit", (code, signal) => {
        if (failedToStart) {
            return;
        }

        if (signal) {
            console.error(
                `❌ FTN enrichment stopped by signal ` +
                `${signal}.`,
            );
        } else if (code === 0) {
            console.log(
                `✅ FTN enrichment completed successfully ` +
                `for ${sourceTable}.`,
            );
        } else {
            console.error(
                `❌ FTN enrichment exited with code ` +
                `${code} for ${sourceTable}.`,
            );
        }

        finishWorkflowAndContinue(child);
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

    workflowStage = "pre_enrichment";
    workflowSourceTable = sourceTable;

    const child = spawn(
        process.execPath,
        [PRE_ENRICHMENT_SCRIPT],
        {
            cwd: "/app",
            env: createChildEnvironment(sourceTable),
            stdio: "inherit",
        },
    );

    workflowProcess = child;

    let failedToStart = false;

    child.once("error", (error) => {
        failedToStart = true;

        console.error(
            `❌ Preliminary script failed to start: ` +
            `${error.message}`,
        );

        clearWorkflowState(child);
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
                `❌ Preliminary script stopped by signal ` +
                `${signal}.`,
            );

            finishWorkflowAndContinue();
            return;
        }

        if (code !== 0) {
            console.error(
                `❌ Preliminary script exited with code ` +
                `${code}. FTN enrichment will not run.`,
            );

            finishWorkflowAndContinue();
            return;
        }

        try {
            runFtnEnrichment(sourceTable);
        } catch (error) {
            console.error(
                `❌ Could not start FTN enrichment for ` +
                `${sourceTable}: ${error.message}`,
            );

            finishWorkflowAndContinue();
        }
    });

    return child.pid;
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
            sendJson(res, 200, {
                success: true,
                service: "ftn-enrichment",
                running: isRunning(),
                stage: workflowStage,
                source_table: workflowSourceTable,
                pid: workflowProcess?.pid || null,
                queue_length: workflowQueue.length,
                queue: getQueueSnapshot(),
                allowed_source_tables: [
                    ...ALLOWED_SOURCE_TABLES,
                ],
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
            workflowProcess = null;
            workflowStage = null;
            workflowSourceTable = null;

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
});

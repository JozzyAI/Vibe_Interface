import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { buildDashboardModel, createMockProjectState } from "../../core/src/index.js";

const state = createMockProjectState();

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendFile(response, filePath, contentType) {
  return readFile(filePath)
    .then((content) => {
      response.writeHead(200, {
        "Content-Type": contentType
      });
      response.end(content);
    })
    .catch(() => {
      response.writeHead(404);
      response.end("Not found");
    });
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function findRequest(requestId) {
  return state.requests.find((item) => item.id === requestId);
}

function findSession(sessionId) {
  return state.sessions.find((item) => item.id === sessionId);
}

function routeMutation(request, response) {
  const pathname = new URL(request.url, "http://localhost:3200").pathname;
  const replyMatch = pathname.match(/^\/api\/requests\/([^/]+)\/reply$/);
  const decisionMatch = pathname.match(/^\/api\/requests\/([^/]+)\/decision$/);
  const restoreMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);

  if (replyMatch) {
    return parseBody(request)
      .then((payload) => {
        const item = findRequest(replyMatch[1]);
        if (!item) {
          json(response, 404, { ok: false, error: "Request not found" });
          return;
        }

        item.status = "answered";
        item.response = payload.message ?? "";
        item.updatedAt = new Date().toISOString();

        const session = findSession(item.sessionId);
        if (session) {
          session.state = "running";
          session.lastUpdate = "User replied from dashboard";
          session.updatedAt = new Date().toISOString();
        }

        json(response, 200, { ok: true, request: item, session });
      })
      .catch((error) => json(response, 400, { ok: false, error: error.message }));
  }

  if (decisionMatch) {
    return parseBody(request)
      .then((payload) => {
        const item = findRequest(decisionMatch[1]);
        if (!item) {
          json(response, 404, { ok: false, error: "Request not found" });
          return;
        }

        item.status = payload.decision ?? "approved";
        item.response = payload.message ?? "";
        item.updatedAt = new Date().toISOString();

        const session = findSession(item.sessionId);
        if (session) {
          session.state = payload.decision === "reject" ? "blocked" : "running";
          session.lastUpdate =
            payload.decision === "reject"
              ? "Plan rejected in dashboard"
              : "Plan approved in dashboard";
          session.updatedAt = new Date().toISOString();
        }

        json(response, 200, { ok: true, request: item, session });
      })
      .catch((error) => json(response, 400, { ok: false, error: error.message }));
  }

  if (restoreMatch) {
    const session = findSession(restoreMatch[1]);
    if (!session) {
      json(response, 404, { ok: false, error: "Session not found" });
      return Promise.resolve();
    }

    session.needsRestore = false;
    session.state = "queued";
    session.lastUpdate = "Restore requested from dashboard";
    session.updatedAt = new Date().toISOString();
    json(response, 200, {
      ok: true,
      session
    });
    return Promise.resolve();
  }

  json(response, 404, { ok: false, error: "Unknown mutation route" });
  return Promise.resolve();
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  const url = new URL(request.url, "http://localhost:3200");
  const srcDir = path.resolve(process.cwd(), "packages", "web", "src");

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    json(response, 200, buildDashboardModel(state));
    return;
  }

  const sessionGetMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionGetMatch) {
    const session = findSession(sessionGetMatch[1]);
    if (!session) {
      json(response, 404, { ok: false, error: "Session not found" });
      return;
    }
    json(response, 200, { session });
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/")) {
    routeMutation(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/app.js") {
    sendFile(response, path.join(srcDir, "app.js"), "text/javascript; charset=utf-8");
    return;
  }

  if (request.method === "GET" && url.pathname === "/styles.css") {
    sendFile(response, path.join(srcDir, "styles.css"), "text/css; charset=utf-8");
    return;
  }

  sendFile(response, path.join(srcDir, "index.html"), "text/html; charset=utf-8");
});

server.listen(3200, () => {
  console.log("PI dashboard running on http://localhost:3200");
});

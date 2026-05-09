import http from "node:http";
import {
  buildGithubIssuePayloads,
  createQueuedSessionsFromPlan,
  expandIdeaToIssuePlan
} from "../../core/src/index.js";

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload, null, 2));
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

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true, service: "pi-intake-api" });
    return;
  }

  if (request.method === "POST" && request.url === "/ideas") {
    try {
      const payload = await parseBody(request);
      const plan = expandIdeaToIssuePlan(payload);
      const sessions = createQueuedSessionsFromPlan(plan);
      json(response, 201, {
        idea: plan.idea,
        issueGroup: plan.issueGroup,
        issues: buildGithubIssuePayloads(plan),
        sessions
      });
    } catch (error) {
      json(response, 400, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  json(response, 404, {
    ok: false,
    error: "Not found"
  });
});

server.listen(4100, () => {
  console.log("PI intake API listening on http://localhost:4100");
});

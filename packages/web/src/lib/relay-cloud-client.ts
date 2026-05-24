/**
 * Thin wrapper — instantiates VIRelayClient from env vars and re-exports
 * all methods as module-level functions so the rest of the codebase is unchanged.
 * Import "server-only" ensures this file never leaks into client bundles.
 */
import "server-only";
import { VIRelayClient } from "@vi/client-sdk";

function makeClient() {
  return new VIRelayClient({
    baseUrl: (process.env["VI_RELAY_BASE_URL"] ?? "").trim(),
    viToken: process.env["VI_RELAY_VI_TOKEN"] ?? "",
  });
}

// Re-export every method as a standalone async function to preserve
// the existing import style used throughout API routes and server components.

export const getRemoteApprovalOverview: typeof VIRelayClient.prototype.getRemoteApprovalOverview =
  (...args) => makeClient().getRemoteApprovalOverview(...args);

export const getEnrollments: typeof VIRelayClient.prototype.getEnrollments =
  (...args) => makeClient().getEnrollments(...args);

export const createRemoteEnrollment: typeof VIRelayClient.prototype.createRemoteEnrollment =
  (...args) => makeClient().createRemoteEnrollment(...args);

export const consumeRemoteEnrollment: typeof VIRelayClient.prototype.consumeRemoteEnrollment =
  (...args) => makeClient().consumeRemoteEnrollment(...args);

export const revokeRemoteEnrollment: typeof VIRelayClient.prototype.revokeRemoteEnrollment =
  (...args) => makeClient().revokeRemoteEnrollment(...args);

export const createReconnectEnrollment: typeof VIRelayClient.prototype.createReconnectEnrollment =
  (...args) => makeClient().createReconnectEnrollment(...args);

export const createRemoteAgentJob: typeof VIRelayClient.prototype.createRemoteAgentJob =
  (...args) => makeClient().createRemoteAgentJob(...args);

export const archiveRemoteAgentJob: typeof VIRelayClient.prototype.archiveRemoteAgentJob =
  (...args) => makeClient().archiveRemoteAgentJob(...args);

export const removeRemoteAgentJob: typeof VIRelayClient.prototype.removeRemoteAgentJob =
  (...args) => makeClient().removeRemoteAgentJob(...args);

export const updateRemoteAgentJobSettings: typeof VIRelayClient.prototype.updateRemoteAgentJobSettings =
  (...args) => makeClient().updateRemoteAgentJobSettings(...args);

export const restartRemoteAgentJob: typeof VIRelayClient.prototype.restartRemoteAgentJob =
  (...args) => makeClient().restartRemoteAgentJob(...args);

export const createRemoteApprovalRequest: typeof VIRelayClient.prototype.createRemoteApprovalRequest =
  (...args) => makeClient().createRemoteApprovalRequest(...args);

export const respondToRemoteApproval: typeof VIRelayClient.prototype.respondToRemoteApproval =
  (...args) => makeClient().respondToRemoteApproval(...args);

export const dispatchRelayApprovalDecision: typeof VIRelayClient.prototype.dispatchRelayApprovalDecision =
  (...args) => makeClient().dispatchRelayApprovalDecision(...args);

export const dispatchRelayJob: typeof VIRelayClient.prototype.dispatchRelayJob =
  (...args) => makeClient().dispatchRelayJob(...args);

export const removeRemoteAgent: typeof VIRelayClient.prototype.removeRemoteAgent =
  (...args) => makeClient().removeRemoteAgent(...args);

export const requestRemoteAgentDaemonRestart: typeof VIRelayClient.prototype.requestRemoteAgentDaemonRestart =
  (...args) => makeClient().requestRemoteAgentDaemonRestart(...args);

export const setRemoteAgentPolicy: typeof VIRelayClient.prototype.setRemoteAgentPolicy =
  (...args) => makeClient().setRemoteAgentPolicy(...args);

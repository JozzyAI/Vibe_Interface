export type RelayPeerKind = "vi" | "daemon";

export type RelayMessageType =
  | "hello"
  | "hello_ack"
  | "heartbeat"
  | "approval_request"
  | "approval_decision"
  | "job_request"
  | "job_report"
  | "presence_sync"
  | "error";

export interface RelayHelloPayload {
  peerId: string;
  kind: RelayPeerKind;
  label?: string;
  token: string;
}

export interface RelayPresencePeer {
  peerId: string;
  kind: RelayPeerKind;
  label?: string;
  connectedAt: string;
  lastSeenAt: string;
  connectionId: string;
}

export interface RelayEnvelope<TPayload = unknown> {
  type: RelayMessageType;
  id?: string;
  from?: string;
  to?: string;
  sentAt?: string;
  payload?: TPayload;
}

export interface RelayPeerRecord {
  peerId: string;
  kind: RelayPeerKind;
  label?: string;
  connectedAt: string;
  lastSeenAt: string;
  connectionId: string;
}

export interface RelayHelloAckPayload {
  connectionId: string;
  peer: RelayPresencePeer;
  peers: RelayPresencePeer[];
}

export interface RelayErrorPayload {
  code: string;
  message: string;
}

export interface RelayDispatchResult {
  delivered: boolean;
  targetPeerId: string;
  reason?: string;
}

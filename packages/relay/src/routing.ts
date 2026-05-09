import type { RelayEnvelope, RelayPeerRecord } from "./types.js";

export interface RelayConnection {
  connectionId: string;
  peer?: RelayPeerRecord;
  send: (message: RelayEnvelope) => void;
  close: (code?: number, reason?: string) => void;
}

export class RelayRegistry {
  private readonly connections = new Map<string, RelayConnection>();
  private readonly peersById = new Map<string, RelayConnection>();

  registerConnection(connection: RelayConnection) {
    this.connections.set(connection.connectionId, connection);
  }

  attachPeer(connectionId: string, peer: RelayPeerRecord) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    const previous = this.peersById.get(peer.peerId);
    if (previous && previous.connectionId !== connectionId) {
      previous.close(4002, "Replaced by newer relay connection");
      this.connections.delete(previous.connectionId);
    }

    connection.peer = peer;
    this.peersById.set(peer.peerId, connection);
  }

  touch(connectionId: string, timestamp: string) {
    const connection = this.connections.get(connectionId);
    if (connection?.peer) {
      connection.peer.lastSeenAt = timestamp;
    }
  }

  unregisterConnection(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    this.connections.delete(connectionId);
    if (connection.peer) {
      const current = this.peersById.get(connection.peer.peerId);
      if (current?.connectionId === connectionId) {
        this.peersById.delete(connection.peer.peerId);
      }
    }
  }

  listPeers(): RelayPeerRecord[] {
    return [...this.peersById.values()]
      .map((connection) => connection.peer)
      .filter((peer): peer is RelayPeerRecord => Boolean(peer))
      .sort((left, right) => left.peerId.localeCompare(right.peerId));
  }

  route(message: RelayEnvelope): boolean {
    if (!message.to) {
      return false;
    }

    const target = this.peersById.get(message.to);
    if (!target) {
      return false;
    }

    target.send(message);
    return true;
  }
}

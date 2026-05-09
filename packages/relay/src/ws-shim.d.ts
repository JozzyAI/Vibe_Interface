declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket extends EventEmitter {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: "message", listener: (data: Buffer) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: () => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    clients: Set<WebSocket>;
    constructor(options?: unknown);
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (ws: WebSocket) => void,
    ): void;
    on(event: "connection", listener: (ws: WebSocket, request: IncomingMessage) => void): this;
  }
}

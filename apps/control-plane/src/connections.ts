import type { WebSocket } from "ws";
import type { ControlCommandMessage, ControlToAgentMessage } from "@controller-center/protocol";

interface AgentConnection {
  socket: WebSocket;
  bootId: string;
}

export class AgentConnections {
  private readonly connections = new Map<string, AgentConnection>();

  set(nodeId: string, bootId: string, socket: WebSocket): void {
    const previous = this.connections.get(nodeId);
    if (previous && previous.socket !== socket) previous.socket.close(4001, "Replaced by a newer session");
    this.connections.set(nodeId, { socket, bootId });
  }

  remove(nodeId: string, socket: WebSocket): boolean {
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket !== socket) return false;
    this.connections.delete(nodeId);
    return true;
  }

  has(nodeId: string): boolean {
    const connection = this.connections.get(nodeId);
    return connection?.socket.readyState === connection?.socket.OPEN;
  }

  close(nodeId: string, code = 4000, reason = "Connection expired"): void {
    const connection = this.connections.get(nodeId);
    if (!connection) return;
    this.connections.delete(nodeId);
    connection.socket.close(code, reason);
  }

  send(nodeId: string, message: ControlToAgentMessage): boolean {
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) return false;
    connection.socket.send(JSON.stringify(message));
    return true;
  }

  sendCommand(nodeId: string, message: ControlCommandMessage): boolean {
    return this.send(nodeId, message);
  }
}

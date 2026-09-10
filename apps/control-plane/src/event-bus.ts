import { EventEmitter } from "node:events";

export interface UiEvent {
  revision: number;
  type: string;
  resourceId: string | null;
  occurredAt: string;
}

export class UiEventBus {
  private readonly emitter = new EventEmitter();

  publish(event: UiEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}

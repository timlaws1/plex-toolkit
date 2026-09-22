import { EventEmitter } from 'node:events';

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  publish(event, payload) {
    this.emit(event, payload);
    this.emit('*', { event, payload });
  }
}

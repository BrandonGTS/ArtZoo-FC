import { EventEmitter } from 'node:events';
export class Worker extends EventEmitter {
  constructor(url, options) {
    super();
    this.scenario = globalThis.bmpWorkerScenario;
    this.terminated = false;
    globalThis.bmpFakeWorkers ??= [];
    globalThis.bmpFakeWorkers.push(this);
    if (this.scenario === 'constructor') throw Error('synthetic constructor error');
    queueMicrotask(() => {
      if (this.scenario === 'error') this.emit('error', Error('synthetic private diagnostic'));
      if (this.scenario === 'exit') this.emit('exit', 0);
      if (this.scenario === 'bad-message') this.emit('message', { ok: true, output: 'bad' });
      if (
        this.scenario === 'success' ||
        this.scenario === 'slow-terminate' ||
        this.scenario === 'terminate-error'
      )
        this.emit('message', { ok: true, output: new Uint8Array([1, 2, 3]) });
    });
  }
  async terminate() {
    this.terminated = true;
    if (this.scenario === 'terminate-error') throw Error('synthetic terminate failure');
    if (this.scenario === 'slow-terminate')
      await new Promise((resolve) => {
        this.releaseTermination = resolve;
      });
    this.emit('exit', 1);
    return 1;
  }
}

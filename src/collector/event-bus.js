import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(50);

export function onTxEvent(type, handler) {
  bus.on(type, handler);
}

export function offTxEvent(type, handler) {
  bus.off(type, handler);
}

export function emitTxEvent(type, event) {
  bus.emit(type, event);
  bus.emit('*', { type, event });
}

export const TX_EVENT_TYPES = Object.freeze({
  ANY_DLMM: 'tx:any_dlmm',
  POSITION_OPEN: 'tx:position_open',
  POSITION_CLOSE: 'tx:position_close',
  FEE_CLAIM: 'tx:fee_claim',
  WALLET_NEW: 'tx:wallet_new',
});
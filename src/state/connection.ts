export type ConnectionState = "idle" | "connecting" | "connected" | "disconnecting";

export type ConnectionSnapshot = {
  state: ConnectionState;
  address: string | null;
};

let snapshot: ConnectionSnapshot = { state: "idle", address: null };
const listeners = new Set<(next: ConnectionSnapshot) => void>();

export function getConnectionSnapshot() {
  return snapshot;
}

export function setConnectionSnapshot(state: ConnectionState, address: string | null) {
  snapshot = { state, address };
  listeners.forEach((listener) => listener(snapshot));
}

export function subscribeConnection(listener: (next: ConnectionSnapshot) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

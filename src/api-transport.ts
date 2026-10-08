// the shared clients call through this so the Android app can add its server and login
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

let current: ApiFetch = (path, init) => fetch(path, init);

export function setApiFetch(next: ApiFetch): void {
  current = next;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return current(path, init);
}

export const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export const APP_BASE = import.meta.env.BASE_URL;

export function appUrl(path: string): string {
  return `${window.location.origin}${APP_BASE.replace(/\/$/, "")}${path}`;
}

"use client";

// One small API helper for the dashboards.
//
// Credentials are always included because the session lives in httpOnly cookies.
// A non-2xx is turned into a typed failure rather than thrown, so every panel can
// render a real error state instead of an empty list that looks like "no data".
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string };

export async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<ApiResult<T>> {
  const { json, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      headers,
      credentials: "include",
      cache: "no-store",
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: "NETWORK",
      message: "The API could not be reached. Check that it is running.",
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* a body is not guaranteed */
  }

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    return {
      ok: false,
      status: response.status,
      code: error?.code ?? `HTTP_${response.status}`,
      message: error?.message ?? `The request failed (${response.status}).`,
    };
  }

  const envelope = body as { success?: boolean; data?: T } | null;
  if (!envelope || envelope.success !== true || envelope.data === undefined) {
    return {
      ok: false,
      status: response.status,
      code: "MALFORMED",
      message: "The API answered with something this page could not read.",
    };
  }
  return { ok: true, data: envelope.data };
}

export function rupees(paise: number | string | null | undefined): string {
  const value = typeof paise === "string" ? Number(paise) : paise ?? 0;
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value / 100);
}

export function kilograms(grams: number | null | undefined): string {
  if (!Number.isFinite(grams ?? NaN)) return "—";
  return `${((grams as number) / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;
}

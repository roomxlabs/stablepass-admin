// Standard response envelope + error shape (see docs/specs/api-contract.md).
import { NextResponse } from "next/server";
export const ok = (data: unknown, meta?: unknown) =>
  NextResponse.json(meta ? { data, meta } : { data });
export const created = (data: unknown) => NextResponse.json({ data }, { status: 201 });
export const noContent = () => new NextResponse(null, { status: 204 });
export const fail = (code: string, message: string, status: number, fields?: Record<string, string>) =>
  NextResponse.json({ error: { code, message, ...(fields ? { fields } : {}) } }, { status });
export const UNAUTH = () => fail("unauthorized", "Missing or invalid session.", 401);
export const GATED = () => fail("subscription_required", "An active or trial subscription is required.", 402);

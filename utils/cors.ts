import type { ApiRequest, ApiResponse } from "./types";

const normalizeOrigin = (value: string) => value.trim().replace(/\/+$/, "");

const allowedOrigins = (
  process.env.FRONTEND_URL || "http://localhost:3000,http://127.0.0.1:3000"
)
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

function isOriginAllowed(requestOrigin?: string): boolean {
  if (!requestOrigin) {
    return true;
  }

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);

  return allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === "*") {
      return true;
    }

    if (allowedOrigin.startsWith("*.")) {
      const domain = allowedOrigin.slice(2);
      return (
        normalizedRequestOrigin === `https://${domain}` ||
        normalizedRequestOrigin.endsWith(`.${domain}`)
      );
    }

    return allowedOrigin === normalizedRequestOrigin;
  });
}

function getRequestOrigin(req: ApiRequest): string | undefined {
  const originHeader = req.headers?.origin;
  if (typeof originHeader === "string") {
    return originHeader;
  }

  if (Array.isArray(originHeader)) {
    return originHeader[0];
  }

  return undefined;
}

export function applyCors(req: ApiRequest, res: ApiResponse): boolean {
  const requestOrigin = getRequestOrigin(req);
  const allowOrigin =
    requestOrigin && isOriginAllowed(requestOrigin)
      ? requestOrigin
      : allowedOrigins.includes("*")
        ? "*"
        : allowedOrigins[0];

  if (!allowOrigin) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  const requestedHeaders = req.headers?.["access-control-request-headers"];
  const allowHeaders =
    typeof requestedHeaders === "string" && requestedHeaders.trim()
      ? requestedHeaders
      : "Content-Type, Authorization";

  res.setHeader("Access-Control-Allow-Headers", allowHeaders);

  if (req.method === "OPTIONS") {
    res.status(204).json({});
    return true;
  }

  return false;
}

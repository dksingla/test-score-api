import "dotenv/config";
import cors from "cors";
import express from "express";
import handler from "./api/score";
import handlerCrawl from "./api/crawl";
import handlerDebug from "./api/debug";
import type { ApiRequest, ApiResponse } from "./utils/types";

const app = express();

const normalizeOrigin = (value: string) => value.trim().replace(/\/+$/, "");

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

const isOriginAllowed = (requestOrigin?: string) => {
  if (!requestOrigin) {
    return true;
  }

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);

  return allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin.startsWith("*.")) {
      const domain = allowedOrigin.slice(2);
      return (
        normalizedRequestOrigin === `https://${domain}` ||
        normalizedRequestOrigin.endsWith(`.${domain}`)
      );
    }

    return allowedOrigin === normalizedRequestOrigin;
  });
};

const corsOptions = {
  origin(
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    return callback(
      new Error(`CORS blocked for origin: ${origin ?? "unknown"}`),
    );
  },
  methods: ["POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());

app.post("/api/score", (req, res) => {
  // Adapt Express req/res to the minimal ApiRequest/ApiResponse interface
  // used by the handler, keeping full type safety without casting.
  const apiReq: ApiRequest = {
    method: req.method,
    body: req.body,
    headers: req.headers,
    ip: req.ip,
    socket: { remoteAddress: req.socket.remoteAddress },
  };

  const apiRes: ApiResponse = {
    status(code) {
      res.status(code);
      return apiRes;
    },
    json(data) {
      return res.json(data);
    },
  };

  handler(apiReq, apiRes).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Server error";
    res.status(500).json({ success: false, error: message });
  });
});
app.post("/api/crawl", (req, res) => {
  // Adapt Express req/res to the minimal ApiRequest/ApiResponse interface
  // used by the handler, keeping full type safety without casting.
  const apiReq: ApiRequest = {
    method: req.method,
    body: req.body,
    headers: req.headers,
    ip: req.ip,
    socket: { remoteAddress: req.socket.remoteAddress },
  };

  const apiRes: ApiResponse = {
    status(code) {
      res.status(code);
      return apiRes;
    },
    json(data) {
      return res.json(data);
    },
  };

  handlerCrawl(apiReq, apiRes).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Server error";
    res.status(500).json({ success: false, error: message });
  });
});
app.post("/api/debug", (req, res) => {
  const apiReq: ApiRequest = {
    method: req.method,
    body: req.body,
    headers: req.headers,
    ip: req.ip,
    socket: { remoteAddress: req.socket.remoteAddress },
  };
  const apiRes: ApiResponse = {
    status(code) {
      res.status(code);
      return apiRes;
    },
    json(data) {
      return res.json(data);
    },
  };

  handlerDebug(apiReq, apiRes);
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

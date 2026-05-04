import "dotenv/config";
import express from "express";
import handler from "./api/score";
import handlerCrawl from "./api/crawl";
import handlerDebug from "./api/debug";
import type { ApiRequest, ApiResponse } from "./utils/types";

const app = express();
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

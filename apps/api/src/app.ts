import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { getRateLimiterDiagnostics } from "./lib/redisStore";
import {
  correlationMiddleware,
  generalApiLimiter,
  globalErrorHandler,
  sendError,
  sendSuccess,
} from "./middleware/security.middleware";
import { adminRouter } from "./modules/admin/admin.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { getOnnxEngineHealth } from "./modules/ai/onnx.engine";
import { authRouter } from "./modules/auth/auth.routes";
import { webhooksRouter } from "./modules/integrations/webhooks.routes";
import { marketplaceRouter } from "./modules/marketplace/marketplace.routes";
import { operationsRouter } from "./modules/operations/operations.routes";
import { supplyChainRouter } from "./modules/supplychain/supplychain.routes";
import { publicVerifyRouter, usersRouter } from "./modules/users/users.routes";
import { verificationRouter } from "./modules/verification/verification.routes";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    helmet({
      frameguard: env.NODE_ENV === "production" ? { action: "deny" } : false,
      contentSecurityPolicy: env.NODE_ENV === "production" ? undefined : false,
    })
  );

  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (
          !origin ||
          allowedOrigins.includes(origin) ||
          origin.endsWith(".e2b.app")
        ) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    })
  );

  app.use(correlationMiddleware);
  app.use(cookieParser());

  // Mount raw-body HMAC webhook endpoint BEFORE JSON body parsers mutate payload bytes
  app.use("/api/v1/webhooks", webhooksRouter);

  // Allow up to 8 MB JSON exclusively on /api/v1/ai for mobile base64 camera frames
  app.use("/api/v1/ai", express.json({ limit: "8mb" }));
  app.use(express.json({ limit: "256kb" }));
  app.use(generalApiLimiter);

  // Health & Subsystem Readiness Probe
  app.get("/api/v1/health", (_req, res) => {
    sendSuccess(res, {
      service: "kabadiwala-connect-api",
      version: "1.0.0",
      status: "ok",
      subsystems: {
        onnxEngine: getOnnxEngineHealth(),
        rateLimiter: getRateLimiterDiagnostics(),
        smsProvider: env.SMS_PROVIDER,
        vaultStorageDriver: env.VAULT_STORAGE_DRIVER,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Versioned modular /api/v1 routes
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/users", usersRouter);
  app.use("/api/v1/public", publicVerifyRouter);
  app.use("/api/v1/verification", verificationRouter);
  app.use("/api/v1/ai", aiRouter);
  app.use("/api/v1", operationsRouter);
  app.use("/api/v1", supplyChainRouter);
  app.use("/api/v1", marketplaceRouter);
  app.use("/api/v1/admin", adminRouter);

  app.use((_req, res) => {
    sendError(res, 404, "ROUTE_NOT_FOUND", "Requested API endpoint does not exist");
  });

  app.use(globalErrorHandler);

  return app;
}

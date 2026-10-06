import "reflect-metadata";
import {
  Module,
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
  HttpException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json as parseJson } from "express";
import type { Response } from "express";
import { ZodError } from "zod";
import { PrismaClient, PlatformRepository } from "@company/database";
import { DomainError } from "@company/workflow";
import { config, ApiEnv, safeLog } from "@company/observability";
import { Redis } from "ioredis";
import { ApiController } from "./controller";
import { PlatformService } from "./service";
import { SecurityService, type OperatorRequest } from "./security";
@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<OperatorRequest>();
    const res = http.getResponse<Response>();
    const parserStatus =
      (error as { type?: string })?.type === "entity.too.large"
        ? 413
        : (error as { type?: string })?.type === "entity.parse.failed"
          ? 400
          : null;
    const status =
      parserStatus ??
      (error instanceof DomainError
        ? error.status
        : error instanceof ZodError
          ? 400
          : error instanceof HttpException
            ? error.getStatus()
            : 503);
    const code =
      parserStatus === 413
        ? "INPUT_TOO_LARGE"
        : parserStatus === 400
          ? "INVALID_JSON"
          : error instanceof DomainError
            ? error.code
            : error instanceof ZodError
              ? "INVALID_INPUT"
              : status === 404
                ? "NOT_FOUND"
                : "SERVICE_UNAVAILABLE";
    if (status >= 500) safeLog(code, { correlationId: req.correlationId });
    res.status(status).json({
      code,
      message:
        error instanceof DomainError
          ? error.message
          : error instanceof ZodError
            ? "Check required fields, limits and unexpected fields."
            : "The service is unavailable or the route does not exist.",
      correlationId: req.correlationId,
    });
  }
}
export async function createApi() {
  const env = config(ApiEnv);
  const db = new PrismaClient();
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on("error", () => undefined);
  await db.$connect();
  const repo = new PlatformRepository(
    db,
    env.PROVIDER,
    env.PROVIDER === "OPENAI" ? env.OPENAI_PRODUCT_MODEL : null,
  );
  const security = new SecurityService(
    env.SESSION_SECRET,
    env.OPERATOR_PASSWORD,
    env.WEB_ORIGIN,
    redis,
  );
  @Module({
    controllers: [ApiController],
    providers: [
      { provide: PlatformService, useValue: new PlatformService(repo, redis) },
      { provide: SecurityService, useValue: security },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  app.use(security.middleware);
  app.use(parseJson({ limit: "128kb", strict: true }));
  app.useGlobalFilters(new SafeErrors());
  await app.init();
  return {
    app,
    db,
    redis,
    env,
    close: async () => {
      await app.close();
      await redis.quit();
      await db.$disconnect();
    },
  };
}

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { Login, EmptyCommand } from "@company/contracts";
import { DomainError } from "@company/workflow";
import type { Redis } from "ioredis";
const equal = (a: string, b: string) => {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export interface OperatorRequest extends Request {
  operator: { id: string; csrf: string; sid: string };
  correlationId: string;
}
export class SecurityService {
  constructor(
    readonly secret: string,
    readonly password: string,
    readonly origin: string,
    readonly redis: Redis,
  ) {}
  private sign(data: string) {
    return createHmac("sha256", this.secret).update(data).digest("base64url");
  }
  read(req: Request) {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("operator_session="))
      ?.slice("operator_session=".length);
    if (!cookie) return null;
    const [data, signature] = cookie.split(".");
    if (!data || !signature || !equal(this.sign(data), signature)) return null;
    try {
      const session = JSON.parse(Buffer.from(data, "base64url").toString()) as {
        id: string;
        csrf: string;
        sid: string;
        expires: number;
      };
      return session.id === "operator" &&
        session.expires > Date.now() &&
        typeof session.csrf === "string" &&
        typeof session.sid === "string"
        ? session
        : null;
    } catch {
      return null;
    }
  }
  middleware = async (req: Request, res: Response, next: NextFunction) => {
    const r = req as OperatorRequest;
    r.correlationId = randomBytes(16).toString("hex");
    res.setHeader("X-Correlation-Id", r.correlationId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (
      write &&
      (req.headers.origin !== this.origin || !req.is("application/json"))
    )
      return res.status(403).json({
        code: "ORIGIN_REJECTED",
        message: "Use the local operator UI with a valid Origin and JSON body.",
        correlationId: r.correlationId,
      });
    if (req.path.startsWith("/health/") || req.path === "/auth/login")
      return next();
    const session = this.read(req);
    if (!session)
      return res.status(401).json({
        code: "SESSION_REQUIRED",
        message: "Sign in to continue.",
        correlationId: r.correlationId,
      });
    try {
      if (!(await this.redis.exists("session:" + session.sid)))
        return res.status(401).json({
          code: "SESSION_REQUIRED",
          message: "Sign in to continue.",
          correlationId: r.correlationId,
        });
    } catch {
      return res.status(503).json({
        code: "SERVICE_UNAVAILABLE",
        message: "Session service unavailable.",
        correlationId: r.correlationId,
      });
    }
    r.operator = { id: session.id, csrf: session.csrf, sid: session.sid };
    if (
      write &&
      !equal(String(req.headers["x-csrf-token"] ?? ""), session.csrf)
    )
      return res.status(403).json({
        code: "CSRF_REJECTED",
        message: "Refresh your session and try again.",
        correlationId: r.correlationId,
      });
    next();
  };
  async login(body: unknown, req: Request, res: Response) {
    const input = Login.parse(body);
    const key =
      "login:" +
      createHmac("sha256", this.secret)
        .update(req.socket.remoteAddress ?? "local")
        .digest("hex");
    // One atomic Redis counter with fixed expiry; no password or request body stored.
    const count = Number(
      await this.redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n",
        1,
        key,
      ),
    );
    if (count > 10)
      throw new DomainError(
        "LOGIN_RATE_LIMIT",
        429,
        "Too many attempts. Try again in 15 minutes.",
      );
    if (!equal(this.sign(input.password), this.sign(this.password)))
      throw new DomainError(
        "INVALID_CREDENTIALS",
        401,
        "Incorrect operator password.",
      );
    const session = {
      id: "operator",
      sid: randomBytes(32).toString("hex"),
      csrf: randomBytes(32).toString("hex"),
      expires: Date.now() + 8 * 60 * 60 * 1000,
    };
    const data = Buffer.from(JSON.stringify(session)).toString("base64url");
    await this.redis.set("session:" + session.sid, "1", "EX", 8 * 60 * 60);
    res.cookie("operator_session", data + "." + this.sign(data), {
      httpOnly: true,
      sameSite: "strict",
      secure: this.origin.startsWith("https:"),
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    });
    return { actorId: session.id, csrfToken: session.csrf };
  }
  async logout(req: OperatorRequest, res: Response, body: unknown) {
    EmptyCommand.parse(body);
    await this.redis.del("session:" + req.operator.sid);
    res.clearCookie("operator_session", {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    return { ok: true };
  }
}

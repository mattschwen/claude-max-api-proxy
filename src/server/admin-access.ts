import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

function safeTokenEquals(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAdminAuthorized(params: {
  remoteAddress?: string;
  authorization?: string;
  adminToken?: string;
}): boolean {
  const expected = params.adminToken?.trim();
  if (!expected) {
    return isLoopbackAddress(params.remoteAddress);
  }
  const bearer = params.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return Boolean(bearer && safeTokenEquals(bearer, expected));
}

export function requireAdminAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authorization = req.header("authorization");
  const adminHeader = req.header("x-admin-token");
  if (
    isAdminAuthorized({
      remoteAddress: req.socket.remoteAddress,
      authorization:
        authorization || (adminHeader ? `Bearer ${adminHeader}` : undefined),
      adminToken: process.env.CLAUDE_PROXY_ADMIN_TOKEN,
    })
  ) {
    next();
    return;
  }

  res.status(403).json({
    error: {
      message:
        "Administrative access is restricted to localhost unless CLAUDE_PROXY_ADMIN_TOKEN is configured.",
      type: "permission_error",
      code: "admin_access_denied",
    },
  });
}

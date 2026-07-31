import assert from "node:assert/strict";
import test from "node:test";
import { isAdminAuthorized } from "./admin-access.js";

test("admin access defaults to loopback only", () => {
  assert.equal(isAdminAuthorized({ remoteAddress: "127.0.0.1" }), true);
  assert.equal(isAdminAuthorized({ remoteAddress: "::1" }), true);
  assert.equal(isAdminAuthorized({ remoteAddress: "::ffff:127.0.0.1" }), true);
  assert.equal(isAdminAuthorized({ remoteAddress: "192.168.1.20" }), false);
});

test("configured admin token is required even on loopback", () => {
  assert.equal(
    isAdminAuthorized({
      remoteAddress: "127.0.0.1",
      adminToken: "secret",
    }),
    false,
  );
  assert.equal(
    isAdminAuthorized({
      remoteAddress: "192.168.1.20",
      adminToken: "secret",
      authorization: "Bearer secret",
    }),
    true,
  );
  assert.equal(
    isAdminAuthorized({
      remoteAddress: "127.0.0.1",
      adminToken: "secret",
      authorization: "Bearer wrong",
    }),
    false,
  );
});

// Tests for the Node.js CVE gate (#290). Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, eolStatus, pinDrift, securityFixesSince } from "./check-node-version.mjs";

const index = [
  { version: "v24.22.1", security: true },
  { version: "v22.23.4", security: true },
  { version: "v22.23.3", security: false },
  { version: "v22.23.2", security: true },
  { version: "v22.23.1", security: false },
];

test("compareVersions orders numerically, not lexically", () => {
  assert.ok(compareVersions("22.10.0", "22.9.0") > 0);
  assert.ok(compareVersions("v22.23.2", "22.23.4") < 0);
  assert.equal(compareVersions("v22.23.4", "22.23.4"), 0);
});

test("a version behind a security release on its line is vulnerable", () => {
  assert.deepEqual(securityFixesSince("22.23.2", index), ["v22.23.4"]);
  assert.deepEqual(securityFixesSince("22.23.1", index), ["v22.23.2", "v22.23.4"]);
});

test("the latest security release passes, and other lines are ignored", () => {
  assert.deepEqual(securityFixesSince("22.23.4", index), []);
  assert.deepEqual(securityFixesSince("v24.22.1", index), []);
});

test("a newer non-security release does not fail the gate", () => {
  assert.deepEqual(securityFixesSince("22.23.4", [...index, { version: "v22.23.5", security: false }]), []);
});

test("eolStatus: supported, on the end date, and unknown lines", () => {
  const schedule = { v22: { end: "2027-04-30" } };
  assert.deepEqual(eolStatus("22.23.4", schedule, "2026-10-27"), { eol: false, end: "2027-04-30", daysLeft: 185 });
  assert.equal(eolStatus("22.23.4", schedule, "2027-04-30").eol, true);
  assert.equal(eolStatus("20.0.0", schedule, "2026-10-27").eol, true);
});

test("pinDrift flags every Dockerfile stage and engines independently", () => {
  const ok = { dockerfile: "FROM node:22.23.4-slim AS base\nFROM node:22.23.4-slim AS runtime\n", engines: "^22.23.4" };
  assert.deepEqual(pinDrift("22.23.4", ok), []);
  assert.equal(pinDrift("22.23.4", { ...ok, dockerfile: "FROM node:22-slim AS base\nFROM node:22.23.4-slim\n" }).length, 1);
  assert.equal(pinDrift("22.23.4", { ...ok, engines: undefined }).length, 1);
  assert.equal(pinDrift("22.23.4", { ...ok, dockerfile: "FROM debian\n" }).length, 1);
});

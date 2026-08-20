import { test } from "node:test";
import assert from "node:assert/strict";

import { greet } from "../index.js";

test("greets with the default greeting", () => {
	assert.equal(greet("world"), "Hello, world!");
});

test("honors a custom greeting", () => {
	assert.equal(greet("world", { greeting: "Hi" }), "Hi, world!");
});

test("an empty custom greeting is used as-is, not defaulted", () => {
	assert.equal(greet("world", { greeting: "" }), ", world!");
});

test("an empty name still produces a greeting", () => {
	assert.equal(greet(""), "Hello, !");
});

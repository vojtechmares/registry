#!/usr/bin/env node
/**
 * Migration hygiene.
 *
 * D1 migrations are append-only: once a migration has shipped, the database it
 * ran against is out of reach, and editing the file only changes what a *fresh*
 * database would get. The two would then disagree, silently, forever. So this
 * refuses two things - a gap or a duplicate in the numbering, and a change to a
 * migration that already exists on the base branch.
 *
 *   node scripts/check-migrations.mjs            # numbering only
 *   node scripts/check-migrations.mjs <base-ref> # also: nothing already merged was edited
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Runs git with an argument array, so nothing is interpolated through a shell. */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const DIR = fileURLToPath(new URL("../apps/registry/migrations", import.meta.url));
const PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

function fail(message) {
  console.error(`migration hygiene: ${message}`);
  process.exitCode = 1;
}

const files = readdirSync(DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

// Sequential numbering, starting at 0001, with no gaps and no duplicates. A gap
// is a migration someone forgot to commit; a duplicate is two people numbering
// against the same base and one of them about to be lost.
const numbers = [];
for (const name of files) {
  const match = PATTERN.exec(name);
  if (match === null) {
    fail(`"${name}" is not named NNNN_snake_case.sql`);
    continue;
  }
  numbers.push({ number: Number(match[1]), name });
}

numbers.sort((a, b) => a.number - b.number);
for (let i = 0; i < numbers.length; i++) {
  const expected = i + 1;
  const { number, name } = numbers[i];
  if (number !== expected) {
    fail(`expected migration ${String(expected).padStart(4, "0")}, found "${name}"`);
    break;
  }
}

const seen = new Set();
for (const { number } of numbers) {
  if (seen.has(number)) fail(`two migrations share the number ${number}`);
  seen.add(number);
}

// Append-only: a migration that exists on the base branch must be byte-for-byte
// what it was there. Only run when a base ref is given, which CI does on a PR.
const base = process.argv[2];
if (base !== undefined && base !== "") {
  let merged;
  try {
    merged = git(["ls-tree", "-r", "--name-only", base, "--", "apps/registry/migrations"])
      .split("\n")
      .filter((line) => line.endsWith(".sql"));
  } catch (error) {
    fail(`could not read migrations from "${base}": ${error.message}`);
    merged = [];
  }

  for (const path of merged) {
    const name = path.split("/").at(-1);
    let before;
    try {
      before = git(["show", `${base}:${path}`]);
    } catch {
      continue;
    }

    let after;
    try {
      after = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    } catch {
      fail(`"${name}" was deleted; a merged migration must never be removed`);
      continue;
    }

    if (before !== after) {
      fail(`"${name}" was edited after being merged; add a new migration instead`);
    }
  }
}

if (process.exitCode) {
  console.error("\nMigrations are append-only. Add a new numbered file; never edit a merged one.");
} else {
  console.log(`migration hygiene: ${files.length} migrations, sequential and unmodified`);
}

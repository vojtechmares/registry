import { inSet } from "./charset.js";
import type { Program } from "./compile.js";

/**
 * Pike's virtual machine: every thread that is alive at a position is stepped
 * once, together, and a thread that reaches a program counter another thread
 * already reached at this position is dropped.
 *
 * That last clause is the whole safety argument. A program counter is visited
 * at most once per input position, so the work is bounded by
 * `program.length * input.length` no matter what the pattern is. `(a+)+$` has
 * nothing to explore exponentially, because the states it would explore are the
 * same states, and they are visited once.
 */

/**
 * Follows every epsilon transition out of `pc`, adding the instructions that
 * consume input (or accept) to `list`.
 *
 * `seen` is stamped with `generation` rather than cleared, so the set costs
 * nothing to reset between positions.
 */
function addThread(
  program: Program,
  list: number[],
  seen: Int32Array,
  generation: number,
  pc: number,
  atStart: boolean,
  atEnd: boolean,
): void {
  const stack = [pc];

  while (stack.length > 0) {
    const at = stack.pop()!;
    if (seen[at] === generation) continue;
    seen[at] = generation;

    const inst = program[at]!;
    switch (inst.op) {
      case "jmp": {
        stack.push(inst.to);
        break;
      }
      case "split": {
        stack.push(inst.y, inst.x);
        break;
      }
      case "assert": {
        if (inst.at === "start" ? atStart : atEnd) stack.push(at + 1);
        break;
      }
      default: {
        // `set` waits for a character; `match` accepts. Both stop the walk.
        list.push(at);
      }
    }
  }
}

/**
 * Whether `program` matches anywhere in `input`.
 *
 * A search, not an anchored match: a new thread starts at every position, which
 * is what makes `^` and `$` mean what a reader of a regular expression expects
 * them to mean.
 */
export function search(program: Program, input: string): boolean {
  // By code point, so that an astral character is one character to `.`.
  const chars = Array.from(input, (char) => char.codePointAt(0)!);
  const length = chars.length;

  const seen = new Int32Array(program.length).fill(-1);
  let generation = 0;
  let current: number[] = [];
  addThread(program, current, seen, generation, 0, true, length === 0);

  for (let position = 0; ; position++) {
    for (const pc of current) {
      if (program[pc]!.op === "match") return true;
    }
    if (position === length) return false;

    const next: number[] = [];
    generation++;
    const codePoint = chars[position]!;
    const atEnd = position + 1 === length;

    for (const pc of current) {
      const inst = program[pc]!;
      if (inst.op === "set" && inSet(inst.set, codePoint)) {
        addThread(program, next, seen, generation, pc + 1, false, atEnd);
      }
    }

    // The match may begin here rather than earlier. Adding the start state last
    // costs nothing: `seen` has already rejected it if an existing thread is there.
    addThread(program, next, seen, generation, 0, false, atEnd);
    current = next;
  }
}

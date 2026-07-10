import type { CharSet } from "./charset.js";
import { type Node, RegexSyntaxError } from "./parse.js";

/**
 * Thompson's construction: the syntax tree becomes a program for a virtual
 * machine whose only control flow is `split` (be in two places at once) and
 * `jmp`. There is no stack and nothing to unwind, which is precisely why the
 * matcher cannot backtrack.
 */

export type Inst =
  | { readonly op: "set"; readonly set: CharSet }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; to: number }
  | { readonly op: "assert"; readonly at: "start" | "end" }
  | { readonly op: "match" };

export type Program = readonly Inst[];

/**
 * Counted repetition is compiled by duplication, so `a{1000}` costs a thousand
 * instructions and `(a{100}){100}` costs ten thousand. The cap is what stops a
 * short pattern from turning into a long program.
 */
export const MAX_PROGRAM_LENGTH = 4096;

class Builder {
  readonly instructions: Inst[] = [];

  emit(inst: Inst): number {
    if (this.instructions.length >= MAX_PROGRAM_LENGTH) {
      throw new RegexSyntaxError(`the pattern compiles to more than ${MAX_PROGRAM_LENGTH} instructions`, 0);
    }
    return this.instructions.push(inst) - 1;
  }

  /** `split` and `jmp` are emitted before their targets are known, then patched. */
  patch(at: number, ends: { x?: number; y?: number; to?: number }): void {
    const inst = this.instructions[at]!;
    if (inst.op === "split") {
      if (ends.x !== undefined) inst.x = ends.x;
      if (ends.y !== undefined) inst.y = ends.y;
    } else if (inst.op === "jmp" && ends.to !== undefined) {
      inst.to = ends.to;
    }
  }

  get here(): number {
    return this.instructions.length;
  }
}

function emitNode(builder: Builder, node: Node): void {
  switch (node.kind) {
    case "empty": {
      return;
    }
    case "set": {
      builder.emit({ op: "set", set: node.set });
      return;
    }
    case "assert": {
      builder.emit({ op: "assert", at: node.at });
      return;
    }
    case "concat": {
      for (const part of node.parts) emitNode(builder, part);
      return;
    }
    case "alt": {
      emitAlternation(builder, node.options);
      return;
    }
    case "repeat": {
      emitRepeat(builder, node.node, node.min, node.max);
      return;
    }
  }
}

function emitAlternation(builder: Builder, options: readonly Node[]): void {
  const jumps: number[] = [];

  for (const [index, option] of options.entries()) {
    const last = index === options.length - 1;
    if (last) {
      emitNode(builder, option);
      break;
    }

    const split = builder.emit({ op: "split", x: 0, y: 0 });
    builder.patch(split, { x: builder.here });
    emitNode(builder, option);
    jumps.push(builder.emit({ op: "jmp", to: 0 }));
    builder.patch(split, { y: builder.here });
  }

  for (const jump of jumps) builder.patch(jump, { to: builder.here });
}

/** `L: split(body, out); body; jmp L; out:` - zero or more, in either order. */
function emitStar(builder: Builder, node: Node): void {
  const split = builder.emit({ op: "split", x: 0, y: 0 });
  builder.patch(split, { x: builder.here });
  emitNode(builder, node);
  builder.emit({ op: "jmp", to: split });
  builder.patch(split, { y: builder.here });
}

/** `split(body, out); body; out:` - zero or one. */
function emitOptional(builder: Builder, node: Node): void {
  const split = builder.emit({ op: "split", x: 0, y: 0 });
  builder.patch(split, { x: builder.here });
  emitNode(builder, node);
  builder.patch(split, { y: builder.here });
}

function emitRepeat(builder: Builder, node: Node, min: number, max: number | null): void {
  for (let i = 0; i < min; i++) emitNode(builder, node);

  if (max === null) {
    // `a{2,}` is `aa` followed by `a*`; `a{0,}` is `a*` alone.
    emitStar(builder, node);
    return;
  }

  // `a{2,4}` is `aa` followed by two independent `a?`. The language is the
  // same as the nested form, and boolean matching asks nothing more of it.
  for (let i = min; i < max; i++) emitOptional(builder, node);
}

export function compile(node: Node): Program {
  const builder = new Builder();
  emitNode(builder, node);
  builder.emit({ op: "match" });
  return builder.instructions;
}

import { errors } from "./errors.js";

/**
 * Google partial-response masks (`fields=items(title,link),searchInformation/totalResults`).
 *
 * Grammar: a comma-separated list of selectors; a selector is a `/`-separated path whose last segment
 * may carry a parenthesised sub-list; `*` selects every key. Selection on an array applies to each
 * element. A mask naming a field that does not exist is valid and simply selects nothing, which is how
 * Google treats optional fields such as `items` on an empty page.
 */
export interface FieldMask {
  readonly all: boolean;
  readonly children: ReadonlyMap<string, FieldMask>;
}

/** Google's response is at most five levels deep; anything far deeper is a malformed or hostile mask. */
const MAX_DEPTH = 32;
const NAME = /\*|[A-Za-z_$][\w$-]*/y;

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly src: string) {}

  parse(): FieldMask {
    const mask = this.list();
    if (this.pos !== this.src.length) this.fail();
    return mask;
  }

  private list(): FieldMask {
    const selectors = [this.selector()];
    while (this.peek() === ",") {
      this.pos++;
      selectors.push(this.selector());
    }
    return mergeMasks(selectors);
  }

  /** One selector as a mask rooted at the current level: `a/b(c)` → {a: {b: {c: full}}}. */
  private selector(): FieldMask {
    const path = [this.name()];
    while (this.peek() === "/") {
      this.pos++;
      path.push(this.name());
    }
    let mask: FieldMask = FULL;
    if (this.peek() === "(") {
      this.pos++;
      if (++this.depth > MAX_DEPTH) this.fail();
      mask = this.list();
      this.depth--;
      if (this.peek() !== ")") this.fail();
      this.pos++;
    }
    for (const segment of path.reverse()) {
      mask = segment === "*" && isFull(mask) ? FULL : { all: false, children: new Map([[segment, mask]]) };
    }
    return mask;
  }

  private name(): string {
    NAME.lastIndex = this.pos;
    const match = NAME.exec(this.src);
    if (!match) this.fail();
    this.pos += match[0].length;
    return match[0];
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private fail(): never {
    throw errors.invalidArgument(`Invalid field selection ${this.src}`);
  }
}

const FULL: FieldMask = { all: true, children: new Map() };

function isFull(mask: FieldMask): boolean {
  return mask.all && mask.children.size === 0;
}

/**
 * Union of masks, recursively: `items(pagemap(a)),items(pagemap(b))` keeps both a and b. All masks are
 * merged in one pass, so a mask with thousands of selectors costs time linear in its length.
 */
function mergeMasks(masks: readonly FieldMask[]): FieldMask {
  if (masks.length === 1) return masks[0] ?? FULL;
  if (masks.some(isFull)) return FULL;
  const grouped = new Map<string, FieldMask[]>();
  for (const mask of masks) {
    for (const [key, child] of mask.children) {
      const group = grouped.get(key);
      if (group === undefined) grouped.set(key, [child]);
      else group.push(child);
    }
  }
  const children = new Map<string, FieldMask>();
  for (const [key, group] of grouped) children.set(key, mergeMasks(group));
  return { all: masks.some((m) => m.all), children };
}

export function parseFieldMask(src: string): FieldMask {
  const compact = src.replace(/\s+/g, "");
  if (compact === "") throw errors.invalidArgument(`Invalid field selection ${src}`);
  return new Parser(compact).parse();
}

export function applyFieldMask(value: unknown, mask: FieldMask): unknown {
  if (mask.all && mask.children.size === 0) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => applyFieldMask(item, mask));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const subMask = mask.children.get(key) ?? mask.children.get("*");
    if (subMask !== undefined) out[key] = applyFieldMask(child, subMask);
    else if (mask.all) out[key] = child;
  }
  return out;
}

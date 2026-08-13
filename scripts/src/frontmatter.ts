// Closed parser for the Atlas §20.4 YAML-shaped grammar.
//
// The public entry points accept bytes and either return one complete parsed
// mapping or throw FrontmatterError. Nothing is decoded or newline-normalised
// by an I/O layer first: the ceilings are byte ceilings, and a text-mode read
// would hide them.
//
// §20.4 fixes this as a closed grammar rather than a YAML subset, so the
// parser stays hand-written. A third-party YAML library would accept a
// superset — anchors, flow collections, sexagesimals, `no` as false — and
// every one of those is a document Atlas must refuse, not interpret.

export class FrontmatterError extends Error {}

export type FrontmatterValue =
  | string
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export type FrontmatterMapping = { [key: string]: FrontmatterValue };

export const MAX_DOCUMENT_BYTES = 131_072;
export const MAX_FILE_BYTES = 262_144;
export const MAX_LINE_BYTES = 4_096;
export const MAX_SCALAR_BYTES = 8_192;
export const MAX_DEPTH = 8;
export const MAX_FIELDS = 64;
export const MAX_SEQUENCE_ENTRIES = 1_024;
export const MAX_NODES = 16_384;

const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/;
const UNSUPPORTED_PREFIXES = ["&", "*", "!", "%"];

// The set `str.strip()` removes, which is neither JavaScript's nor a guess:
// it includes U+0085 and the C1-adjacent separators, and excludes U+FEFF,
// where `String.prototype.trim` does the opposite on both counts. Trimming
// with the wrong set changes which documents parse, so it is spelled out.
const PY_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function pythonStrip(value: string): string {
  const points = [...value];
  let start = 0;
  let end = points.length;
  while (start < end && PY_WHITESPACE.has(points[start]!.codePointAt(0)!)) {
    start += 1;
  }
  while (end > start && PY_WHITESPACE.has(points[end - 1]!.codePointAt(0)!)) {
    end -= 1;
  }
  return points.slice(start, end).join("");
}

function error(source: string, line: number, message: string): FrontmatterError {
  return new FrontmatterError(`${source}: frontmatter line ${line}: ${message}`);
}

function lineOf(data: Uint8Array, offset: number): number {
  let count = 0;
  const limit = Math.min(offset, data.length);
  for (let i = 0; i < limit; i += 1) if (data[i] === 0x0a) count += 1;
  return count + 1;
}

function indexOfByte(data: Uint8Array, byte: number, from: number): number {
  for (let i = from; i < data.length; i += 1) if (data[i] === byte) return i;
  return -1;
}

function startsWithBytes(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

// Returns the offset of the first byte CPython would report as the start of an
// invalid sequence, or -1 when the input decodes. TextDecoder only reports
// *that* it failed, and the offset is what names the offending line.
export function firstInvalidUtf8Offset(data: Uint8Array): number {
  let i = 0;
  while (i < data.length) {
    const byte = data[i]!;
    if (byte < 0x80) {
      i += 1;
      continue;
    }
    let width: number;
    let lower: number;
    let upper: number;
    if (byte >= 0xc2 && byte <= 0xdf) {
      width = 2;
      lower = 0x80;
      upper = 0xbf;
    } else if (byte === 0xe0) {
      width = 3;
      lower = 0xa0;
      upper = 0xbf;
    } else if (byte >= 0xe1 && byte <= 0xec) {
      width = 3;
      lower = 0x80;
      upper = 0xbf;
    } else if (byte === 0xed) {
      // Excludes the surrogate range: UTF-8 has no encoding for D800..DFFF.
      width = 3;
      lower = 0x80;
      upper = 0x9f;
    } else if (byte >= 0xee && byte <= 0xef) {
      width = 3;
      lower = 0x80;
      upper = 0xbf;
    } else if (byte === 0xf0) {
      width = 4;
      lower = 0x90;
      upper = 0xbf;
    } else if (byte >= 0xf1 && byte <= 0xf3) {
      width = 4;
      lower = 0x80;
      upper = 0xbf;
    } else if (byte === 0xf4) {
      width = 4;
      lower = 0x80;
      upper = 0x8f;
    } else {
      // A bare continuation byte, an overlong lead (0xc0/0xc1), or 0xf5+.
      return i;
    }
    if (i + width > data.length) return i;
    const second = data[i + 1]!;
    if (second < lower || second > upper) return i;
    for (let k = 2; k < width; k += 1) {
      const cont = data[i + k]!;
      if (cont < 0x80 || cont > 0xbf) return i;
    }
    i += width;
  }
  return -1;
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeStrict(data: Uint8Array): string {
  return DECODER.decode(data);
}

interface Line {
  readonly text: string;
  readonly number: number;
  readonly indent: number;
  readonly content: string;
}

function ignored(line: Line): boolean {
  return line.content === "" || line.content.startsWith("#");
}

function validateFileBytes(data: Uint8Array, source: string): void {
  // Whole-file law is §25.8's (UTF-8, no BOM, LF only, the file ceiling);
  // tab/NUL/C0 are §20.4 frontmatter-region rules — the markdown body below
  // the closing fence is outside the grammar and may carry tabs.
  if (data.length > MAX_FILE_BYTES) {
    throw error(source, 1, `whole file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  if (startsWithBytes(data, [0xef, 0xbb, 0xbf])) {
    throw error(source, 1, "UTF-8 BOM is unsupported");
  }
  const cr = indexOfByte(data, 0x0d, 0);
  if (cr >= 0) {
    throw error(source, lineOf(data, cr), "CR/CRLF is unsupported; use LF");
  }
}

function validateUtf8(data: Uint8Array, source: string): void {
  const bad = firstInvalidUtf8Offset(data);
  if (bad >= 0) {
    throw error(source, lineOf(data, bad), "input is not strict UTF-8");
  }
}

// Returns the frontmatter region and its physical first-line number. The
// closing fence is located by bounded byte scanning before anything is decoded
// or split, so the document ceiling cannot be hidden by text I/O.
function fencedRegion(
  data: Uint8Array,
  source: string,
): { region: Uint8Array; firstLine: number } {
  if (!startsWithBytes(data, [0x2d, 0x2d, 0x2d, 0x0a])) {
    throw error(source, 1, "opening fence must be the exact line '---'");
  }
  let pos = 4;
  while (pos <= data.length) {
    let end = indexOfByte(data, 0x0a, pos);
    if (end < 0) end = data.length;
    const line = data.subarray(pos, end);
    if (line.length === 3 && line[0] === 0x2d && line[1] === 0x2d && line[2] === 0x2d) {
      const closingEnd = end + (end < data.length ? 1 : 0);
      if (closingEnd > MAX_DOCUMENT_BYTES) {
        throw error(
          source,
          lineOf(data, pos),
          `frontmatter exceeds ${MAX_DOCUMENT_BYTES} bytes`,
        );
      }
      return { region: data.subarray(4, pos), firstLine: 2 };
    }
    if (end >= MAX_DOCUMENT_BYTES) {
      throw error(
        source,
        lineOf(data, pos),
        `frontmatter exceeds ${MAX_DOCUMENT_BYTES} bytes`,
      );
    }
    if (end === data.length) break;
    pos = end + 1;
  }
  throw error(source, lineOf(data, data.length), "missing closing fence '---'");
}

function splitRegionLines(region: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (;;) {
    const end = indexOfByte(region, 0x0a, start);
    if (end < 0) {
      parts.push(region.subarray(start));
      return parts;
    }
    parts.push(region.subarray(start, end));
    start = end + 1;
  }
}

function validateRegionBytes(
  region: Uint8Array,
  source: string,
  firstLine: number,
): Line[] {
  if (region.length > MAX_DOCUMENT_BYTES) {
    throw error(
      source,
      firstLine,
      `frontmatter exceeds ${MAX_DOCUMENT_BYTES} bytes`,
    );
  }
  const lines: Line[] = [];
  const rawLines = splitRegionLines(region);
  for (let offset = 0; offset < rawLines.length; offset += 1) {
    const raw = rawLines[offset]!;
    const number = firstLine + offset;
    if (raw.length > MAX_LINE_BYTES) {
      throw error(source, number, `line exceeds ${MAX_LINE_BYTES} bytes`);
    }
    for (const byte of raw) {
      if (byte === 0x09) throw error(source, number, "tab is unsupported");
      if (byte === 0x00) throw error(source, number, "NUL is unsupported");
      if (byte < 0x20) {
        throw error(
          source,
          number,
          `C0 control 0x${byte.toString(16).padStart(2, "0")} is unsupported`,
        );
      }
    }
    let text: string;
    try {
      text = decodeStrict(raw);
    } catch {
      throw error(source, number, "input is not strict UTF-8");
    }
    let indent = 0;
    while (indent < text.length && text[indent] === " ") indent += 1;
    if (indent % 2) {
      throw error(
        source,
        number,
        "indentation must be exactly two spaces per level",
      );
    }
    lines.push({ text, number, indent, content: text.slice(indent) });
  }
  return lines;
}

class Parser {
  private readonly lines: Line[];
  private readonly source: string;
  private nodes = 0;

  constructor(lines: Line[], source: string) {
    this.lines = lines;
    this.source = source;
  }

  private fail(line: number, message: string): never {
    throw error(this.source, line, message);
  }

  private newNode(line: number): void {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) {
      this.fail(line, `parsed node count exceeds ${MAX_NODES}`);
    }
  }

  private significant(pos: number): number {
    while (pos < this.lines.length && ignored(this.lines[pos]!)) pos += 1;
    return pos;
  }

  parse(): FrontmatterMapping {
    let pos = this.significant(0);
    if (pos === this.lines.length) {
      const line = this.lines.length > 0 ? this.lines[0]!.number : 1;
      this.fail(line, "top-level mapping must be non-empty");
    }
    if (this.lines[pos]!.indent !== 0) {
      this.fail(
        this.lines[pos]!.number,
        "top-level mapping must start at column zero",
      );
    }
    const [value, consumed] = this.parseContainer(pos, 0, 1);
    const end = this.significant(consumed);
    if (end !== this.lines.length) {
      this.fail(
        this.lines[end]!.number,
        "unexpected content after top-level mapping",
      );
    }
    if (Array.isArray(value) || typeof value === "string") {
      this.fail(this.lines[pos]!.number, "top-level value must be a mapping");
    }
    return value;
  }

  private parseContainer(
    pos: number,
    indent: number,
    depth: number,
  ): [FrontmatterValue, number] {
    if (depth > MAX_DEPTH) {
      const line = pos < this.lines.length ? this.lines[pos]!.number : 1;
      this.fail(line, `nesting depth exceeds ${MAX_DEPTH}`);
    }
    pos = this.significant(pos);
    if (pos >= this.lines.length) {
      this.fail(
        this.lines.length > 0 ? this.lines[this.lines.length - 1]!.number : 1,
        "nested container is empty",
      );
    }
    const line = this.lines[pos]!;
    if (line.indent !== indent) {
      this.fail(line.number, `expected indentation of ${indent} spaces`);
    }
    if (line.content === "-" || line.content.startsWith("- ")) {
      return this.parseSequence(pos, indent, depth);
    }
    return this.parseMapping(pos, indent, depth);
  }

  private parseMapping(
    pos: number,
    indent: number,
    depth: number,
    initial?: readonly [string, string | undefined, Line],
  ): [FrontmatterMapping, number] {
    this.newNode(initial ? initial[2].number : this.lines[pos]!.number);
    const result: FrontmatterMapping = {};
    let fields = 0;

    const add = (
      key: string,
      raw: string | undefined,
      line: Line,
      nextPos: number,
    ): number => {
      fields += 1;
      if (fields > MAX_FIELDS) {
        this.fail(line.number, `mapping has more than ${MAX_FIELDS} fields`);
      }
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        this.fail(line.number, "duplicate-key; expected unique mapping keys");
      }
      if (raw === undefined) {
        const child = this.significant(nextPos);
        if (child >= this.lines.length || this.lines[child]!.indent <= indent) {
          this.fail(
            line.number,
            `bare key ${pythonRepr(key)} has no nested container`,
          );
        }
        if (this.lines[child]!.indent !== indent + 2) {
          this.fail(
            this.lines[child]!.number,
            `nested value for ${pythonRepr(key)} must be indented exactly two spaces`,
          );
        }
        const [value, consumed] = this.parseContainer(
          child,
          indent + 2,
          depth + 1,
        );
        result[key] = value;
        return consumed;
      }
      if (raw === ">") {
        const [value, consumed] = this.parseFolded(nextPos, indent, line);
        result[key] = value;
        this.newNode(line.number);
        return consumed;
      }
      result[key] = this.parseScalar(raw, line.number);
      this.newNode(line.number);
      return nextPos;
    };

    if (initial) pos = add(initial[0], initial[1], initial[2], pos);
    for (;;) {
      pos = this.significant(pos);
      if (pos >= this.lines.length) break;
      const line = this.lines[pos]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        this.fail(line.number, `ambiguous indentation; expected ${indent} spaces`);
      }
      if (line.content === "-" || line.content.startsWith("- ")) {
        this.fail(line.number, "mapping and sequence entries cannot mix");
      }
      const match = KEY_VALUE.exec(line.content);
      if (match === null) {
        this.fail(line.number, "expected 'key: value' mapping entry");
      }
      pos = add(match[1]!, match[2], line, pos + 1);
    }
    if (Object.keys(result).length === 0) {
      this.fail(
        initial ? initial[2].number : this.lines[pos]!.number,
        "mapping must be non-empty",
      );
    }
    return [result, pos];
  }

  private parseSequence(
    pos: number,
    indent: number,
    depth: number,
  ): [FrontmatterValue[], number] {
    this.newNode(this.lines[pos]!.number);
    const result: FrontmatterValue[] = [];
    let itemKind: string | null = null;
    for (;;) {
      pos = this.significant(pos);
      if (pos >= this.lines.length) break;
      const line = this.lines[pos]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        this.fail(line.number, `ambiguous indentation; expected ${indent} spaces`);
      }
      if (line.content === "-") {
        this.fail(line.number, "a bare sequence marker has no value");
      }
      if (!line.content.startsWith("- ")) {
        this.fail(line.number, "mapping and sequence entries cannot mix");
      }
      if (result.length >= MAX_SEQUENCE_ENTRIES) {
        this.fail(
          line.number,
          `sequence has more than ${MAX_SEQUENCE_ENTRIES} entries`,
        );
      }
      const raw = line.content.slice(2);
      const mapping = KEY_VALUE.exec(raw);
      const kind = mapping ? "mapping" : "scalar";
      if (itemKind !== null && kind !== itemKind) {
        this.fail(
          line.number,
          "scalar and mapping sequence entries cannot mix",
        );
      }
      itemKind = kind;
      if (mapping) {
        const [value, consumed] = this.parseMapping(pos + 1, indent + 2, depth + 1, [
          mapping[1]!,
          mapping[2],
          line,
        ]);
        result.push(value);
        pos = consumed;
      } else {
        if (pythonStrip(raw) === "[]") {
          this.fail(line.number, "sequences cannot contain nested sequences");
        }
        result.push(this.parseScalar(raw, line.number));
        this.newNode(line.number);
        pos += 1;
      }
    }
    return [result, pos];
  }

  private parseFolded(
    pos: number,
    parentIndent: number,
    owner: Line,
  ): [string, number] {
    const parts: string[] = [];
    while (pos < this.lines.length) {
      const line = this.lines[pos]!;
      if (line.content === "") {
        // §20.4 forbids blank *continuation* lines: blank, then more
        // deeper-indented fold text. A blank separator before the next
        // sibling (or EOF) simply terminates the folded block.
        const next = this.significant(pos);
        if (
          next < this.lines.length &&
          this.lines[next]!.indent > parentIndent
        ) {
          this.fail(
            line.number,
            "blank folded-text continuation is unsupported",
          );
        }
        break;
      }
      if (line.indent <= parentIndent) break;
      if (line.indent !== parentIndent + 2) {
        this.fail(line.number, "folded text must be indented exactly two spaces");
      }
      if (line.content.startsWith("#")) {
        pos += 1;
        continue;
      }
      parts.push(pythonStrip(line.content));
      pos += 1;
    }
    if (parts.length === 0) {
      this.fail(owner.number, "folded text must have a non-empty continuation");
    }
    const value = parts.join(" ");
    this.checkScalarSize(value, owner.number);
    return [value, pos];
  }

  private checkScalarSize(value: string, line: number): void {
    let bytes = 0;
    for (const char of value) {
      const point = char.codePointAt(0)!;
      if (point < 0x20 && char !== "\n") {
        this.fail(
          line,
          `scalar contains unsupported C0 control 0x${point.toString(16).padStart(2, "0")}`,
        );
      }
      // A lone surrogate has no UTF-8 encoding. Python raises on encode;
      // TextEncoder would silently substitute U+FFFD and hide the fault, so
      // the check is explicit and happens before any measurement.
      if (point >= 0xd800 && point <= 0xdfff) {
        this.fail(line, "scalar contains an unsupported Unicode surrogate");
      }
      bytes += point < 0x80
        ? 1
        : point < 0x800
        ? 2
        : point < 0x10000
        ? 3
        : 4;
    }
    if (bytes > MAX_SCALAR_BYTES) {
      this.fail(line, `scalar exceeds ${MAX_SCALAR_BYTES} bytes`);
    }
  }

  private parseScalar(raw: string, line: number): FrontmatterValue {
    const value = pythonStrip(raw);
    if (value === "") this.fail(line, 'empty scalar must be written as ""');
    if (value === "[]") return [];
    if (value.startsWith("|")) {
      this.fail(line, "literal block scalar '|' is unsupported");
    }
    if (value.startsWith(">")) {
      this.fail(line, "folded-text chomping indicators are unsupported");
    }
    if (value.startsWith("'")) {
      this.fail(line, "single-quoted scalars are unsupported");
    }
    if (value.startsWith('"')) {
      const decoded = decodeJsonString(value);
      if (decoded === undefined) {
        this.fail(line, "double-quoted scalar must use JSON string escaping");
      }
      this.checkScalarSize(decoded, line);
      return decoded;
    }
    if (
      UNSUPPORTED_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
      value === "<<" ||
      value.startsWith("<<:")
    ) {
      this.fail(
        line,
        "anchors, aliases, tags, merge keys, and directives are unsupported",
      );
    }
    if (value === "---" || value === "...") {
      this.fail(line, "multiple documents are unsupported");
    }
    if ([...value].some((char) => "{}[]".includes(char))) {
      this.fail(line, "flow-style collections are unsupported");
    }
    this.checkScalarSize(value, line);
    return value;
  }
}

// Python renders a key in a diagnostic with repr(): single quotes unless the
// text contains one. The message is part of the contract a caller matches on,
// so the quoting is reproduced rather than approximated with JSON.
function pythonRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    if (char === "\\") out += "\\\\";
    else if (char === quote) out += "\\" + char;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else out += char;
  }
  return out + quote;
}

// A double-quoted scalar is decoded with JSON string rules, matching the
// reference implementation's json.loads. Returns undefined when the text is
// not exactly one JSON string.
function decodeJsonString(value: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return typeof parsed === "string" ? parsed : undefined;
}

export function parseFrontmatter(
  data: Uint8Array,
  source = "<bytes>",
): FrontmatterMapping {
  validateFileBytes(data, source);
  const { region, firstLine } = fencedRegion(data, source);
  const lines = validateRegionBytes(region, source, firstLine);
  validateUtf8(data, source);
  return new Parser(lines, source).parse();
}

// The markdown body below the closing fence — outside the grammar (§20.4).
// Call only on input parseFrontmatter accepted: the grammar forbids a bare
// `---` line inside the block, so the first one after the opening fence is
// the closing fence.
export function frontmatterBody(data: Uint8Array): string {
  const needle = [0x0a, 0x2d, 0x2d, 0x2d, 0x0a];
  for (let i = 3; i + needle.length <= data.length; i += 1) {
    let hit = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (data[i + k] !== needle[k]) {
        hit = false;
        break;
      }
    }
    if (hit) return decodeStrict(data.subarray(i + 5));
  }
  return "";
}

// The fence-less top-level mapping used by §21.2 plan extracts.
export function parseDocument(
  data: Uint8Array,
  source = "<bytes>",
): FrontmatterMapping {
  validateFileBytes(data, source);
  if (data.length > MAX_DOCUMENT_BYTES) {
    throw error(source, 1, `frontmatter exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const lines = validateRegionBytes(data, source, 1);
  for (const line of lines) {
    if (line.indent === 0 && (line.content === "---" || line.content === "...")) {
      throw error(
        source,
        line.number,
        "fences and multiple documents are unsupported",
      );
    }
    if (line.indent === 0 && line.content.startsWith("%")) {
      throw error(source, line.number, "directives are unsupported");
    }
  }
  return new Parser(lines, source).parse();
}

import { readFileSync } from "node:fs";

/**
 * Turns a spoken phrase into the token sequence sherpa-onnx's keyword spotter
 * expects, e.g. `hey jeff` -> `▁HE Y ▁JE FF`.
 *
 * This is what makes the wake word **open-vocabulary with zero training**: any
 * phrase the user types in Settings becomes a keyword immediately, with no model
 * to retrain and no Python toolchain. sherpa-onnx ships a `text2token` CLI for
 * this, but it is a Python package; the algorithm is small enough to just do.
 *
 * The model is a SentencePiece **unigram** model despite the `bpe.model`
 * filename, so encoding is Viterbi — the segmentation maximising the summed
 * piece scores — not greedy longest-match and not BPE merge-by-rank. Both of
 * those were tried and disagreed with the model's own reference keyword list;
 * Viterbi reproduces all nine entries exactly. See tests/text2token.test.ts.
 */

export interface SentencePiece {
  piece: string;
  score: number;
}

/**
 * Minimal protobuf reader for SentencePiece's ModelProto.
 *
 * Only field 1 matters — `repeated SentencePiece pieces`, where each entry
 * carries `1: string piece` and `2: float score`. Everything else is skipped by
 * wire type. Pulling in a protobuf runtime for ~40 lines would be poor value.
 */
export function parseSentencePieceModel(buf: Buffer): SentencePiece[] {
  const pieces: SentencePiece[] = [];
  let o = 0;

  const varint = (): number => {
    let result = 0n;
    let shift = 0n;
    let byte: bigint;
    do {
      byte = BigInt(buf[o++] ?? 0);
      result |= (byte & 0x7fn) << shift;
      shift += 7n;
    } while (byte & 0x80n && o < buf.length);
    return Number(result);
  };

  /**
   * Advance past a field we do not care about.
   *
   * Note the explicit temporary for the length-delimited case: `o += varint()`
   * would read `o` *before* varint() advances it, so the length prefix would be
   * counted twice and the cursor would land in the middle of a record.
   */
  const skip = (wire: number): boolean => {
    if (wire === 0) varint();
    else if (wire === 2) {
      const len = varint();
      o += len;
    } else if (wire === 5) o += 4;
    else if (wire === 1) o += 8;
    else return false;
    return true;
  };

  while (o < buf.length) {
    const key = varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      const len = varint(); // must complete before `o` is read for `end`
      const end = o + len;
      let piece = "";
      let score = 0;
      while (o < end) {
        const k = varint();
        const f = k >> 3;
        const w = k & 7;
        if (f === 1 && w === 2) {
          const len = varint();
          piece = buf.toString("utf8", o, o + len);
          o += len;
        } else if (f === 2 && w === 5) {
          score = buf.readFloatLE(o);
          o += 4;
        } else if (!skip(w)) break;
      }
      pieces.push({ piece, score });
      o = end;
    } else if (!skip(wire)) break;
  }
  return pieces;
}

export class PhraseTokenizer {
  private readonly score = new Map<string, number>();
  private readonly maxPieceLength: number;

  constructor(pieces: SentencePiece[]) {
    for (const p of pieces) this.score.set(p.piece, p.score);
    this.maxPieceLength = pieces.reduce((m, p) => Math.max(m, p.piece.length), 1);
  }

  static fromFile(modelPath: string): PhraseTokenizer {
    return new PhraseTokenizer(parseSentencePieceModel(readFileSync(modelPath)));
  }

  /** Viterbi over one word. `▁` marks a word boundary, as SentencePiece does. */
  private encodeWord(word: string): string[] | null {
    const s = `▁${word.toUpperCase()}`;
    const n = s.length;
    const best = new Array<number>(n + 1).fill(-Infinity);
    const back = new Array<[number, string] | null>(n + 1).fill(null);
    best[0] = 0;

    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      const limit = Math.min(this.maxPieceLength, n - i);
      for (let len = 1; len <= limit; len++) {
        const sub = s.slice(i, i + len);
        const sc = this.score.get(sub);
        if (sc === undefined) continue;
        const total = best[i]! + sc;
        if (total > best[i + len]!) {
          best[i + len] = total;
          back[i + len] = [i, sub];
        }
      }
    }
    if (best[n] === -Infinity) return null; // contains an out-of-vocabulary character

    const out: string[] = [];
    for (let i = n; i > 0; ) {
      const step = back[i];
      if (!step) return null;
      out.unshift(step[1]);
      i = step[0];
    }
    return out;
  }

  /** Returns null when the phrase cannot be represented by this model. */
  encode(phrase: string): string | null {
    const words = phrase.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const encoded = words.map((w) => this.encodeWord(w));
    return encoded.some((e) => e === null) ? null : encoded.flat().join(" ");
  }

  /**
   * Build a sherpa-onnx keywords file.
   *
   * The line format is `<tokens> [:<boost>] [#<threshold>] [@<phrase>]`, and it
   * is parsed by **splitting on whitespace** — which makes two things
   * load-bearing:
   *
   *   - `#` introduces a per-keyword *threshold*, a float. It is not a comment
   *     and not a display name. Writing `#hey jeff` makes the C++ side call
   *     `std::stof("hey")`, which throws `std::invalid_argument` and **aborts
   *     the entire process** — a native abort that no JavaScript try/catch can
   *     intercept. So the only defence is to never emit a malformed line.
   *   - `@<phrase>` is the display name, and it cannot contain spaces for the
   *     same splitting reason. Spaces become underscores here and are converted
   *     back when a detection is reported.
   *
   * `boost` raises a keyword's likelihood without retraining — the documented
   * lever for trading false accepts against misses.
   */
  buildKeywordsFile(phrases: string[], boost = 1.5): { text: string; skipped: string[] } {
    const lines: string[] = [];
    const skipped: string[] = [];
    for (const phrase of phrases) {
      // Normalise first: a user typing "Hey Jeff!" in Settings should work, but
      // "!" is not in the token vocabulary and would make the phrase unusable.
      const normalized = normalizePhrase(phrase);
      const tokens = this.encode(normalized);
      const label = toLabel(normalized);
      if (!tokens || !label) {
        skipped.push(phrase);
        continue;
      }
      lines.push(`${tokens} :${boost.toFixed(1)} @${label}`);
    }
    return { text: `${lines.join("\n")}\n`, skipped };
  }
}

/** Reduce a user-typed phrase to what the token model can actually represent. */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whitespace-free label for the `@` field, and its inverse.
 *
 * Restricted to characters that cannot be mistaken for another field marker or
 * for a token, because a bad line aborts the process rather than erroring.
 */
export function toLabel(phrase: string): string {
  return phrase
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export function fromLabel(label: string): string {
  return label.replace(/_/g, " ");
}

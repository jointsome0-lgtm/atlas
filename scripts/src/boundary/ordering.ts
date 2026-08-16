export function compareCodePoint(left: string, right: string): number {
  if (left === right) return 0;

  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();

  for (;;) {
    const a = leftPoints.next();
    const b = rightPoints.next();
    if (a.done === true) return b.done === true ? 0 : -1;
    if (b.done === true) return 1;

    const x = a.value.codePointAt(0) as number;
    const y = b.value.codePointAt(0) as number;
    if (x !== y) return x < y ? -1 : 1;
  }
}

export function sortedByCodePoint(values: readonly string[]): string[] {
  return [...values].sort(compareCodePoint);
}

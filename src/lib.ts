export function asArray(v: string | string[] | undefined): string[] {
  if (!v) {
    return [];
  }

  return Array.isArray(v) ? v : [v];
}

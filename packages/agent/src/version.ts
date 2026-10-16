/** Patch-bump a semver-ish version string: "1.4.2" -> "1.4.3". Unparseable input becomes "<input>.1". */
export function patchBump(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim());
  if (!m) return `${version.trim()}.1`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

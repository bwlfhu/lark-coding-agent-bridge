export function packAndVerify(options?: {
  source?: string;
  output?: string;
  patternFile?: string;
}): Promise<string | undefined>;

export function verifyInstalledPackage(
  verifyDirectory: string,
  sourceRoot: string,
): Promise<void>;

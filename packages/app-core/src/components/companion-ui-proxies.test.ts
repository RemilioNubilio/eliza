import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentDir = path.dirname(fileURLToPath(import.meta.url));
const companionUiPath = path.resolve(
  componentDir,
  "../../../../apps/app-companion/src/ui.ts",
);

describe("Companion UI export contract", () => {
  it("re-exports companion shell control styles from the public ui entry", () => {
    const source = fs.readFileSync(companionUiPath, "utf8");

    expect(source).toContain(
      'export * from "./components/companion/shell-control-styles.ts";',
    );
  });
});

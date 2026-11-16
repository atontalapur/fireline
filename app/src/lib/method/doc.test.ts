import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCS_GITHUB_BASE, prepareMethodMarkdown, resolveDocHref } from "@/lib/method/doc";
import { loadValidation, methodDocPath, readMethodDoc } from "@/lib/method/load";

describe("prepareMethodMarkdown", () => {
  it("drops HTML comments", () => {
    expect(prepareMethodMarkdown("<!-- generated -->\n\n# Title\n\nText <!-- x --> here")).toBe(
      "# Title\n\nText here",
    );
  });
});

describe("resolveDocHref", () => {
  it("points relative doc links at GitHub", () => {
    expect(resolveDocHref("sentinel3.md")).toBe(`${DOCS_GITHUB_BASE}sentinel3.md`);
    expect(resolveDocHref("./sentinel3.md#chart")).toBe(`${DOCS_GITHUB_BASE}sentinel3.md#chart`);
  });

  it("leaves absolute URLs, root paths and anchors alone", () => {
    for (const h of ["https://doi.org/10.1/x", "mailto:a@b.c", "/", "#validation", undefined])
      expect(resolveDocHref(h)).toBe(h);
  });
});

describe("file loading", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "method-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads METHOD.md from METHOD_DOC_PATH", () => {
    const file = path.join(dir, "METHOD.md");
    writeFileSync(file, "# Method\n");
    vi.stubEnv("METHOD_DOC_PATH", file);
    expect(methodDocPath()).toBe(file);
    expect(readMethodDoc()).toBe("# Method\n");
  });

  it("defaults to docs/METHOD.md at the repo root", () => {
    vi.stubEnv("METHOD_DOC_PATH", undefined);
    expect(methodDocPath()).toBe(path.resolve(process.cwd(), "..", "docs", "METHOD.md"));
  });

  it("returns null for a missing or blank METHOD.md", () => {
    vi.stubEnv("METHOD_DOC_PATH", path.join(dir, "nope.md"));
    expect(readMethodDoc()).toBeNull();
    const blank = path.join(dir, "blank.md");
    writeFileSync(blank, "  \n");
    expect(readMethodDoc(blank)).toBeNull();
  });

  it("loads validation.json, reporting missing and invalid files", async () => {
    expect(await loadValidation(path.join(dir, "validation.json"))).toEqual({ status: "missing" });
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{}");
    expect((await loadValidation(bad)).status).toBe("invalid");
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ method_version: "1.0", regions: {} }));
    expect(await loadValidation(good)).toEqual({
      status: "ok",
      data: { method_version: "1.0", regions: {} },
      mock: false,
    });
  });
});

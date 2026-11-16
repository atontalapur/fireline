import { afterEach, describe, expect, it, vi } from "vitest";

type VertexOpts = { project: string; location: string };
const createVertex = vi.fn((opts: VertexOpts) => (id: string) => ({ modelId: id, opts }));
vi.mock("@ai-sdk/google-vertex", () => ({ createVertex }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  createVertex.mockClear();
});

describe("getChatModel", () => {
  it("returns null without a Google Cloud project", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    const { getChatModel } = await import("./model");
    expect(getChatModel()).toBeNull();
  });

  it("uses the global Gemini endpoint by default, not the Cloud Run region", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "p");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
    vi.stubEnv("GEMINI_LOCATION", "");
    vi.stubEnv("GEMINI_MODEL", "");
    const { getChatModel } = await import("./model");
    expect(getChatModel()).toMatchObject({ modelId: "gemini-3.5-flash" });
    expect(createVertex).toHaveBeenCalledWith({ project: "p", location: "global" });
  });

  it("honours GEMINI_LOCATION and GEMINI_MODEL", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "p");
    vi.stubEnv("GEMINI_LOCATION", "us-east5");
    vi.stubEnv("GEMINI_MODEL", "gemini-x");
    const { getChatModel } = await import("./model");
    expect(getChatModel()).toMatchObject({ modelId: "gemini-x" });
    expect(createVertex).toHaveBeenCalledWith({ project: "p", location: "us-east5" });
  });
});

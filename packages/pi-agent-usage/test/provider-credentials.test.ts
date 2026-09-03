import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectActiveProvider, fetchCodexQuota, resolveApiKey } from "../src/provider.ts";

function registry(methods: Partial<ModelRegistry>): ModelRegistry {
  return methods as ModelRegistry;
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model registry credential access", () => {
  it("detects configured auth through the extension context registry", async () => {
    const getProviderAuth = vi.fn().mockResolvedValue({
      auth: { apiKey: "resolved" },
      source: "OAuth",
    });
    const model = {
      provider: "openai-codex",
      id: "codex-model",
      baseUrl: "https://example.invalid",
      api: "openai-codex-responses",
    } as Model<Api>;

    await expect(detectActiveProvider(registry({ getProviderAuth }), model)).resolves.toMatchObject(
      {
        provider: "openai-codex",
        hasKey: true,
      },
    );
    expect(getProviderAuth).toHaveBeenCalledWith("openai-codex");
  });

  it("resolves the request-time key instead of constructing internal AuthStorage", async () => {
    const getApiKeyForProvider = vi.fn().mockResolvedValue("fresh-access-token");

    await expect(resolveApiKey(registry({ getApiKeyForProvider }), "openai-codex")).resolves.toBe(
      "fresh-access-token",
    );
    expect(getApiKeyForProvider).toHaveBeenCalledWith("openai-codex");
  });

  it("uses the account claim from the freshly resolved Codex token", async () => {
    const accessToken = jwt({
      "https://api.openai.com/auth.chatgpt_account_id": "account-from-fresh-token",
    });
    const getApiKeyForProvider = vi.fn().mockResolvedValue(accessToken);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 12, reset_at: 1_800_000_000 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCodexQuota(registry({ getApiKeyForProvider }));

    expect(result?.quota?.session5h?.usedPct).toBe(12);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": "account-from-fresh-token",
    });
  });
});

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectActiveProvider,
  fetchCodexQuota,
  parseCodexQuota,
  resolveApiKey,
} from "../src/provider.ts";

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

  it("recognizes a weekly-only Pro quota reported in the primary REST window", async () => {
    const getApiKeyForProvider = vi.fn().mockResolvedValue("fresh-access-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 37,
                reset_at: 1_800_000_000,
                limit_window_seconds: 604_800,
              },
              secondary_window: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await fetchCodexQuota(registry({ getApiKeyForProvider }));

    expect(result?.quota?.session5h).toBeUndefined();
    expect(result?.quota?.weekly).toEqual({ usedPct: 37, resetMs: 1_800_000_000_000 });
  });
});

describe("Codex quota response headers", () => {
  it("classifies windows by duration rather than primary/secondary position", () => {
    const quota = parseCodexQuota({
      "x-codex-primary-used-percent": "71",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1800000000",
      "x-codex-secondary-used-percent": "23",
      "x-codex-secondary-window-minutes": "300",
      "x-codex-secondary-reset-at": "1799500000",
    });

    expect(quota?.session5h).toEqual({ usedPct: 23, resetMs: 1_799_500_000_000 });
    expect(quota?.weekly).toEqual({ usedPct: 71, resetMs: 1_800_000_000_000 });
  });
});

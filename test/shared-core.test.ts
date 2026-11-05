/**
 * Proof that this package **consumes** `@trackcore/sdk` rather than forking it.
 *
 * The brief is explicit: the transport, retry policy, error mapping, decimal
 * parser and credential handling must not be forked, because a second copy of
 * the decimal parser is how this product fails quietly eighteen months from
 * now. Comments saying so are not evidence. Object identity is.
 *
 * Every assertion below compares what this package exports against what the
 * JavaScript SDK exports with `toBe` — reference equality. A vendored copy, a
 * re-declared class, a duplicated constant or a second module instance pulled
 * in through a different resolution path all fail it.
 */

import * as rn from "../src";
import * as js from "@trackcore/sdk";

describe("the numeric contract is one implementation, not two", () => {
  it("exports the same Decimal class object", () => {
    expect(rn.Decimal).toBe(js.Decimal);
  });

  it("exports the same lexeme-preserving parser function", () => {
    expect(rn.parseJson).toBe(js.parseJson);
    expect(rn.parseStrict).toBe(js.parseStrict);
  });

  it("a Decimal built here is instanceof the JavaScript SDK's Decimal", () => {
    const value = new rn.Decimal("138.000");
    expect(value).toBeInstanceOf(js.Decimal);
    expect(value.source).toBe("138.000");
  });

  it("reports which parser path is live rather than assuming one", () => {
    expect(typeof rn.hasNativeSourceAccess).toBe("boolean");
    expect(rn.hasNativeSourceAccess).toBe(js.hasNativeSourceAccess);
  });
});

describe("transport, retry and errors are one implementation", () => {
  it("exports the same Transport class", () => {
    expect(rn.Transport).toBe(js.Transport);
  });

  it("exports the same retry policy object and decision function", () => {
    expect(rn.DEFAULT_RETRY_POLICY).toBe(js.DEFAULT_RETRY_POLICY);
    expect(rn.decideRetry).toBe(js.decideRetry);
    expect(rn.backoffDelay).toBe(js.backoffDelay);
    expect(rn.parseRetryAfter).toBe(js.parseRetryAfter);
  });

  it("exports the same error classes, so instanceof works across packages", () => {
    const classes = [
      "TrackCoreError",
      "TrackCoreAPIError",
      "TrackCoreClientError",
      "RequestError",
      "AuthenticationError",
      "AuthorizationError",
      "ResourceError",
      "RateLimitError",
      "ServerError",
      "DependencyError",
      "MaintenanceError",
      "ConfigurationError",
      "ConnectionError",
      "TimeoutError",
      "AbortError",
      "ProtocolError",
      "ValidationError",
    ] as const;
    for (const name of classes) {
      expect(rn[name]).toBe(js[name]);
    }
  });

  it("exports the same closed error-code enumeration", () => {
    expect(rn.ERROR_CODES).toBe(js.ERROR_CODES);
    expect(rn.ALL_ERROR_CODES).toBe(js.ALL_ERROR_CODES);
    expect(rn.isErrorCode).toBe(js.isErrorCode);
  });

  it("the enumeration is the contract's 37 codes, and this package added none", () => {
    expect(rn.ALL_ERROR_CODES).toHaveLength(37);
    expect([...rn.ALL_ERROR_CODES]).toEqual([...js.ALL_ERROR_CODES]);
  });

  it("exports the same resource functions and published limits", () => {
    expect(rn.searchFoods).toBe(js.searchFoods);
    expect(rn.getFood).toBe(js.getFood);
    expect(rn.batchFoods).toBe(js.batchFoods);
    expect(rn.BATCH_MAX_IDS).toBe(100);
    expect(rn.BATCH_MAX_IDS).toBe(js.BATCH_MAX_IDS);
  });

  it("exports the same credential parser", () => {
    expect(rn.parseApiKey).toBe(js.parseApiKey);
  });

  it("exports the same in-memory ETag store", () => {
    expect(rn.MemoryResponseCache).toBe(js.MemoryResponseCache);
  });

  it("exports the same end-user identity rules (D-012)", () => {
    // `setUser` is a member on `TrackCoreClient`, but the rules behind it are
    // not this package's. Three SDKs each enforcing "the same" validation from
    // three sources is how they stop being the same; one function object
    // shared by two of them is how they cannot.
    expect(rn.assertValidExternalId).toBe(js.assertValidExternalId);
    expect(rn.EXTERNAL_ID_HEADER).toBe(js.EXTERNAL_ID_HEADER);
    expect(rn.EXTERNAL_ID_MAX_CODE_POINTS).toBe(js.EXTERNAL_ID_MAX_CODE_POINTS);
  });

  it("adds no ConfigurationError reason of its own", () => {
    // A reason this package invented would be one a customer could branch on
    // here and not in the web SDK. `ConfigurationError` is shared by identity,
    // so the proof is that the thrown object is the shared class.
    let thrown: unknown;
    try {
      rn.assertValidExternalId(" padded");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(js.ConfigurationError);
    expect((thrown as InstanceType<typeof js.ConfigurationError>).reason).toBe(
      "external_id_untrimmed",
    );
  });
});

describe("the retry policy was not quietly relaxed for a device", () => {
  const context = {
    policy: rn.DEFAULT_RETRY_POLICY,
    method: "GET",
    hasIdempotencyKey: false,
    remainingMs: 30_000,
    random: () => 0.5,
  };

  it("never blindly retries a 502 — one retry, then stop", () => {
    // A malformed-parameter 502 is indistinguishable from an outage and can
    // never succeed on retry, so it is capped separately from the ceiling.
    const first = rn.decideRetry(
      { kind: "response", status: 502, retryAfterSeconds: null },
      { ...context, attempt: 1 },
    );
    expect(first.retry).toBe(true);

    const second = rn.decideRetry(
      { kind: "response", status: 502, retryAfterSeconds: null },
      { ...context, attempt: 2 },
    );
    expect(second.retry).toBe(false);
    expect(second.reason).toContain("502");
  });

  it.each([
    ["a connect failure", { kind: "connection" as const }],
    ["a timeout", { kind: "timeout" as const }],
    ["429", { kind: "response" as const, status: 429, retryAfterSeconds: null }],
    ["503", { kind: "response" as const, status: 503, retryAfterSeconds: null }],
    ["504", { kind: "response" as const, status: 504, retryAfterSeconds: null }],
  ])("gives %s the full budget", (_label, outcome) => {
    expect(rn.decideRetry(outcome, { ...context, attempt: 1 }).retry).toBe(true);
    expect(rn.decideRetry(outcome, { ...context, attempt: 2 }).retry).toBe(true);
    expect(rn.decideRetry(outcome, { ...context, attempt: 3 }).retry).toBe(false);
  });

  it("does not retry a 500, a 400 or a 404", () => {
    for (const status of [400, 404, 410, 500]) {
      const decision = rn.decideRetry(
        { kind: "response", status, retryAfterSeconds: null },
        { ...context, attempt: 1 },
      );
      expect(decision.retry).toBe(false);
    }
  });

  it("honours Retry-After over exponential backoff", () => {
    const decision = rn.decideRetry(
      { kind: "response", status: 429, retryAfterSeconds: 7 },
      { ...context, attempt: 1 },
    );
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(7000);
  });
});

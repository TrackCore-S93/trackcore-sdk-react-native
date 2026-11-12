/**
 * `TrackCore.instance` on a device: configure once, initialize mints the
 * session with the publishable key, calls carry it, expiry is renewed inside.
 */

import { TrackCore, ConfigurationError } from "../src";

const PUBLISHABLE = `tc_pk_live_${"B".repeat(43)}`;
const SECRET = `tc_sk_live_${"7kQ2mF4xT9bR3vN8pL5wC1yH6zJ0dG7sA4eU2iO9kM3"}`;

function session(token: string): string {
  return `{"session_token":"${token}","external_id":"user_42","expires_at":"2026-11-13T06:00:00Z","issued_at":"2026-11-12T06:00:00Z","ttl_seconds":86400,"environment":"live","token_type":"opaque"}`;
}
const DAY = '{"app_user":"user_42","local_date":"2026-11-12","timezone":"UTC","entries":0,"consumed":{},"goal_snapshot":null,"remaining":null,"partial_sum":false,"water":{"recorded":null,"target":null,"remaining":null,"unit":"ml"},"steps":{"recorded":null,"target":null,"remaining":null,"unit":"count"},"weight_kg":null,"environment":"live"}';
const EXPIRED = '{"error":{"code":"session_expired","message":"The end-user session token has expired.","request_id":"req_x","docs_url":"https://docs.trackcore.dev/errors/session_expired"}}';

interface Sent { path: string; headers: Headers; body: string | null }

function fetchStub(answer: (s: Sent) => { status: number; body: string }): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const record = { path: url.pathname, headers: new Headers(init?.headers as HeadersInit), body: init?.body === undefined ? null : String(init?.body) };
    sent.push(record);
    const { status, body } = answer(record);
    return new Response(body, { status, headers: { "Content-Type": "application/json", "X-Request-Id": "req_test" } });
  }) as typeof fetch;
  return { fetch: f, sent };
}

describe("TrackCore.instance", () => {
  it("is one object and refuses a secret key", () => {
    expect(TrackCore.instance).toBe(TrackCore.instance);
    expect(() => TrackCore.instance.configure({ apiKey: SECRET, baseUrl: "http://api.test" })).toThrow(ConfigurationError);
  });

  it("initialize mints with the publishable key, calls carry the token, expiry is renewed", async () => {
    let minted = 0;
    const { fetch, sent } = fetchStub((s) => {
      if (s.path === "/v1/auth/session") return { status: 201, body: session(`tc_st_${++minted}`) };
      return s.headers.get("X-TrackCore-Session") === "tc_st_1" ? { status: 401, body: EXPIRED } : { status: 200, body: DAY };
    });
    TrackCore.instance.configure({ apiKey: PUBLISHABLE, baseUrl: "http://api.test", fetch });
    expect(() => TrackCore.instance.diary).toThrow(ConfigurationError);

    await TrackCore.instance.initialize("user_42");
    expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${PUBLISHABLE}`);
    expect(sent[0]!.body).toBe('{"external_id":"user_42","ttl_seconds":86400}');

    const day = await TrackCore.instance.diary.day({ date: "2026-11-12" });
    expect(day.local_date).toBe("2026-11-12");
    expect(sent.map((s) => s.path)).toEqual(["/v1/auth/session", "/v1/diary/day", "/v1/auth/session", "/v1/diary/day"]);
    expect(sent[3]!.headers.get("X-TrackCore-Session")).toBe("tc_st_2");
    expect(sent[3]!.headers.get("X-External-Id")).toBeNull();

    TrackCore.instance.signOut();
    expect(TrackCore.instance.isInitialized).toBe(false);
    expect(() => TrackCore.instance.diary).toThrow(ConfigurationError);
  });
});

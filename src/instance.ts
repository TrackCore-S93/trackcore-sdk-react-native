/**
 * `TrackCore.instance` — one client for the whole app, held by the SDK.
 *
 * ```ts
 * TrackCore.instance.configure({ apiKey: "tc_pk_live_…", baseUrl: "…" });   // once, at start
 * await TrackCore.instance.initialize(user.id);                             // on sign-in
 * await TrackCore.instance.diary.log({ … });                                // anywhere
 * TrackCore.instance.signOut();                                             // on sign-out
 * ```
 *
 * `initialize` names the user once: the SDK mints the session with the
 * publishable key, and renews it when the server answers `session_expired`,
 * so the app never handles a token. The namespaces are the configured
 * {@link TrackCoreClient}'s.
 */

import { ConfigurationError, assertValidExternalId, createSession, type ProbeOk } from "@trackcore/sdk";

import { createTrackCoreClient, TrackCoreClient, type TrackCoreClientOptions } from "./client";

/** What `configure` takes: the client options, with the key and the base URL required. */
export interface ConfigureOptions extends TrackCoreClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** How long a minted session lives, in seconds. Default and maximum 86400. */
  readonly sessionTtlSeconds?: number | undefined;
}

export class TrackCoreInstance {
  private held: TrackCoreClient | null = null;
  private user: string | null = null;
  private ttlSeconds = 86_400;

  /** Creates the client. Calling it again replaces the client and signs out. */
  configure(options: ConfigureOptions): void {
    this.held = createTrackCoreClient(options);
    this.user = null;
    this.ttlSeconds = options.sessionTtlSeconds ?? 86_400;
  }

  get isConfigured(): boolean {
    return this.held !== null;
  }

  get isInitialized(): boolean {
    return this.user !== null;
  }

  /** The user `initialize` was given, or `null`. */
  get externalId(): string | null {
    return this.user;
  }

  /**
   * Names the user after your own sign-in: a uid, an email, any stable id.
   * Mints the session and installs the renewer.
   */
  async initialize(externalId: string): Promise<void> {
    const client = this.configured();
    assertValidExternalId(externalId);
    const session = await createSession(client, { externalId, ttlSeconds: this.ttlSeconds });
    client.setSession(session.session_token);
    this.user = externalId;
    client.transport.setSessionRenewer(async () => {
      if (this.user !== externalId) return null;
      const renewed = await createSession(client, { externalId, ttlSeconds: this.ttlSeconds });
      return renewed.session_token;
    });
  }

  /** Forgets the user. The client stays configured. */
  signOut(): void {
    const client = this.held;
    if (client === null) return;
    client.transport.setSessionRenewer(null);
    client.clearSession();
    this.user = null;
  }

  /** The configured client, for anything the namespaces below do not cover. */
  get client(): TrackCoreClient {
    return this.configured();
  }

  get foods(): TrackCoreClient["foods"] {
    return this.configured().foods;
  }
  get barcode(): TrackCoreClient["barcode"] {
    return this.configured().barcode;
  }
  get diary(): TrackCoreClient["diary"] {
    return this.scoped().diary;
  }
  get profile(): TrackCoreClient["profile"] {
    return this.scoped().profile;
  }
  get healthData(): TrackCoreClient["healthData"] {
    return this.scoped().healthData;
  }
  get nutrition(): TrackCoreClient["nutrition"] {
    return this.configured().nutrition;
  }
  get label(): TrackCoreClient["label"] {
    return this.configured().label;
  }
  get image(): TrackCoreClient["image"] {
    return this.configured().image;
  }
  get nlp(): TrackCoreClient["nlp"] {
    return this.configured().nlp;
  }
  get capabilities(): TrackCoreClient["capabilities"] {
    return this.configured().capabilities;
  }

  /** `GET /healthz`. */
  health(options?: { signal?: AbortSignal | undefined }): Promise<ProbeOk> {
    return this.configured().health(options);
  }

  private configured(): TrackCoreClient {
    if (this.held === null) {
      throw new ConfigurationError("not_configured", "Call TrackCore.instance.configure({ apiKey, baseUrl }) before using the SDK.");
    }
    return this.held;
  }

  private scoped(): TrackCoreClient {
    const client = this.configured();
    if (this.user === null) {
      throw new ConfigurationError("not_initialized", "Call await TrackCore.instance.initialize(userId) after sign-in before reading or writing a user's data.");
    }
    return client;
  }
}

let shared: TrackCoreInstance | undefined;

/**
 * The holder of the singleton. This is not the JavaScript SDK's `TrackCore`
 * client class: it has no constructor and cannot be given a secret key.
 */
export class TrackCore {
  static get instance(): TrackCoreInstance {
    return (shared ??= new TrackCoreInstance());
  }

  private constructor() {}
}

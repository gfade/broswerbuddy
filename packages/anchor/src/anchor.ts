import {
  createAnchorbrowserClient,
  NotFoundError,
  Sessions,
  type Client,
  type SessionCreateRequestSchema,
} from 'anchorbrowser';
import { chromium, type Browser } from 'playwright-core';
import { createLogger, errorMessage } from '@healops/shared';
import { VIEWPORT, redact, withTimeout } from './common.js';

const log = createLogger('anchor');

/** Idle and max lifetime of a session. A session we fail to end stops on its own after this. */
const SESSION_MINUTES = 5;
const CREATE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 15_000;

export interface AnchorSession {
  id: string;
  /** CDP websocket for chromium.connectOverCDP. */
  cdpUrl: string;
  liveViewUrl?: string;
}

/** Thin wrapper over the Anchor SDK, tracking the sessions this runner has open. */
export class AnchorSessions {
  private readonly client: Client;
  private readonly apiKey: string;
  private readonly open = new Set<string>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = createAnchorbrowserClient({ auth: apiKey });
  }

  redact(text: string): string {
    return redact(text, [this.apiKey]);
  }

  /** Starts a headful, recorded session with a short idle and max lifetime. */
  async createSession(tags: string[]): Promise<AnchorSession> {
    const body: SessionCreateRequestSchema = {
      session: {
        tags,
        // Recording stays on (the API default) so the session can be fetched by id later. No recording
        // link is read here: the API answers 404 for a long time after short sessions.
        recording: { active: true },
        timeout: { max_duration: SESSION_MINUTES, idle_timeout: SESSION_MINUTES },
      },
      browser: { headless: { active: false }, viewport: { width: VIEWPORT.width, height: VIEWPORT.height } },
    };
    const created = await withTimeout(
      Sessions.createSession({ client: this.client, body }),
      CREATE_TIMEOUT_MS,
      'Anchor session create',
      (late) => {
        // The create call finished after we gave up on it: end the session it made.
        if (late.data?.id) void this.endSession(late.data.id);
      },
    );
    const id = created.data?.id;
    if (!id) throw new Error('Anchor returned no session id');
    this.open.add(id);
    const cdpUrl = created.data?.cdp_url;
    if (!cdpUrl) {
      await this.endSession(id);
      throw new Error('Anchor returned no CDP URL');
    }
    return { id, cdpUrl, liveViewUrl: created.data?.live_view_url };
  }

  connect(cdpUrl: string): Promise<Browser> {
    return chromium.connectOverCDP(cdpUrl, { timeout: CONNECT_TIMEOUT_MS });
  }

  /** Ends a session. Never throws: a failure is logged and the session stays tracked for closeAll(). */
  async endSession(id: string): Promise<void> {
    try {
      await withTimeout(
        Sessions.deleteSession({ client: this.client, path: { session_id: id } }),
        DELETE_TIMEOUT_MS,
        'Anchor session delete',
      );
      this.open.delete(id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        this.open.delete(id);
        return;
      }
      log.warn(`could not end session ${id}: ${this.redact(errorMessage(err))}`);
    }
  }

  /** Ends every session this runner still tracks. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.open].map((id) => this.endSession(id)));
  }
}

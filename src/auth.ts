import { createHash, timingSafeEqual } from "node:crypto";
import { errors } from "./cse/errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** API-key check with Google's error bodies: no key → 403, unknown key → 400 API_KEY_INVALID. */
export class KeyChecker {
  private readonly digests: Buffer[];

  constructor(keys: readonly string[]) {
    this.digests = keys.map(digest);
  }

  get enabled(): boolean {
    return this.digests.length > 0;
  }

  /** Returns the key the quota is charged to (the empty string when keys are disabled). */
  check(key: string | undefined): string {
    if (!this.enabled) return "";
    if (key === undefined || key === "") throw errors.missingKey();
    const candidate = digest(key);
    // Compare against every key so the time taken does not reveal which one matched.
    const ok = this.digests.reduce((found, d) => timingSafeEqual(d, candidate) || found, false);
    if (!ok) throw errors.invalidKey();
    return key;
  }
}

/** The calendar day in Google's quota time zone. */
function pacificDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

/** In-memory "Queries per day" counter per key, reset at midnight Pacific time like Google's quota. */
export class DailyQuota {
  private day = "";
  private readonly used = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Takes one query from the key's allowance for today, or throws Google's 429 when none is left.
   * `refund()` gives it back (for searches the backend failed to answer); it does nothing after midnight.
   */
  reserve(key: string): { refund: () => void } {
    if (this.limit === 0) return { refund: () => undefined };
    const used = this.usedToday(key);
    if (used >= this.limit) throw errors.dailyQuota(this.limit);
    this.used.set(key, used + 1);
    const day = this.day;
    let refunded = false;
    return {
      refund: () => {
        if (refunded || pacificDay(this.now()) !== day) return;
        refunded = true;
        this.used.set(key, Math.max(0, this.usedToday(key) - 1));
      },
    };
  }

  private usedToday(key: string): number {
    const today = pacificDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
    return this.used.get(key) ?? 0;
  }
}

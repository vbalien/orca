// Whether the bot has joined a thread a channel message opened (a `:c` chat): it posted there, or
// someone's @mention of it there was taken. Until then the thread's replies are channel messages and its
// failure and "needs an answer in Orca" notices stay off Slack. Remembered per bot in a small private
// file (only conversation ids); losing an entry only makes the next reply a channel message again (a
// miss, never an intrusion), and posts are found again by reading the thread.
import * as z from 'zod'
import { BotStateFile } from '../bots/slack-gate/bot-state-file'

const FOLDER = 'slack-local-participation'
const KEPT = 20_000

const ParticipationFile = z.object({ v: z.literal(1), threads: z.array(z.string()) })

export class SlackLocalParticipation {
  private readonly threads = new Map<string, true>()
  // Posted or not, as the thread's own messages said; dropped once we post.
  private readonly seenInSlack = new Map<string, boolean>()
  private readonly file: BotStateFile
  private loading: Promise<void> | null = null
  // Forgotten for good: a late post or mention never writes it again (a new record takes over).
  private closed = false
  // @mentions on their way into a not-yet-joined thread's chat, and the notices waiting on them.
  private readonly mentions = new Map<string, { inFlight: number; waiting: (() => void)[] }>()

  constructor(
    botId: string,
    /** Whether a conversation still has its chat link (an entry without one is dropped). */
    private readonly linked: (externalId: string) => boolean,
    /** An earlier record of the same bot still being removed: this one reads and writes after it. */
    private readonly after: Promise<unknown> = Promise.resolve()
  ) {
    this.file = new BotStateFile(FOLDER, botId)
  }

  /** Reads the file once; an unreadable one starts empty (Slack reads then recover posts). */
  load(): Promise<void> {
    this.loading ??= this.after
      .catch(() => undefined)
      .then(() => this.file.read())
      .then((read) => {
        const parsed = read.kind === 'ok' ? ParticipationFile.safeParse(read.value) : null
        // What the file kept comes first, then what was joined since this record began (newest
        // last), within the cap.
        const joined = [...this.threads.keys()]
        this.threads.clear()
        for (const id of parsed?.success ? parsed.data.threads : []) {
          if (this.linked(id)) {
            this.threads.set(id, true)
          }
        }
        for (const id of joined) {
          this.threads.delete(id)
          this.threads.set(id, true)
        }
        this.trim()
      })
    return this.loading
  }

  has(externalId: string): boolean {
    return this.threads.has(externalId) || this.seenInSlack.get(externalId) === true
  }

  /** What a Slack read found: undefined when no read said yet. */
  slackSaid(externalId: string): boolean | undefined {
    return this.seenInSlack.get(externalId)
  }

  rememberSlack(externalId: string, posted: boolean): void {
    if (this.seenInSlack.size >= 4_000) {
      this.seenInSlack.clear()
    }
    if (this.closed) {
      return
    }
    this.seenInSlack.set(externalId, posted)
    if (posted) {
      this.add(externalId)
    }
  }

  /** The bot posted there, or an @mention of it there was taken. */
  add(externalId: string): void {
    if (this.closed || this.threads.has(externalId)) {
      return
    }
    this.threads.delete(externalId)
    this.threads.set(externalId, true)
    this.trim()
    this.seenInSlack.delete(externalId)
    this.save()
  }

  // One write for any number of adds before it starts (it writes them all), once the file was read,
  // so what an earlier run recorded is kept.
  private saving = false
  private save(): void {
    if (this.saving) {
      return
    }
    this.saving = true
    void this.load().then(() => {
      this.saving = false
      return this.file.write(() => ({ v: 1, threads: [...this.threads.keys()] }))
    })
  }

  /** Drops the oldest threads past the cap. */
  private trim(): void {
    while (this.threads.size > KEPT) {
      const oldest = this.threads.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.threads.delete(oldest)
    }
  }

  /** An @mention is being delivered into a thread the bot hasn't joined: notices that come meanwhile
   *  wait for it. Returns its end: taken (accepted or unknown) joins the thread and lets them post. */
  mentionStarted(externalId: string): (taken: boolean) => void {
    const held = this.mentions.get(externalId) ?? { inFlight: 0, waiting: [] }
    held.inFlight++
    this.mentions.set(externalId, held)
    let ended = false
    return (taken) => {
      if (ended) {
        return
      }
      ended = true
      if (taken) {
        this.add(externalId)
      }
      held.inFlight--
      if (taken || held.inFlight === 0) {
        const waiting = held.waiting.splice(0)
        if (held.inFlight === 0) {
          this.mentions.delete(externalId)
        }
        if (this.has(externalId)) {
          waiting.forEach((post) => post())
        }
      }
    }
  }

  /** Holds a notice while an @mention into this thread is on its way; false when none is. */
  deferWhileMention(externalId: string, post: () => void): boolean {
    const held = this.mentions.get(externalId)
    if (!held) {
      return false
    }
    held.waiting.push(post)
    return true
  }

  /** The bot stopped using its own app (or is gone): what it joined is forgotten, and this record is
   *  closed for good at once; the file goes after `after` (an earlier removal) is done.
   *  SlackLocalParticipations makes a new record if it comes back. */
  async forget(after: Promise<unknown> = Promise.resolve()): Promise<void> {
    this.closed = true
    this.threads.clear()
    this.seenInSlack.clear()
    this.loading = Promise.resolve()
    await after.catch(() => undefined)
    await this.file.remove()
  }
}

/** Each bot's record, one per bot across reconnects. */
export class SlackLocalParticipations {
  private readonly bots = new Map<string, SlackLocalParticipation>()
  // A forgotten record's removal, which the bot's next record waits for.
  private readonly removing = new Map<string, Promise<void>>()

  constructor(private readonly linked: (externalId: string) => boolean) {}

  of(botId: string): SlackLocalParticipation {
    let kept = this.bots.get(botId)
    if (!kept) {
      kept = new SlackLocalParticipation(botId, this.linked, this.removing.get(botId))
      this.bots.set(botId, kept)
    }
    return kept
  }

  /** Off its own app or deleted: which channel-message threads it joined no longer matters. */
  forget(botId: string): void {
    // After any removal still under way, so the last one done is always the latest.
    const removal = this.of(botId).forget(this.removing.get(botId))
    this.bots.delete(botId)
    this.removing.set(botId, removal)
    void removal.finally(() => {
      if (this.removing.get(botId) === removal) {
        this.removing.delete(botId)
      }
    })
  }
}

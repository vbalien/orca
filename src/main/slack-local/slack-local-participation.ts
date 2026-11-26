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
  private file: BotStateFile
  private loading: Promise<void> | null = null
  // @mentions on their way into a not-yet-joined thread's chat, and the notices waiting on them.
  private readonly mentions = new Map<string, { inFlight: number; waiting: (() => void)[] }>()

  constructor(
    private readonly botId: string,
    /** Whether a conversation still has its chat link (an entry without one is dropped). */
    private readonly linked: (externalId: string) => boolean
  ) {
    this.file = new BotStateFile(FOLDER, botId)
  }

  /** Reads the file once; an unreadable one starts empty (Slack reads then recover posts). */
  load(): Promise<void> {
    this.loading ??= this.file.read().then((read) => {
      const parsed = read.kind === 'ok' ? ParticipationFile.safeParse(read.value) : null
      for (const id of parsed?.success ? parsed.data.threads : []) {
        if (this.linked(id)) {
          this.threads.set(id, true)
        }
      }
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
    this.seenInSlack.set(externalId, posted)
    if (posted) {
      this.add(externalId)
    }
  }

  /** The bot posted there, or an @mention of it there was taken. */
  add(externalId: string): void {
    if (this.threads.has(externalId)) {
      return
    }
    this.threads.delete(externalId)
    this.threads.set(externalId, true)
    while (this.threads.size > KEPT) {
      const oldest = this.threads.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.threads.delete(oldest)
    }
    this.seenInSlack.delete(externalId)
    void this.file.write(() => ({ v: 1, threads: [...this.threads.keys()] }))
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

  /** The bot stopped using its own app (or is gone): what it joined is forgotten. */
  async forget(): Promise<void> {
    this.threads.clear()
    this.seenInSlack.clear()
    await this.file.remove()
    this.file = new BotStateFile(FOLDER, this.botId)
    this.loading = Promise.resolve()
  }
}

/** Each bot's record, one per bot across reconnects. */
export class SlackLocalParticipations {
  private readonly bots = new Map<string, SlackLocalParticipation>()

  constructor(private readonly linked: (externalId: string) => boolean) {}

  of(botId: string): SlackLocalParticipation {
    let kept = this.bots.get(botId)
    if (!kept) {
      kept = new SlackLocalParticipation(botId, this.linked)
      this.bots.set(botId, kept)
    }
    return kept
  }

  /** Off its own app or deleted: which channel-message threads it joined no longer matters. */
  forget(botId: string): void {
    void this.of(botId).forget()
    this.bots.delete(botId)
  }
}

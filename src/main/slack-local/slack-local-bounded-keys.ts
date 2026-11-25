/** Keys seen lately, oldest forgotten first once full. */
export class BoundedKeys {
  private readonly keys = new Set<string>()

  constructor(private readonly limit: number) {}

  /** False when it was already there. */
  add(key: string): boolean {
    if (this.keys.has(key)) {
      return false
    }
    this.keys.add(key)
    if (this.keys.size > this.limit) {
      const oldest = this.keys.values().next().value
      if (oldest !== undefined) {
        this.keys.delete(oldest)
      }
    }
    return true
  }
}

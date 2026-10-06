import type { KVStore } from '../../src/rehearsal/journal'

export class MemoryStorage implements KVStore {
  private map = new Map<string, string>()
  private failOnce = false
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) {
    if (this.failOnce) {
      this.failOnce = false
      this.map.set(key, value.slice(0, Math.max(8, Math.floor(value.length / 2))))
      return
    }
    this.map.set(key, value)
  }
  failNextWrite() { this.failOnce = true }
  get raw() { return this.map }
}
